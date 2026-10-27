import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { withOrg } from "@rootset/database";
import {
  newId,
  getOperation,
  RootsetError,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";
import { TableStorage, type TableRecord } from "@rootset/table-storage";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  JobsService as BaseJobsService,
  LeaseLost,
  type JobsConfig,
  type OperationContext,
} from "./index.js";
import { MetadataPaging } from "../../core/src/paging.js";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { stableStringify } from "./types.js";
import { runMutation } from "@rootset/idempotency";
import { fromBuffer } from "yauzl";

if (!process.env.ROOTSET_TEST_DATABASE_URL)
  throw new Error(
    "Real PostgreSQL fixture required: set ROOTSET_TEST_DATABASE_URL and S3 variables",
  );
class JobsService extends BaseJobsService {
  override execute(
    operation: string,
    a: Actor,
    input: Record<string, unknown>,
    context: OperationContext = {},
  ) {
    return super.execute(operation, a, input, {
      idempotencyKey: newId(),
      ...context,
    });
  }
}
const fixture = await isolatedDatabase();
const owner = fixture.owner;
const pool = fixture.app;
const ddlPool = fixture.ddl;
const storage = new TableStorage({
  pool,
  ddlPool,
  cursorSecret: randomBytes(32).toString("hex"),
});
const actor: Actor = {
  kind: "session",
  id: newId(),
  userId: newId(),
  orgId: newId(),
  role: "admin",
  scopes: [],
  membershipVersion: 1,
};
let currentAccess = true;
let hook: ((point: string, jobId: string) => Promise<void>) | null = null;
const config: JobsConfig = {
  idempotencySecret: randomBytes(32).toString("hex"),
  metadataPaging: new MetadataPaging(randomBytes(32).toString("hex")),
  artifacts: {
    endpoint: process.env.ROOTSET_S3_ENDPOINT,
    region: "us-east-1",
    bucket: process.env.ROOTSET_S3_BUCKET!,
    accessKeyId: process.env.ROOTSET_S3_ACCESS_KEY!,
    secretAccessKey: process.env.ROOTSET_S3_SECRET_KEY!,
    encryptionKey:
      process.env.ROOTSET_ENCRYPTION_KEY ?? randomBytes(32).toString("base64"),
  },
  failpoint: async (point, jobId) => {
    await hook?.(point, jobId);
  },
};
const jobs = new JobsService({
  pool,
  ddlPool,
  storage,
  config,
  authorise: async (a) => {
    if (!currentAccess)
      throw new RootsetError("ACCESS_DENIED", "Access revoked", 403);
    return a;
  },
});
let table: TableRecord;

async function terminal(id: string, service = jobs) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await service.runOnce(actor.orgId);
    const result = (await service.execute("getJob", actor, { id })) as {
      state: string;
      stage?: string;
      result?: Record<string, JsonValue>;
      error?: Record<string, JsonValue>;
    };
    if (!["queued", "running"].includes(result.state)) return result;
    if (result.stage === "waiting_recovery") {
      await service.runOnce(actor.orgId);
    }
    await withOrg(ddlPool, actor.orgId, (client) =>
      client.query(
        "UPDATE rootset_control.jobs SET next_attempt_at=now() WHERE id=$1 AND state=$2",
        [id, "queued"],
      ),
    );
  }
  throw new Error(`Job ${id} did not reach a terminal state`);
}

before(async () => {
  await owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [actor.orgId, `Jobs integration ${actor.orgId}`],
  );
  const database = await storage.createDatabase(actor, {
    name: `Jobs data ${newId()}`,
  });

  table = await storage.createTable(actor, database.id, {
    name: "Airline codes",
    fields: [
      {
        name: "code",
        type: "text",
        charLimit: 32,
        required: true,
      },
      { name: "name", type: "text", charLimit: 256 },
      { name: "active", type: "boolean" },
      { name: "instant", type: "date-time" },
      { name: "payload", type: "json" },
      { name: "resource", type: "uri" },
      { name: "website", type: "url" },
      { name: "photo", type: "image" },
    ],
    idempotencyKey: newId(),
  });
  await storage.createUniqueRule(actor, table.id, {
    name: "Code",
    fieldIds: [table.fields[0]!.id],
    expectedSchemaVersion: table.schemaVersion,
    idempotencyKey: newId(),
  });
  table = await storage.getTable(actor, table.id);
  for (let index = 1; index <= 3; index++)
    await storage.createRow(
      actor,
      table.id,
      {
        code: String(index).padStart(5, "0"),
        name: index === 1 ? "Name, one" : `Name ${index}`,
        active: true,
        instant: "2026-10-02T01:00:00Z",
        payload: { index },
        resource: `custom:resource ${index}`,
        website: "not a URL",
        photo: `https://example.org/photo-${index}.png`,
      },
      { idempotencyKey: newId() },
    );
});
after(async () => {
  try {
    const artifacts = (
      await owner.query("SELECT * FROM rootset_control.artifacts")
    ).rows;
    for (const artifact of artifacts) {
      assert.ok(
        String(artifact.object_key).startsWith(`rootset/${artifact.org_id}/`),
      );
      await jobs.artifacts.remove(
        { ...actor, orgId: artifact.org_id },
        artifact,
      );
    }
    await withOrg(ddlPool, actor.orgId, async (client) => {
      await client.query(
        "UPDATE rootset_control.jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE state IN ('queued','running')",
      );
    });
    await jobs.runOnce(actor.orgId);
  } finally {
    await fixture.close();
  }
});

test("V1-25: complete-table snapshot export has canonical quoted content and encrypted storage", async () => {
  const started = (await jobs.execute(
    "exportRows",
    actor,
    {
      tableId: table.id,
      format: "csv",
    },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.result?.rowCount, 3);
  const artifact = await jobs.artifacts.get(
    actor,
    String(completed.result?.artifactId),
  );
  const raw = await jobs.artifacts.client.send(
    new GetObjectCommand({
      Bucket: config.artifacts.bucket,
      Key: artifact.object_key,
    }),
  );
  const ciphertext = await raw.Body!.transformToByteArray();
  assert.equal(Buffer.from(ciphertext).includes(Buffer.from("00001")), false);
  const download = await jobs.downloadArtifact(actor, artifact.id);
  let content = "";
  for await (const chunk of download.stream) content += String(chunk);
  assert.ok(
    content.includes(
      "custom:resource 1,not a URL,https://example.org/photo-1.png",
    ),
  );
  assert.ok(
    content.startsWith(
      "code,name,active,instant,payload,resource,website,photo\n",
    ),
  );
  for (const code of ["00001", "00002", "00003"])
    assert.ok(content.includes(code));
  assert.match(content, /00001,"Name, one",true,2026-10-02T01:00:00.000Z/);
  assert.equal(
    download.checksum,
    createHash("sha256").update(content).digest("hex"),
  );
});

test("JSONL export includes every row and field and exposes its format in request history", async () => {
  const started = (await jobs.execute("exportRows", actor, {
    tableId: table.id,
    format: "jsonl",
  })) as { jobId: string };
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  const download = await jobs.downloadArtifact(
    actor,
    String(completed.result?.artifactId),
  );
  let content = "";
  for await (const chunk of download.stream) content += String(chunk);
  const rows = content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.photo, "https://example.org/photo-1.png");
  for (const row of rows)
    assert.deepEqual(
      Object.keys(row).sort(),
      table.fields.map((field) => field.name).sort(),
    );
  const page = (await jobs.execute("listJobs", actor, {
    kind: "export",
    tableId: table.id,
  })) as { data: { id: string; format?: string }[] };
  assert.equal(
    page.data.find((job) => job.id === started.jobId)?.format,
    "jsonl",
  );
});

test("current-view exports stream a projected filtered snapshot beyond one keyset batch", async () => {
  const database = await storage.createDatabase(actor, {
    name: `View snapshot ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "View data",
    fields: [
      { name: "COUNT", type: "integer" },
      { name: "NOTE", type: "text", charLimit: 100 },
      { name: "ACTIVE", type: "boolean" },
    ],
    idempotencyKey: newId(),
  });
  const created = await storage.mutateRows(actor, target.id, {
    expectedSchemaVersion: target.schemaVersion,
    operations: Array.from({ length: 1000 }, (_, index) => ({
      kind: "create" as const,
      values: {
        COUNT: index,
        NOTE:
          index === 0
            ? null
            : index === 1
              ? ""
              : index === 2
                ? "\\N"
                : `Note ${index}`,
        ACTIVE: false,
      },
    })),
    idempotencyKey: newId(),
  });
  await storage.mutateRows(actor, target.id, {
    expectedSchemaVersion: target.schemaVersion,
    operations: Array.from({ length: 6 }, (_, index) => ({
      kind: "create" as const,
      values: {
        COUNT: 1000 + index,
        NOTE: `Note ${1000 + index}`,
        ACTIVE: index === 5,
      },
    })),
    idempotencyKey: newId(),
  });
  const input = {
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
    format: "jsonl",
    query: {
      select: [target.fields[1]!.id, target.fields[0]!.id],
      where: {
        and: [
          { field: "COUNT", op: "gte", value: 0 },
          { field: "ACTIVE", op: "eq", value: false },
        ],
      },
      orderBy: [{ field: "COUNT", direction: "desc" }],
    },
  };
  const key = newId();
  const [run, replay] = (await Promise.all([
    jobs.execute("exportView", actor, input, { idempotencyKey: key }),
    jobs.execute("exportView", actor, input, { idempotencyKey: key }),
  ])) as { jobId: string }[];
  assert.equal(run!.jobId, replay!.jobId);
  await assert.rejects(
    jobs.execute(
      "exportView",
      actor,
      { ...input, query: { ...input.query, select: ["COUNT"] } },
      { idempotencyKey: key },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  let changed = false;
  hook = async (point, id) => {
    if (point !== "export.afterBatch" || id !== run!.jobId || changed) return;
    changed = true;
    const first = created.rows[0]!;
    await storage.updateRow(
      actor,
      target.id,
      first.id,
      { COUNT: -1, NOTE: "After snapshot" },
      { expectedVersion: first.version, idempotencyKey: newId() },
    );
    await storage.createRow(
      actor,
      target.id,
      { COUNT: 2000, NOTE: "Added after snapshot", ACTIVE: false },
      { idempotencyKey: newId() },
    );
  };
  const completed = await terminal(run!.jobId);
  hook = null;
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  assert.equal(changed, true);
  assert.equal(completed.result?.rowCount, 1005);
  assert.deepEqual(completed.result?.fieldIds, [
    target.fields[1]!.id,
    target.fields[0]!.id,
  ]);
  const download = await jobs.downloadArtifact(
    actor,
    String(completed.result?.artifactId),
  );
  let content = "";
  for await (const chunk of download.stream) content += String(chunk);
  const rows = content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 1005);
  assert.deepEqual(
    rows.map((row) => row.COUNT),
    Array.from({ length: 1005 }, (_, i) => 1004 - i),
  );
  assert.deepEqual(rows.at(-1), { COUNT: 0, NOTE: null });
  assert.deepEqual(rows.at(-2), { COUNT: 1, NOTE: "" });
  assert.deepEqual(rows.at(-3), { COUNT: 2, NOTE: "\\N" });
  assert.ok(
    rows.every((row) => Object.keys(row).sort().join(",") === "COUNT,NOTE"),
  );
  assert.equal(
    download.checksum,
    createHash("sha256").update(content).digest("hex"),
  );
  const csv = (await jobs.execute("exportView", actor, {
    ...input,
    format: "csv",
    query: {
      select: ["NOTE", "COUNT", "ACTIVE"],
      where: { field: "COUNT", op: "lte", value: 2 },
      orderBy: [{ field: "COUNT", direction: "desc" }],
    },
  })) as { jobId: string };
  const csvResult = await terminal(csv.jobId);
  assert.equal(csvResult.state, "succeeded", JSON.stringify(csvResult.error));
  const csvDownload = await jobs.downloadArtifact(
    actor,
    String(csvResult.result?.artifactId),
  );
  let csvContent = "";
  for await (const chunk of csvDownload.stream) csvContent += String(chunk);
  assert.equal(
    csvContent,
    'NOTE,COUNT,ACTIVE\n\\\\N,2,false\n"",1,false\nAfter snapshot,-1,false\n',
  );
  const empty = (await jobs.execute("exportView", actor, {
    ...input,
    format: "csv",
    query: {
      select: ["NOTE"],
      where: { field: "COUNT", op: "eq", value: 99999 },
    },
  })) as { jobId: string };
  const emptyResult = await terminal(empty.jobId);
  assert.equal(emptyResult.result?.rowCount, 0);
  const emptyDownload = await jobs.downloadArtifact(
    actor,
    String(emptyResult.result?.artifactId),
  );
  let emptyContent = "";
  for await (const chunk of emptyDownload.stream) emptyContent += String(chunk);
  assert.equal(emptyContent, "NOTE\n");
  const history = await jobs.execute("getJob", actor, { id: run!.jobId });
  getOperation("getJob").outputSchema.parse(history);
  assert.equal((history as { exportScope: string }).exportScope, "view");
});

test("current-view exports reject stale schemas at admission and snapshot without publishing data", async () => {
  const database = await storage.createDatabase(actor, {
    name: `View schema ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Changing fields",
    fields: [{ name: "VALUE", type: "integer" }],
    idempotencyKey: newId(),
  });
  const input = {
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
    format: "csv",
    query: { select: ["VALUE"] },
  };
  await assert.rejects(
    jobs.execute("exportView", actor, {
      ...input,
      expectedSchemaVersion: target.schemaVersion + 1,
    }),
    (error) =>
      error instanceof RootsetError && error.code === "SCHEMA_VERSION_CONFLICT",
  );
  const run = (await jobs.execute("exportView", actor, input)) as {
    jobId: string;
  };
  await storage.updateField(actor, target.id, target.fields[0]!.id, {
    name: "CHANGED",
    expectedSchemaVersion: target.schemaVersion,
    idempotencyKey: newId(),
  });
  const result = await terminal(run.jobId);
  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "SCHEMA_VERSION_CONFLICT");
  const artifacts = await withOrg(ddlPool, actor.orgId, (c) =>
    c.query(
      "SELECT id FROM rootset_control.artifacts WHERE job_id=$1 AND state='ready'",
      [run.jobId],
    ),
  );
  assert.equal(artifacts.rowCount, 0);
});

async function databaseArchive(artifactId: string) {
  const download = await jobs.downloadArtifact(actor, artifactId);
  const chunks: Buffer[] = [];
  for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
      if (error) {
        reject(error);
        return;
      }
      const files = new Map<string, Buffer>();
      archive.on("error", reject);
      archive.on("end", () => resolve(files));
      archive.on("entry", (entry) =>
        archive.openReadStream(entry, (error, stream) => {
          if (error) {
            archive.close();
            reject(error);
            return;
          }
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            files.set(entry.fileName, Buffer.concat(chunks));
            archive.readEntry();
          })().catch((error) => {
            archive.close();
            reject(error);
          });
        }),
      );
      archive.readEntry();
    });
  });
  return { download, bytes, files };
}

test("database ZIP exports include every schema, relationship and empty table with CSV or JSONL data", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Database export ${newId()}`,
  });
  let parent = await storage.createTable(actor, database.id, {
    name: "Manufacturers",
    fields: [
      {
        name: "RECORD_ID",
        type: "integer",
        required: true,
        autoIncrement: true,
      },
      {
        name: "CODE",
        type: "text",
        charLimit: 32,
        allowedValues: ["001", "002"],
        required: true,
      },
      { name: "ACTIVE", type: "boolean" },
      { name: "DETAILS", type: "json" },
    ],
    idempotencyKey: newId(),
  });
  const unique = await storage.createUniqueRule(actor, parent.id, {
    name: "Code",
    fieldIds: [parent.fields[1]!.id],
    expectedSchemaVersion: parent.schemaVersion,
    idempotencyKey: newId(),
  });
  parent = await storage.getTable(actor, parent.id);
  await storage.createUniqueRule(actor, parent.id, {
    name: "Active code",
    fieldIds: [parent.fields[1]!.id],
    where: { field: parent.fields[2]!.id, op: "eq", value: true },
    expectedSchemaVersion: parent.schemaVersion,
    idempotencyKey: newId(),
  });
  parent = await storage.getTable(actor, parent.id);
  for (const [CODE, ACTIVE] of [
    ["001", true],
    ["002", false],
  ] as const)
    await storage.createRow(
      actor,
      parent.id,
      { CODE, ACTIVE, DETAILS: { CODE, values: [false, 0, null] } },
      { idempotencyKey: newId() },
    );
  const child = await storage.createTable(actor, database.id, {
    name: "Aircraft",
    fields: [
      { name: "manufacturerId", type: "text", charLimit: 32 },
      { name: "note", type: "text", charLimit: 64 },
    ],
    idempotencyKey: newId(),
  });
  const foreign = await storage.createForeignKey(actor, child.id, {
    fieldIds: [child.fields[0]!.id],
    referencedTableId: parent.id,
    referencedRuleId: unique.id,
    expectedSchemaVersion: child.schemaVersion,
    expectedReferencedSchemaVersion: parent.schemaVersion,
    idempotencyKey: newId(),
  });
  for (const values of [
    { manufacturerId: "001", note: "" },
    { manufacturerId: "002", note: "\\N" },
    { manufacturerId: null, note: null },
  ])
    await storage.createRow(actor, child.id, values, {
      idempotencyKey: newId(),
    });
  const empty = await storage.createTable(actor, database.id, {
    name: "Empty table",
    fields: [{ name: "VALUE", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  for (const format of ["csv", "jsonl"] as const) {
    const input = { databaseId: database.id, format };
    const idempotencyKey = newId();
    const run = (await jobs.execute("exportDatabase", actor, input, {
      idempotencyKey,
    })) as { jobId: string };
    assert.deepEqual(
      await jobs.execute("exportDatabase", actor, input, { idempotencyKey }),
      run,
    );
    await assert.rejects(
      jobs.execute(
        "exportDatabase",
        actor,
        { ...input, format: format === "csv" ? "jsonl" : "csv" },
        { idempotencyKey },
      ),
      (error) =>
        error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    const done = await terminal(run.jobId);
    assert.equal(done.state, "succeeded", JSON.stringify(done.error));
    assert.equal(done.result?.format, "zip");
    assert.equal(done.result?.rowCount, 5);
    assert.equal(done.result?.tableCount, 3);
    const artifactId = String(done.result?.artifactId);
    const artifact = await jobs.execute("getArtifact", actor, {
      id: artifactId,
    });
    const parsed = getOperation("getArtifact").outputSchema.parse(artifact) as {
      format: string;
      tableCount: number;
    };
    assert.equal(parsed.format, "zip");
    assert.equal(parsed.tableCount, 3);
    const { download, bytes, files } = await databaseArchive(artifactId);
    assert.equal(download.mediaType, "application/zip");
    assert.match(download.fileName, /\.zip$/);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      done.result?.checksum,
    );
    assert.equal(files.size, 9);
    const json = (path: string) => JSON.parse(files.get(path)!.toString());
    const manifest = json("manifest.json");
    assert.equal(manifest.format, "rootset.database-export");
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.databaseId, database.id);
    assert.equal(manifest.dataFormat, format);
    assert.equal(manifest.rowCount, 5);
    assert.deepEqual(
      manifest.tables.map((table: { id: string }) => table.id),
      [parent.id, child.id, empty.id],
    );
    assert.deepEqual(
      manifest.tables.map((table: { rowCount: number }) => table.rowCount),
      [2, 3, 0],
    );
    for (const file of manifest.files) {
      const body = files.get(file.name)!;
      assert.equal(body.length, file.bytes);
      assert.equal(
        createHash("sha256").update(body).digest("hex"),
        file.sha256,
      );
    }
    assert.equal(json("database.json").id, database.id);
    const parentSchema = json(`tables/${parent.id}/schema.json`);
    assert.deepEqual(
      parentSchema.fields.map((field: { name: string }) => field.name),
      ["RECORD_ID", "CODE", "ACTIVE", "DETAILS"],
    );
    assert.equal(parentSchema.fields[0].autoIncrement, true);
    assert.deepEqual(parentSchema.fields[1].allowedValues, ["001", "002"]);
    assert.equal(parentSchema.uniqueRules.length, 2);
    assert.deepEqual(parentSchema.uniqueRules[1].where, {
      field: parent.fields[2]!.id,
      op: "eq",
      value: true,
    });
    assert.deepEqual(json(`tables/${child.id}/schema.json`).foreignKeys, [
      foreign,
    ]);
    for (const name of [parent.id, child.id, empty.id])
      assert.doesNotMatch(
        files.get(`tables/${name}/schema.json`)!.toString(),
        /physicalName|schemaName|physical_name|rootset_control/,
      );
    if (format === "csv") {
      assert.equal(
        files.get(`tables/${child.id}/data.csv`)!.toString(),
        'manufacturerId,note\n001,""\n002,\\\\N\n\\N,\\N\n',
      );
      assert.equal(
        files.get(`tables/${empty.id}/data.csv`)!.toString(),
        "VALUE\n",
      );
    } else {
      assert.deepEqual(
        files
          .get(`tables/${child.id}/data.jsonl`)!
          .toString()
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        [
          { manufacturerId: "001", note: "" },
          { manufacturerId: "002", note: "\\N" },
          { manufacturerId: null, note: null },
        ],
      );
      assert.equal(files.get(`tables/${empty.id}/data.jsonl`)!.length, 0);
    }
    const page = (await jobs.execute("listJobs", actor, {
      kind: "export",
      databaseId: database.id,
    })) as { data: { id: string; databaseId: string; format: string }[] };
    assert.equal(
      page.data.find((job) => job.id === run.jobId)?.databaseId,
      database.id,
    );
    assert.equal(page.data.find((job) => job.id === run.jobId)?.format, format);
  }
});

test("database exports keep one snapshot across tables and handle an empty database", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Export snapshot ${newId()}`,
  });
  const first = await storage.createTable(actor, database.id, {
    name: "First",
    fields: [{ name: "VALUE", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  const second = await storage.createTable(actor, database.id, {
    name: "Second",
    fields: [{ name: "VALUE", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  for (const table of [first, second])
    await storage.createRow(
      actor,
      table.id,
      { VALUE: "before snapshot" },
      { idempotencyKey: newId() },
    );
  const run = (await jobs.execute("exportDatabase", actor, {
    databaseId: database.id,
    format: "jsonl",
  })) as { jobId: string };
  hook = async (point, id) => {
    if (point !== "database-export.afterTable" || id !== run.jobId) return;
    hook = null;
    await storage.createRow(
      actor,
      second.id,
      { VALUE: "after snapshot" },
      { idempotencyKey: newId() },
    );
  };
  let done;
  try {
    done = await terminal(run.jobId);
  } finally {
    hook = null;
  }
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  const { files } = await databaseArchive(String(done.result?.artifactId));
  assert.equal(
    files.get(`tables/${second.id}/data.jsonl`)!.toString(),
    '{"VALUE":"before snapshot"}\n',
  );
  assert.equal(done.result?.rowCount, 2);
  const empty = await storage.createDatabase(actor, {
    name: `Empty export ${newId()}`,
  });
  const emptyRun = (await jobs.execute("exportDatabase", actor, {
    databaseId: empty.id,
    format: "csv",
  })) as { jobId: string };
  const emptyDone = await terminal(emptyRun.jobId);
  assert.equal(emptyDone.state, "succeeded", JSON.stringify(emptyDone.error));
  const archive = await databaseArchive(String(emptyDone.result?.artifactId));
  assert.deepEqual(
    [...archive.files.keys()],
    ["database.json", "README.txt", "manifest.json"],
  );
  assert.equal(emptyDone.result?.tableCount, 0);
  assert.equal(emptyDone.result?.rowCount, 0);
});

test("database exports fail during maintenance and can be retried without publishing a partial ZIP", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Maintenance export ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Changing table",
    fields: [{ name: "VALUE", type: "text" }],
    idempotencyKey: newId(),
  });
  await owner.query(
    "UPDATE rootset_control.tables SET state='maintenance' WHERE id=$1",
    [target.id],
  );
  const accepted = (await jobs.execute("exportDatabase", actor, {
    databaseId: database.id,
    format: "csv",
  })) as { jobId: string };
  const failed = await terminal(accepted.jobId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "SCHEMA_MAINTENANCE");
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int count FROM rootset_control.artifacts WHERE job_id=$1 AND state='ready'",
        [accepted.jobId],
      )
    ).rows[0].count,
    0,
  );
  await owner.query(
    "UPDATE rootset_control.tables SET state='active' WHERE id=$1",
    [target.id],
  );
  await jobs.execute("retryJob", actor, { id: accepted.jobId });
  const succeeded = await terminal(accepted.jobId);
  assert.equal(succeeded.state, "succeeded", JSON.stringify(succeeded.error));
  assert.equal(succeeded.result?.tableCount, 1);
});

test("V1-07 V1-24: duplicate admission is idempotent, only one lease claims, old lease cannot checkpoint", async () => {
  const key = newId();
  const input = { tableId: table.id, format: "jsonl" };
  const first = (await jobs.execute("exportRows", actor, input, {
    idempotencyKey: key,
  })) as { jobId: string };
  const second = (await jobs.execute("exportRows", actor, input, {
    idempotencyKey: key,
  })) as { jobId: string };
  assert.equal(first.jobId, second.jobId);
  await assert.rejects(
    jobs.execute(
      "exportRows",
      actor,
      { ...input, format: "csv" },
      { idempotencyKey: key },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const claims = await Promise.all([
    jobs.queue.claim(actor.orgId),
    jobs.queue.claim(actor.orgId),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean)!;
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [old.id],
    ),
  );
  const recovered = await jobs.queue.claim(actor.orgId);
  assert.ok(recovered);
  assert.notEqual(recovered.lease_token, old.lease_token);
  await assert.rejects(jobs.queue.checkpoint(old, {}, {}), LeaseLost);
  await jobs.queue.fail(
    recovered,
    new RootsetError("JOB_FAILED", "Test fixture terminal failure"),
  );
  currentAccess = false;
  await assert.rejects(
    jobs.execute("getJob", actor, { id: first.jobId }),
    (error) => error instanceof RootsetError && error.code === "ACCESS_DENIED",
  );
  currentAccess = true;
});

test("V1-07 V1-24: metadata cursors bind request limits, filters and current membership", async () => {
  const first = (await jobs.execute("listJobs", actor, { limit: 1 })) as {
    data: { id: string }[];
    nextCursor: string;
  };
  assert.equal(first.data.length, 1);
  assert.ok(first.nextCursor);
  const second = (await jobs.execute("listJobs", actor, {
    limit: 1,
    cursor: first.nextCursor,
  })) as { data: { id: string }[] };
  assert.ok(second.data[0]!.id > first.data[0]!.id);
  for (const input of [
    { limit: 2, cursor: first.nextCursor },
    { limit: 1, cursor: first.nextCursor, kind: "export" },
    { limit: 1, cursor: first.nextCursor + "x" },
  ])
    await assert.rejects(
      jobs.execute("listJobs", actor, input),
      (error) =>
        error instanceof RootsetError && error.code === "CURSOR_INVALID",
    );
  await assert.rejects(
    jobs.execute(
      "listJobs",
      { ...actor, membershipVersion: 2 },
      { limit: 1, cursor: first.nextCursor },
    ),
    (error) => error instanceof RootsetError && error.code === "CURSOR_INVALID",
  );
});

test("V1-07 V1-24 V1-25 V1-30: an expired uploader cannot overwrite the artifact produced by its replacement lease", async () => {
  const enqueued = await jobs.queue.enqueue(
    actor,
    "exportRows",
    "export",
    { type: "table", id: table.id },
    { fixture: "stale-upload" },
    newId(),
  );
  const original = await jobs.queue.claim(actor.orgId);
  assert.equal(original?.id, enqueued.id);
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume: () => void = () => undefined;
  const pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  async function* oldBytes() {
    yield Buffer.from("old");
    entered();
    await pause;
    yield Buffer.from(" bytes");
  }
  const stale = jobs.artifacts.write(
    actor,
    original!,
    { type: "table", id: table.id },
    "export",
    "jsonl",
    "application/x-ndjson",
    oldBytes(),
  );
  await started;
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [enqueued.id],
    ),
  );
  await jobs.queue.fail(
    original!,
    new RootsetError("ACCESS_DENIED", "Expired worker failure", 403),
  );
  const expired = await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "SELECT state,lease_token,attempt,error FROM rootset_control.jobs WHERE id=$1",
      [enqueued.id],
    ),
  );
  assert.equal(expired.rows[0].state, "running");
  assert.equal(expired.rows[0].lease_token, original!.lease_token);
  assert.equal(expired.rows[0].attempt, original!.attempt);
  assert.equal(expired.rows[0].error, null);
  const replacement = await jobs.queue.claim(actor.orgId);
  assert.equal(replacement?.id, enqueued.id);
  assert.notEqual(replacement?.lease_token, original?.lease_token);
  const current = await jobs.artifacts.write(
    actor,
    replacement!,
    { type: "table", id: table.id },
    "export",
    "jsonl",
    "application/x-ndjson",
    (async function* () {
      yield Buffer.from("new verified bytes");
    })(),
  );
  await jobs.queue.finish(replacement!, "succeeded", {
    artifactId: current.id,
  });
  resume();
  await assert.rejects(
    stale,
    (error) => error instanceof RootsetError && error.code === "JOB_FAILED",
  );
  const verified = await jobs.artifacts.openVerified(actor, current);
  try {
    const chunks = [];
    for await (const chunk of verified.stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "new verified bytes");
  } finally {
    await verified.cleanup();
  }
});

test("V1-25: CSV export distinguishes null, empty text, literal null markers and backslashes", async () => {
  const isolated = await storage.createDatabase(actor, {
    name: `CSV literals ${newId()}`,
  });
  const fields = [{ name: "name", type: "text" as const, charLimit: 128 }];
  const source = await storage.createTable(actor, isolated.id, {
    name: "Source",
    fields,
    idempotencyKey: newId(),
  });
  const values = ["", null, "\\N", "\\path", "\\\\path"];
  for (const name of values)
    await storage.createRow(
      actor,
      source.id,
      { name },
      { idempotencyKey: newId() },
    );
  const started = (await jobs.execute(
    "exportRows",
    actor,
    { tableId: source.id, format: "csv" },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const exported = await terminal(started.jobId);
  const downloaded = await jobs.downloadArtifact(
    actor,
    String(exported.result?.artifactId),
  );
  const chunks = [];
  for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString();
  assert.equal(exported.state, "succeeded");
  assert.equal(exported.result?.rowCount, values.length);
  assert.equal(csv, 'name\n""\n\\N\n\\\\N\n\\\\path\n\\\\\\path\n');
});

test("V1-07 V1-17 V1-24: Viewer-owned export cancellation and retry execute under current role and deny foreign requesters or lost current authority", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Viewer export ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Values",
    fields: [{ name: "value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    target.id,
    { value: "Viewer row" },
    { idempotencyKey: newId() },
  );
  const viewer: Actor = {
    kind: "personal_key",
    id: newId(),
    credentialId: newId(),
    userId: newId(),
    orgId: actor.orgId,
    role: "viewer",
    scopes: [
      "exports:read",
      "schema:read",
      "jobs:read",
      "jobs:cancel",
      "jobs:retry",
      "rows:read",
      "tables:read",
      "databases:read",
    ],
    membershipVersion: 1,
  };
  let liveViewer: Actor | undefined = viewer;
  const fallback = new JobsService({ pool, ddlPool, storage, config });
  const service = new JobsService({
    pool,
    ddlPool,
    storage,
    config,
    authorise: async (a, op, t) => {
      if (a.id === viewer.id && !liveViewer)
        throw new RootsetError(
          "ACCESS_DENIED",
          "Current membership was removed",
          403,
        );
      return fallback.authorise(a.id === viewer.id ? liveViewer! : a, op, t);
    },
  });
  await assert.rejects(
    fallback.authorise(
      {
        ...viewer,
        scopes: viewer.scopes.filter((scope) => scope !== "schema:read"),
      },
      "exportDatabase",
      { databaseId: database.id },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "INSUFFICIENT_SCOPE",
  );
  for (const [exportOperation, exportTarget] of [
    ["exportRows", { tableId: target.id }],
    ["exportDatabase", { databaseId: database.id }],
  ] as const) {
    const queued = (await service.execute(
      exportOperation,
      viewer,
      { ...exportTarget, format: "jsonl" },
      { idempotencyKey: newId() },
    )) as { jobId: string };
    const cancelKey = newId();
    const cancelled = (await service.execute(
      "cancelJob",
      viewer,
      { id: queued.jobId },
      { idempotencyKey: cancelKey },
    )) as { state: string };
    getOperation("cancelJob").outputSchema.parse(cancelled);
    assert.equal(cancelled.state, "cancelled");
    assert.deepEqual(
      await service.execute(
        "cancelJob",
        viewer,
        { id: queued.jobId },
        { idempotencyKey: cancelKey },
      ),
      cancelled,
    );
    const foreign: Actor = {
      ...viewer,
      id: newId(),
      credentialId: newId(),
      userId: newId(),
    };
    for (const operation of ["cancelJob", "retryJob"])
      await assert.rejects(
        service.execute(
          operation,
          foreign,
          { id: queued.jobId },
          { idempotencyKey: newId() },
        ),
        (error) =>
          error instanceof RootsetError && error.code === "RESOURCE_NOT_FOUND",
      );
    liveViewer = undefined;
    for (const operation of ["cancelJob", "retryJob"])
      await assert.rejects(
        service.execute(
          operation,
          viewer,
          { id: queued.jobId },
          { idempotencyKey: operation === "cancelJob" ? cancelKey : newId() },
        ),
        (error) =>
          error instanceof RootsetError && error.code === "ACCESS_DENIED",
      );
    liveViewer = viewer;
    const retryKey = newId();
    const retry = (await service.execute(
      "retryJob",
      viewer,
      { id: queued.jobId },
      { idempotencyKey: retryKey },
    )) as { jobId: string };
    getOperation("retryJob").outputSchema.parse(retry);
    assert.equal(retry.jobId, queued.jobId);
    assert.deepEqual(
      await service.execute(
        "retryJob",
        viewer,
        { id: queued.jobId },
        { idempotencyKey: retryKey },
      ),
      retry,
    );
    await service.runOnce(viewer.orgId);
    const finished = (await service.execute("getJob", viewer, {
      id: queued.jobId,
    })) as { state: string; result: { artifactId: string } };
    getOperation("getJob").outputSchema.parse(finished);
    assert.equal(finished.state, "succeeded");
    const download = await service.downloadArtifact(
      viewer,
      finished.result.artifactId,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    if (exportOperation === "exportRows")
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        value: "Viewer row",
      });
    else
      assert.equal(
        Buffer.concat(chunks).subarray(0, 4).toString("hex"),
        "504b0304",
      );
    await assert.rejects(
      service.downloadArtifact(foreign, finished.result.artifactId),
      (error) =>
        error instanceof RootsetError && error.code === "RESOURCE_NOT_FOUND",
    );
    liveViewer = undefined;
    await assert.rejects(
      service.downloadArtifact(viewer, finished.result.artifactId),
      (error) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
    await assert.rejects(
      service.execute(
        "retryJob",
        viewer,
        { id: queued.jobId },
        { idempotencyKey: retryKey },
      ),
      (error) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
    liveViewer = viewer;
    const revoked = (await service.execute(
      exportOperation,
      viewer,
      { ...exportTarget, format: "jsonl" },
      { idempotencyKey: newId() },
    )) as { jobId: string };
    liveViewer = undefined;
    await service.runOnce(viewer.orgId);
    liveViewer = viewer;
    const refused = (await service.execute("getJob", viewer, {
      id: revoked.jobId,
    })) as { state: string; error: { code: string } };
    getOperation("getJob").outputSchema.parse(refused);
    assert.equal(refused.state, "failed");
    assert.equal(refused.error.code, "ACCESS_DENIED");
  }
});

test("V1-07 V1-24 V1-25 V1-30: running exports recheck cancellation and current authority before publishing their artifact", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Export publication ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Values",
    fields: [{ name: "value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    target.id,
    { value: "Only authorized output" },
    { idempotencyKey: newId() },
  );
  for (const [operation, inputTarget] of [
    ["exportRows", { tableId: target.id }],
    [
      "exportView",
      {
        tableId: target.id,
        expectedSchemaVersion: target.schemaVersion,
        query: { select: [target.fields[0]!.id] },
      },
    ],
    ["exportDatabase", { databaseId: database.id }],
  ] as const) {
    for (const action of ["cancel", "revoke"] as const) {
      const run = (await jobs.execute(
        operation,
        actor,
        { ...inputTarget, format: "jsonl" },
        { idempotencyKey: newId() },
      )) as { jobId: string };
      hook = async (point, id) => {
        if (point !== "export.afterBatch" || id !== run.jobId) return;
        hook = null;
        if (action === "cancel")
          await jobs.execute(
            "cancelJob",
            actor,
            { id },
            { idempotencyKey: newId() },
          );
        else currentAccess = false;
      };
      try {
        await jobs.runOnce(actor.orgId);
      } finally {
        hook = null;
        currentAccess = true;
      }
      const result = (await jobs.execute("getJob", actor, {
        id: run.jobId,
      })) as {
        state: string;
        error: { code: string };
        result?: unknown;
      };
      getOperation("getJob").outputSchema.parse(result);
      assert.equal(result.state, action === "cancel" ? "cancelled" : "failed");
      assert.equal(result.result, undefined);
      if (action === "revoke") assert.equal(result.error.code, "ACCESS_DENIED");
      const artifacts = await withOrg(
        ddlPool,
        actor.orgId,
        async (c) =>
          (
            await c.query<{ id: string; state: string }>(
              "SELECT id,state FROM rootset_control.artifacts WHERE job_id=$1 AND purpose='export'",
              [run.jobId],
            )
          ).rows,
      );
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0]!.state, "failed");
      await assert.rejects(
        jobs.execute("getArtifact", actor, { id: artifacts[0]!.id }),
        (error) => error instanceof RootsetError && error.code === "JOB_FAILED",
      );
    }
  }
});

test("V1-07 V1-20 V1-24: generic exact-count replay after control expiry preserves first attribution, canonical input and all other business/security/target bindings", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Generic replay ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Count receipt",
    fields: [{ name: "value", type: "integer" }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    target.id,
    { value: 1 },
    { idempotencyKey: newId() },
  );
  await storage.createRow(
    actor,
    target.id,
    { value: 2 },
    { idempotencyKey: newId() },
  );
  let executions = 0;
  const service = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      executeOperation: async (a, operation, input) => {
        assert.equal(operation, "countRows");
        executions++;
        return {
          count: await storage.exactCount(
            a,
            String(input.tableId),
            input.query as Parameters<TableStorage["exactCount"]>[2],
          ),
          kind: "exact",
          asOf: new Date().toISOString(),
        };
      },
    },
    authorise: async (a) => {
      if (!currentAccess)
        throw new RootsetError("ACCESS_DENIED", "Access revoked", 403);
      return a;
    },
  });
  const key = newId(),
    requestId = newId();
  const input = {
    workspaceId: actor.orgId,
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    exact: true,
    query: { where: { field: "value", op: "eq", value: 1 } },
  };
  getOperation("countRows").inputSchema.parse(input);
  const accepted = (await service.enqueueOperation(actor, "countRows", input, {
    idempotencyKey: key,
    requestId,
    source: "mcp",
  })) as { jobId: string };
  const completed = await terminal(accepted.jobId, service);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.result!.count, 1);
  const read = async () =>
    (
      await owner.query("SELECT * FROM rootset_control.jobs WHERE id=$1", [
        accepted.jobId,
      ])
    ).rows[0]!;
  const original = await read();
  const expire = async () => {
    const expired = await owner.query(
      "UPDATE rootset_control.control_mutation_replays SET expires_at=now()-interval '1 second' WHERE org_id=$1 AND operation_id='countRows' AND outcome->>'jobId'=$2 RETURNING operation_id",
      [actor.orgId, accepted.jobId],
    );
    assert.equal(expired.rowCount, 1);
  };
  await expire();
  const replay = (await service.enqueueOperation(actor, "countRows", input, {
    idempotencyKey: key,
    requestId: newId(),
    source: "mcp",
  })) as { jobId: string };
  assert.equal(replay.jobId, accepted.jobId);
  assert.deepEqual((await read()).input, original.input);
  const legacyDigest = createHash("sha256")
    .update(
      stableStringify({
        actor: original.requester_id,
        orgId: original.org_id,
        operationId: original.operation_id,
        target: { type: original.target_type, id: original.target_id },
        input: original.input,
      }),
    )
    .digest("hex");
  assert.notEqual(legacyDigest, original.input_digest);
  await owner.query(
    "UPDATE rootset_control.jobs SET input_digest=$2 WHERE id=$1",
    [accepted.jobId, legacyDigest],
  );
  await expire();
  try {
    await assert.rejects(
      () =>
        service.enqueueOperation(actor, "countRows", input, {
          idempotencyKey: key,
          requestId: newId(),
          source: "mcp",
        }),
      (error: unknown) =>
        error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await owner.query(
      "UPDATE rootset_control.jobs SET input_digest=$2 WHERE id=$1",
      [accepted.jobId, original.input_digest],
    );
  }
  await expire();
  await assert.rejects(
    () =>
      service.enqueueOperation(
        actor,
        "countRows",
        { ...input, query: { where: { field: "value", op: "eq", value: 2 } } },
        { idempotencyKey: key, requestId: newId(), source: "mcp" },
      ),
    (error: unknown) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  for (const changed of [{ source: "rest" as const }])
    await assert.rejects(
      () =>
        service.enqueueOperation(actor, "countRows", input, {
          idempotencyKey: key,
          requestId: newId(),
          source: changed.source,
        }),
      (error: unknown) =>
        error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  const nativeTarget = { type: original.target_type, id: original.target_id };
  for (const changed of [
    { clientId: newId() },
    { credentialId: newId() },
    { scopes: ["*"] },
  ])
    await assert.rejects(
      () =>
        service.queue.enqueue(
          actor,
          "countRows",
          "operation",
          nativeTarget,
          {
            ...original.input,
            operationContext: {
              ...original.input.operationContext,
              requestId: newId(),
              ...changed,
            },
          },
          key,
        ),
      (error: unknown) =>
        error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  await assert.rejects(
    () =>
      service.queue.enqueue(
        actor,
        "countRows",
        "operation",
        { ...nativeTarget, id: newId() },
        original.input,
        key,
      ),
    (error: unknown) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await owner.query(
    "UPDATE rootset_control.jobs SET input_digest=$2 WHERE id=$1",
    [accepted.jobId, "0".repeat(64)],
  );
  try {
    await assert.rejects(
      () =>
        service.enqueueOperation(actor, "countRows", input, {
          idempotencyKey: key,
          requestId: newId(),
          source: "mcp",
        }),
      (error: unknown) =>
        error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await owner.query(
      "UPDATE rootset_control.jobs SET input_digest=$2 WHERE id=$1",
      [accepted.jobId, original.input_digest],
    );
  }
  currentAccess = false;
  try {
    await assert.rejects(
      () =>
        service.enqueueOperation(actor, "countRows", input, {
          idempotencyKey: key,
          requestId: newId(),
          source: "mcp",
        }),
      (error: unknown) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
  } finally {
    currentAccess = true;
  }
  assert.equal(executions, 1);
  const retained = await read();
  assert.deepEqual(retained.input, original.input);
  assert.equal(retained.input_digest, original.input_digest);
  assert.equal(retained.state, original.state);
  assert.deepEqual(retained.result, original.result);
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::text AS count FROM rootset_control.jobs WHERE operation_id='countRows' AND idempotency_key=$1",
        [key],
      )
    ).rows[0]!.count,
    "1",
  );
  assert.equal(await storage.exactCount(actor, target.id), 2);
});

test("V1-07 V1-17 V1-20 V1-24: trusted queued admission serializes filtered counts, authenticates lifetime business/proof/source provenance and fails closed on stale receipts or altered durable metadata", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Signed admission ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Admission count data",
    fields: [{ name: "value", type: "integer" }],
    idempotencyKey: newId(),
  });
  for (const value of [1, 2])
    await storage.createRow(
      actor,
      target.id,
      { value },
      { idempotencyKey: newId() },
    );
  let admissions = 0,
    executions = 0;
  const service = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      executeOperation: async (a, operation, input) => {
        assert.equal(operation, "countRows");
        executions++;
        return {
          count: await storage.exactCount(
            a,
            String(input.tableId),
            input.query as Parameters<TableStorage["exactCount"]>[2],
          ),
          kind: "exact",
          asOf: new Date().toISOString(),
        };
      },
    },
    authorise: async (a) => {
      if (!currentAccess)
        throw new RootsetError("ACCESS_DENIED", "Access revoked", 403);
      return a;
    },
  });
  const business = {
    workspaceId: actor.orgId,
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    query: { where: { field: "value", op: "eq", value: 1 } },
  };
  const admit = (
    key: string,
    input: Record<string, unknown> = business,
    options: Partial<OperationContext> = {},
    principal: Actor = actor,
  ) =>
    withOrg(fixture.identity, actor.orgId, (client) => {
      const context = {
        idempotencyKey: key,
        requestId: newId(),
        source: "mcp",
        ...options,
        client,
      };
      return service.withOperationAdmission(
        principal,
        "countRows",
        input,
        context,
        async (connection) => {
          admissions++;
          return service.enqueueOperation(principal, "countRows", input, {
            ...context,
            client: connection,
          });
        },
      );
    });
  const conflict = (error: unknown) =>
    error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT";
  const key = newId();
  const firstInput = { ...business, exact: undefined };
  assert.equal(
    Object.hasOwn(
      getOperation("countRows").inputSchema.parse(firstInput) as Record<
        string,
        unknown
      >,
      "exact",
    ),
    true,
  );
  const replies = await Promise.all([
    admit(key, firstInput),
    admit(key, firstInput),
    admit(key, firstInput),
  ]);
  for (const reply of replies)
    getOperation("countRows").outputSchema.parse(reply);
  assert.deepEqual(replies[0], replies[1]);
  assert.deepEqual(replies[0], replies[2]);
  assert.equal(admissions, 1);
  const acceptance = replies[0] as { jobId: string; state: string };
  assert.equal(acceptance.state, "queued");
  const completed = await terminal(acceptance.jobId, service);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.result!.count, 1);
  const read = async () =>
    (
      await owner.query("SELECT * FROM rootset_control.jobs WHERE id=$1", [
        acceptance.jobId,
      ])
    ).rows[0]!;
  const original = await read();
  assert.deepEqual(
    original.input.operationContext.admissionFields,
    Object.keys(business).sort(),
  );
  assert.match(
    original.input.operationContext.admissionBinding,
    /^v1:[a-f0-9]{64}$/,
  );
  assert.equal(original.input.operationContext.admissionSource, "mcp");
  assert.equal(original.input.operationContext.source, "mcp");
  assert.equal(original.input.operationContext.idempotencyKey, key);
  assert.equal(original.input.operationContext.publicInput, undefined);
  assert.equal(
    (
      await owner.query(
        "UPDATE rootset_control.control_mutation_replays SET expires_at=now()-interval '1 second' WHERE org_id=$1 AND operation_id='countRows' AND outcome->>'jobId'=$2 RETURNING operation_id",
        [actor.orgId, acceptance.jobId],
      )
    ).rowCount,
    1,
  );
  assert.deepEqual(await admit(key), acceptance);
  assert.deepEqual(await admit(key, firstInput), acceptance);
  assert.deepEqual(await read(), original);
  assert.equal(admissions, 1);
  assert.equal(executions, 1);
  for (const input of [
    { ...business, query: { where: { field: "value", op: "eq", value: 2 } } },
    { ...business, tableId: newId() },
    { ...business, databaseId: newId() },
  ])
    await assert.rejects(() => admit(key, input), conflict);
  for (const options of [{ source: "rest" }])
    await assert.rejects(() => admit(key, business, options), conflict);
  for (const principal of [
    { ...actor, userId: newId() },
    { ...actor, credentialId: newId() },
    { ...actor, clientId: "different-current-client" },
  ])
    await assert.rejects(() => admit(key, business, {}, principal), conflict);

  const digest = (input: Record<string, unknown>) => {
    const context = { ...(input.operationContext as Record<string, unknown>) };
    delete context.requestId;
    return createHash("sha256")
      .update(
        stableStringify({
          actor: original.requester_id,
          orgId: original.org_id,
          operationId: original.operation_id,
          target: { type: original.target_type, id: original.target_id },
          input: { ...input, operationContext: context },
        }),
      )
      .digest("hex");
  };
  const changedContexts = [
    { admissionFields: ["orgId", "databaseId", "tableId", "query", "query"] },
    { admissionFields: ["orgId", "databaseId", "tableId", "absentField"] },
    { admissionBinding: "v1:" + "0".repeat(64) },
    { admissionSource: "rest", source: "rest" },
    { idempotencyKey: newId() },
    { admissionSource: 1 },
    { admissionFields: undefined, admissionBinding: undefined },
  ];
  for (const changed of changedContexts) {
    const altered = {
      ...original.input,
      operationContext: { ...original.input.operationContext, ...changed },
    };
    await owner.query(
      "UPDATE rootset_control.jobs SET input=$2,input_digest=$3 WHERE id=$1",
      [acceptance.jobId, altered, digest(altered)],
    );
    try {
      await assert.rejects(() => admit(key), conflict);
    } finally {
      await owner.query(
        "UPDATE rootset_control.jobs SET input=$2,input_digest=$3 WHERE id=$1",
        [acceptance.jobId, original.input, original.input_digest],
      );
    }
  }
  const alteredBusiness = {
    ...original.input,
    query: { where: { field: "value", op: "eq", value: 2 } },
  };
  await owner.query(
    "UPDATE rootset_control.jobs SET input=$2,input_digest=$3 WHERE id=$1",
    [acceptance.jobId, alteredBusiness, digest(alteredBusiness)],
  );
  try {
    await assert.rejects(() => admit(key), conflict);
  } finally {
    await owner.query(
      "UPDATE rootset_control.jobs SET input=$2,input_digest=$3 WHERE id=$1",
      [acceptance.jobId, original.input, original.input_digest],
    );
  }

  const staleKey = newId();
  await withOrg(fixture.identity, actor.orgId, (client) =>
    runMutation(
      client,
      actor,
      "countRows",
      business,
      staleKey,
      config.idempotencySecret!,
      async () => acceptance,
    ),
  );
  await assert.rejects(() => admit(staleKey), conflict);
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::text AS count FROM rootset_control.jobs WHERE org_id=$1 AND operation_id='countRows' AND idempotency_key=$2",
        [actor.orgId, staleKey],
      )
    ).rows[0]!.count,
    "0",
  );
  const rollbackKey = newId();
  await assert.rejects(() =>
    withOrg(fixture.identity, actor.orgId, async (client) => {
      const context = {
        idempotencyKey: rollbackKey,
        source: "rest",
        client,
      };
      await service.withOperationAdmission(
        actor,
        "countRows",
        business,
        context,
        (connection) =>
          service.enqueueOperation(actor, "countRows", business, {
            ...context,
            client: connection,
          }),
      );
      throw new Error(
        "Rollback the admission, receipt and durable job together",
      );
    }),
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::text AS count FROM rootset_control.jobs WHERE org_id=$1 AND operation_id='countRows' AND idempotency_key=$2",
        [actor.orgId, rollbackKey],
      )
    ).rows[0]!.count,
    "0",
  );
  currentAccess = false;
  try {
    await assert.rejects(
      () => admit(key),
      (error: unknown) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
  } finally {
    currentAccess = true;
  }
  await assert.rejects(
    () =>
      admit(newId(), {
        orgId: actor.orgId,
        databaseId: database.id,
        tableId: target.id,
      }),
    (error: unknown) =>
      error instanceof RootsetError && error.code === "CONFIGURATION_INVALID",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::text AS count FROM rootset_control.jobs WHERE org_id=$1 AND operation_id='countRows' AND idempotency_key=$2",
        [actor.orgId, key],
      )
    ).rows[0]!.count,
    "1",
  );
  assert.equal(executions, 1);
  assert.equal(await storage.exactCount(actor, target.id), 2);
  assert.deepEqual(await read(), original);
});

test("CSV imports validate without writes, resume after a crash and admit one job per preview", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Import ${newId()}`,
  });
  let target = await storage.createTable(actor, database.id, {
    name: "Append imports",
    fields: [
      { name: "CODE", type: "text", required: true, charLimit: 64 },
      {
        name: "RECORD_ID",
        type: "integer",
        required: true,
        autoIncrement: true,
      },
      { name: "ENABLED", type: "boolean", required: true, default: false },
    ],
  });
  await storage.createUniqueRule(actor, target.id, {
    name: "Code",
    fieldIds: [target.fields[0]!.id],
    expectedSchemaVersion: target.schemaVersion,
    idempotencyKey: newId(),
  });
  target = await storage.getTable(actor, target.id);
  const input = {
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
    format: "csv",
    fileName: "codes.csv",
    content:
      "CODE\n" +
      Array.from({ length: 1001 }, (_, index) =>
        String(index).padStart(5, "0"),
      ).join("\n"),
    mapping: [{ source: "CODE", fieldId: target.fields[0]!.id }],
  };
  const preview = (await jobs.execute("previewImportRows", actor, input)) as {
    jobId: string;
  };
  const validated = await terminal(preview.jobId);
  assert.equal(validated.state, "succeeded");
  assert.equal(validated.result?.invalid, 0);
  assert.equal(validated.result?.total, 1001);
  assert.equal(await storage.exactCount(actor, target.id), 0);
  assert.equal(
    (
      await owner.query(
        "SELECT next_value::text FROM rootset_control.integer_counters WHERE field_id=$1",
        [target.fields[1]!.id],
      )
    ).rows[0]!.next_value,
    "1",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS count FROM rootset_control.mutations WHERE table_id=$1",
        [target.id],
      )
    ).rows[0]!.count,
    0,
  );
  const request = {
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
    previewId: preview.jobId,
  };
  const started = (await jobs.execute("importRows", actor, request)) as {
    jobId: string;
  };
  const repeated = (await jobs.execute("importRows", actor, request)) as {
    jobId: string;
  };
  assert.equal(repeated.jobId, started.jobId);
  let interrupted = false;
  hook = async (point, jobId) => {
    if (
      point === "import.afterBatch" &&
      jobId === started.jobId &&
      !interrupted
    ) {
      interrupted = true;
      throw new Error("Simulated crash after a committed import batch");
    }
  };
  try {
    await jobs.runOnce(actor.orgId);
    assert.equal(await storage.exactCount(actor, target.id), 250);
    const checkpoint = (
      await owner.query(
        "SELECT checkpoint,progress FROM rootset_control.jobs WHERE id=$1",
        [started.jobId],
      )
    ).rows[0]!;
    assert.equal(checkpoint.checkpoint.next, 250);
    assert.equal(checkpoint.progress.committed, 250);
    await owner.query(
      "UPDATE rootset_control.jobs SET next_attempt_at=now() WHERE id=$1",
      [started.jobId],
    );
    const completed = await terminal(started.jobId);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.result?.committed, 1001);
  } finally {
    hook = null;
  }
  assert.equal(await storage.exactCount(actor, target.id), 1001);
  const rows = await storage.queryRows(actor, target.id, {
    limit: 1001,
    orderBy: [{ field: "RECORD_ID", direction: "asc" }],
  });
  assert.equal(rows.data[0]!.values.CODE, "00000");
  assert.equal(rows.data[1000]!.values.CODE, "01000");
  assert.equal(rows.data[1000]!.values.RECORD_ID, 1001);
  assert.ok(rows.data.every((row) => row.values.ENABLED === false));
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS count FROM rootset_control.jobs WHERE kind='import' AND target_id=$1",
        [target.id],
      )
    ).rows[0]!.count,
    1,
  );
});

test("import previews report unique and composite foreign-key errors without changing counters or records", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Import relationships ${newId()}`,
  });
  let parent = await storage.createTable(actor, database.id, {
    name: "Manufacturers",
    fields: [
      { name: "CODE", type: "text", required: true },
      { name: "EDITION", type: "integer", required: true },
    ],
  });
  const parentRule = await storage.createUniqueRule(actor, parent.id, {
    name: "Manufacturer key",
    fieldIds: parent.fields.map((field) => field.id),
    expectedSchemaVersion: parent.schemaVersion,
    idempotencyKey: newId(),
  });
  parent = await storage.getTable(actor, parent.id);
  await storage.createRow(actor, parent.id, { CODE: "001", EDITION: 2 });
  let target = await storage.createTable(actor, database.id, {
    name: "Aircraft",
    fields: [
      { name: "NAME", type: "text", required: true },
      { name: "MANUFACTURER", type: "text" },
      { name: "REVISION", type: "integer" },
    ],
  });
  await storage.createUniqueRule(actor, target.id, {
    name: "Aircraft name",
    fieldIds: [target.fields[0]!.id],
    expectedSchemaVersion: target.schemaVersion,
    idempotencyKey: newId(),
  });
  target = await storage.getTable(actor, target.id);
  await storage.createForeignKey(actor, target.id, {
    fieldIds: [target.fields[1]!.id, target.fields[2]!.id],
    referencedTableId: parent.id,
    referencedRuleId: parentRule.id,
    expectedSchemaVersion: target.schemaVersion,
    expectedReferencedSchemaVersion: parent.schemaVersion,
    idempotencyKey: newId(),
  });
  target = await storage.getTable(actor, target.id);
  await storage.createRow(actor, target.id, {
    NAME: "existing",
    MANUFACTURER: "001",
    REVISION: 2,
  });
  const accepted = (await jobs.execute("previewImportRows", actor, {
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
    format: "csv",
    fileName: "relationships.csv",
    content:
      "NAME,MANUFACTURER,REVISION\nvalid,001,2\nexisting,001,2\nmissing,1,2\nvalid,001,2\nnullable,\\N,999\n",
    mapping: target.fields.map((field) => ({
      source: field.name,
      fieldId: field.id,
    })),
  })) as { jobId: string };
  const preview = await terminal(accepted.jobId);
  assert.equal(preview.state, "succeeded");
  assert.equal(preview.result?.invalid, 3);
  const issues = preview.result!.issues as { line: number; code: string }[];
  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.code]),
    [
      [3, "UNIQUE_CONFLICT"],
      [4, "FOREIGN_KEY_CONFLICT"],
      [5, "UNIQUE_CONFLICT"],
    ],
  );
  assert.equal(await storage.exactCount(actor, target.id), 1);
  await assert.rejects(
    jobs.execute("importRows", actor, {
      orgId: actor.orgId,
      databaseId: database.id,
      tableId: target.id,
      expectedSchemaVersion: target.schemaVersion,
      previewId: accepted.jobId,
    }),
    (error) =>
      error instanceof RootsetError && error.code === "VALIDATION_FAILED",
  );
  const artifactId = String(preview.result!.reportArtifactId);
  const metadata = await jobs.getArtifact(actor, artifactId);
  assert.equal(metadata.kind, "import_report");
  const download = await jobs.downloadArtifact(actor, artifactId);
  let text = "";
  for await (const chunk of download.stream) text += chunk.toString();
  assert.deepEqual(
    text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    issues,
  );
  const other = {
    ...actor,
    kind: "session" as const,
    id: newId(),
    userId: newId(),
    role: "member" as const,
  };
  await assert.rejects(
    jobs.getArtifact(other, artifactId),
    (error) =>
      error instanceof RootsetError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("cancelled imports keep their committed progress and retry only the remaining records", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Import cancellation ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Cancellation",
    fields: [{ name: "CODE", type: "integer", required: true }],
  });
  const base = {
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
  };
  const preview = (await jobs.execute("previewImportRows", actor, {
    ...base,
    format: "jsonl",
    fileName: "codes.jsonl",
    content: Array.from({ length: 501 }, (_, index) =>
      JSON.stringify({ source: index }),
    ).join("\n"),
    mapping: [{ source: "source", fieldId: target.fields[0]!.id }],
  })) as { jobId: string };
  assert.equal((await terminal(preview.jobId)).state, "succeeded");
  const started = (await jobs.execute("importRows", actor, {
    ...base,
    previewId: preview.jobId,
  })) as { jobId: string };
  let cancelled = false;
  hook = async (point, jobId) => {
    if (
      point === "import.afterBatch" &&
      jobId === started.jobId &&
      !cancelled
    ) {
      cancelled = true;
      await jobs.execute("cancelJob", actor, { id: jobId });
    }
  };
  try {
    const partial = await terminal(started.jobId);
    assert.equal(partial.state, "partially_completed");
    assert.equal(partial.result?.committed, 250);
    assert.equal(await storage.exactCount(actor, target.id), 250);
  } finally {
    hook = null;
  }
  await jobs.execute("retryJob", actor, { id: started.jobId });
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result?.committed, 501);
  assert.equal(await storage.exactCount(actor, target.id), 501);
});

test("imports revalidate a changed unique key and keep a recoverable report before writing any rows", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Import race ${newId()}`,
  });
  let target = await storage.createTable(actor, database.id, {
    name: "Concurrent import",
    fields: [{ name: "CODE", type: "text", required: true, charLimit: 80 }],
  });
  await storage.createUniqueRule(actor, target.id, {
    name: "Code",
    fieldIds: [target.fields[0]!.id],
    expectedSchemaVersion: target.schemaVersion,
    idempotencyKey: newId(),
  });
  target = await storage.getTable(actor, target.id);
  const base = {
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
  };
  const preview = (await jobs.execute("previewImportRows", actor, {
    ...base,
    format: "csv",
    fileName: "race.csv",
    content: "CODE\nfirst\nsecond\n",
    mapping: [{ source: "CODE", fieldId: target.fields[0]!.id }],
  })) as { jobId: string };
  assert.equal((await terminal(preview.jobId)).result?.invalid, 0);
  const existing = await storage.createRow(actor, target.id, { CODE: "first" });
  const started = (await jobs.execute("importRows", actor, {
    ...base,
    previewId: preview.jobId,
  })) as { jobId: string };
  const blocked = await terminal(started.jobId);
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.error?.code, "IMPORT_VALIDATION_FAILED");
  assert.equal(await storage.exactCount(actor, target.id), 1);
  const details = blocked.error!.details as { reportArtifactId: string };
  const download = await jobs.downloadArtifact(actor, details.reportArtifactId);
  let text = "";
  for await (const chunk of download.stream) text += chunk.toString();
  assert.equal(JSON.parse(text.trim()).line, 2);
  await storage.deleteRow(actor, target.id, existing.id, {
    expectedVersion: existing.version,
  });
  await jobs.execute("retryJob", actor, { id: started.jobId });
  assert.equal((await terminal(started.jobId)).state, "succeeded");
  assert.equal(await storage.exactCount(actor, target.id), 2);
});

test("a fully committed import reconciles after a crash even if the requester loses access", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Import outcome ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Outcome",
    fields: [{ name: "CODE", type: "text", required: true }],
  });
  const base = {
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
  };
  const preview = (await jobs.execute("previewImportRows", actor, {
    ...base,
    format: "jsonl",
    fileName: "outcome.jsonl",
    content: '{"CODE":"once"}',
    mapping: [{ source: "CODE", fieldId: target.fields[0]!.id }],
  })) as { jobId: string };
  assert.equal((await terminal(preview.jobId)).state, "succeeded");
  const started = (await jobs.execute("importRows", actor, {
    ...base,
    previewId: preview.jobId,
  })) as { jobId: string };
  hook = async (point, jobId) => {
    if (point === "import.afterBatch" && jobId === started.jobId) {
      currentAccess = false;
      throw new Error("Crash after final commit and before job completion");
    }
  };
  try {
    await jobs.runOnce(actor.orgId);
    assert.equal(await storage.exactCount(actor, target.id), 1);
    await jobs.runOnce(actor.orgId);
    const record = (
      await owner.query(
        "SELECT state,result FROM rootset_control.jobs WHERE id=$1",
        [started.jobId],
      )
    ).rows[0]!;
    assert.equal(record.state, "succeeded");
    assert.equal(record.result.committed, 1);
    assert.equal(await storage.exactCount(actor, target.id), 1);
  } finally {
    hook = null;
    currentAccess = true;
  }
});

test("import validation uses conditional composite registry keys and tracks duplicates across batches", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Conditional import ${newId()}`,
  });
  let target = await storage.createTable(actor, database.id, {
    name: "Conditional keys",
    fields: [
      { name: "CODE", type: "text", required: true, charLimit: 4096 },
      { name: "EDITION", type: "integer", required: true },
      { name: "ENABLED", type: "boolean", required: true, default: false },
    ],
  });
  const rule = await storage.createUniqueRule(actor, target.id, {
    name: "Enabled code",
    fieldIds: [target.fields[0]!.id, target.fields[1]!.id],
    where: { field: target.fields[2]!.id, op: "eq", value: true },
    expectedSchemaVersion: target.schemaVersion,
    idempotencyKey: newId(),
  });
  assert.equal(rule.strategy, "registry");
  target = await storage.getTable(actor, target.id);
  await storage.createRow(actor, target.id, {
    CODE: "existing",
    EDITION: 1,
    ENABLED: true,
  });
  const rows = Array.from({ length: 252 }, (_, index) => ({
    CODE: `code${index}`,
    EDITION: 1,
    ENABLED: true,
  }));
  rows[1] = { CODE: "existing", EDITION: 1, ENABLED: false };
  rows[2] = { CODE: "existing", EDITION: 1, ENABLED: true };
  rows[251] = rows[0]!;
  const preview = (await jobs.execute("previewImportRows", actor, {
    orgId: actor.orgId,
    databaseId: database.id,
    tableId: target.id,
    expectedSchemaVersion: target.schemaVersion,
    format: "jsonl",
    fileName: "conditional.jsonl",
    content: rows.map((row) => JSON.stringify(row)).join("\n"),
    mapping: target.fields.map((field) => ({
      source: field.name,
      fieldId: field.id,
    })),
  })) as { jobId: string };
  const result = await terminal(preview.jobId);
  assert.equal(result.state, "succeeded");
  assert.equal(result.result?.invalid, 2);
  assert.deepEqual(
    (result.result!.issues as { line: number }[]).map((issue) => issue.line),
    [3, 252],
  );
  assert.equal(await storage.exactCount(actor, target.id), 1);
});
