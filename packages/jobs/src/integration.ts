import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { withOrg } from "@rootset/database";
import {
  newId,
  getOperation,
  RootsetError,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";
import { TableStorage, type TableRecord } from "@rootset/table-storage";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  JobsService as BaseJobsService,
  LeaseLost,
  type JobsConfig,
  type OperationContext,
} from "./index.js";
import { MetadataPaging } from "../../core/src/paging.js";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { snapshotTransaction } from "./queue.js";

if (!process.env.ROOTSET_TEST_DATABASE_URL)
  throw new Error(
    "Real PostgreSQL fixture required: set ROOTSET_TEST_DATABASE_URL, ROOTSET_TEST_APP_DATABASE_URL, ROOTSET_TEST_DDL_DATABASE_URL and S3 variables",
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
  kind: "operator",
  id: newId(),
  orgId: newId(),
  role: "owner",
  scopes: ["*"],
  targets: [],
  unrestricted: true,
  operator: true,
};
let currentAccess = true;
let failPoint: string | null = null;
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
    activeKeyId: process.env.ROOTSET_ENCRYPTION_KEY_ID ?? "integration",
    encryptionKeys: {
      [process.env.ROOTSET_ENCRYPTION_KEY_ID ?? "integration"]:
        process.env.ROOTSET_ENCRYPTION_KEY ??
        randomBytes(32).toString("base64"),
    },
  },
  organisationIds: async () => [actor.orgId],
  failpoint: async (point, jobId) => {
    await hook?.(point, jobId);
    if (failPoint === point) {
      failPoint = null;
      throw new Error(`Forced interruption ${point}`);
    }
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
let databaseId: string;
let backupId: string;

async function deleteBackup(database: string, id: string) {
  const accepted = (await jobs.execute("deleteBackup", actor, {
    databaseId: database,
    id,
  })) as { jobId: string };
  const result = await terminal(accepted.jobId);
  assert.equal(result.state, "succeeded", JSON.stringify(result.error));
  assert.deepEqual(result.result, { deleted: true });
}

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

async function upload(content: string, format = "csv") {
  const prepared = (await jobs.execute(
    "prepareImportUpload",
    actor,
    {
      tableId: table.id,
      format,
      byteLength: Buffer.byteLength(content),
      checksum: createHash("sha256").update(content).digest("hex"),
    },
    { idempotencyKey: newId() },
  )) as {
    artifactId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  };
  const response = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: prepared.headers,
    body: content,
  });
  assert.equal(response.status, 200, await response.text());
  return prepared.artifactId;
}
async function enqueueImport(
  artifactId: string,
  additional: Record<string, unknown> = {},
  operation = "importRows",
) {
  return jobs.execute(
    operation,
    actor,
    {
      tableId: table.id,
      artifactId,
      expectedSchemaVersion: table.schemaVersion,
      mapping: {
        code: "code",
        name: "name",
        active: "active",
        instant: "instant",
        payload: "payload",
      },
      mode: "create",
      batchSize: 2,
      ...additional,
    },
    { idempotencyKey: newId() },
  ) as Promise<{ jobId: string }>;
}

before(async () => {
  await owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [actor.orgId, `Jobs integration ${actor.orgId}`],
  );
  const database = await storage.createDatabase(actor, {
    name: `Jobs data ${newId()}`,
  });
  databaseId = database.id;
  table = await storage.createTable(actor, database.id, {
    name: "Airline codes",
    fields: [
      {
        apiKey: "code",
        label: "Code",
        type: "text",
        charLimit: 32,
        required: true,
      },
      { apiKey: "name", label: "Name", type: "text", charLimit: 256 },
      { apiKey: "active", label: "Active", type: "boolean" },
      { apiKey: "instant", label: "Instant", type: "date-time" },
      { apiKey: "payload", label: "Payload", type: "json" },
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
      await client.query("UPDATE rootset_control.backups SET state='deleted'");
      await client.query(
        "UPDATE rootset_control.backup_policies SET enabled=false,next_occurrence=NULL",
      );
    });
    await jobs.runOnce(actor.orgId);
    await owner.query(
      "UPDATE rootset_control.organisations SET state='suspended' WHERE id=$1",
      [actor.orgId],
    );
  } finally {
    await fixture.close();
  }
});

test("IO-01/02/04 JOB-02/03: import commit interruption resumes exact rows/history with leading zeros", async () => {
  const id = await upload(
    'code,name,active,instant,payload\n00001,"Name, one",true,2026-10-02T01:00:00Z,"{""id"":""literal"",""nested"":null}"\n00002,Two,false,2026-10-02T02:00:00.123Z,{}\n00003,Three,true,2026-10-02T03:00:00Z,[]\n',
  );
  failPoint = "import.afterCommit";
  const job = await enqueueImport(id);
  const result = await terminal(job.jobId);
  assert.equal(result.state, "succeeded", JSON.stringify(result.error));
  assert.equal(result.result?.committed, 3);
  const rows = await storage.queryRows(actor, table.id, { limit: 10 });
  assert.equal(rows.data.length, 3);
  assert.equal(
    rows.data.find((row) => row.values.code === "00001")?.values.name,
    "Name, one",
  );
  assert.deepEqual(
    rows.data.find((row) => row.values.code === "00001")?.values.payload,
    { id: "literal", nested: null },
  );
  const events = await withOrg(
    pool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ count: string }>(
          "SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1",
          [table.id],
        )
      ).rows[0]!.count,
  );
  assert.equal(
    Number(events),
    15,
    "One insert cell event per populated cell, without duplicate history",
  );
});

test("IO-02/05: partial large import reports exact rejected record while atomic import rolls back", async () => {
  const id = await upload(
    "code,name,active,instant,payload\n00004,Four,true,2026-10-02T04:00:00Z,{}\n00001,Duplicate,true,2026-10-02T05:00:00Z,{}\n00005,Five,invalid,2026-10-02T06:00:00Z,{}\n",
  );
  const job = await enqueueImport(id);
  const result = await terminal(job.jobId);
  assert.equal(
    result.state,
    "partially_completed",
    JSON.stringify(result.error),
  );
  assert.equal(result.result?.committed, 1);
  assert.equal(result.result?.rejected, 2);
  const download = await jobs.downloadArtifact(
    actor,
    String(result.result?.rejectionArtifactId),
  );
  let report = "";
  for await (const chunk of download.stream) report += chunk.toString();
  assert.deepEqual(
    report
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).record),
    [2, 3],
  );
  const atomicId = await upload(
    "code,name,active,instant,payload\n00006,Six,true,2026-10-02T06:00:00Z,{}\n00001,Conflict,true,2026-10-02T06:00:00Z,{}\n",
  );
  const atomic = await enqueueImport(atomicId, { atomic: true });
  const failed = await terminal(atomic.jobId);
  assert.equal(failed.state, "failed");
  assert.equal(
    (
      await storage.queryRows(actor, table.id, {
        where: { field: "code", op: "eq", value: "00006" },
      })
    ).data.length,
    0,
  );
});

test("IO-03: exact unique-rule upsert updates existing rows and rejects absent explicit row IDs", async () => {
  const rule = (await storage.listUniqueRules(actor, table.id))[0]!;
  const id = await upload(
    "code,name,active,instant,payload\n00002,Updated,false,2026-10-02T02:00:00.123Z,{}\n",
  );
  const job = await enqueueImport(id, {
    mode: "upsert",
    uniqueRuleId: rule.id,
  });
  assert.equal((await terminal(job.jobId)).state, "succeeded");
  const row = (
    await storage.queryRows(actor, table.id, {
      where: { field: "code", op: "eq", value: "00002" },
    })
  ).data[0]!;
  assert.equal(row.values.name, "Updated");
  assert.equal(row.version, "2");
  const raw = await upload(
    `row_id,code,name,active,instant,payload\n${newId()},00999,Missing,true,2026-10-02T00:00:00Z,{}\n`,
  );
  const missing = await enqueueImport(raw, {
    mode: "upsert",
    rowIdColumn: "row_id",
  });
  const result = await terminal(missing.jobId);
  assert.equal(result.state, "partially_completed");
  assert.equal(result.result?.committed, 0);
});

test("IO-06/07/08: filtered snapshot export has canonical quoted content and encrypted storage", async () => {
  const started = (await jobs.execute(
    "exportRows",
    actor,
    {
      tableId: table.id,
      format: "csv",
      query: { where: { field: "code", op: "eq", value: "00001" } },
    },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.result?.rowCount, 1);
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
  assert.match(content, /00001,"Name, one",true,2026-10-02T01:00:00.000Z/);
  assert.equal(
    download.checksum,
    createHash("sha256").update(content).digest("hex"),
  );
});

test("JOB-01/04: duplicate admission is idempotent, only one lease claims, old lease cannot checkpoint", async () => {
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

test("BKP-03/04/05/08/10: backup upload interruption resumes isolated restore verification and new restore preserves rows/history", async () => {
  const started = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  failPoint = "backup.afterUpload";
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  backupId = String(completed.result?.backupId);
  assert.ok(completed.result?.verifiedAt);
  const restored = (await jobs.execute(
    "restoreBackup",
    actor,
    { databaseId, id: backupId, mode: "new", name: "Restored integration" },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const result = await terminal(restored.jobId);
  assert.equal(result.state, "succeeded", JSON.stringify(result.error));
  const mapped = (result.result?.tableMapping as Record<string, JsonValue>)[
    table.id
  ];
  const original = await storage.queryRows(actor, table.id, { limit: 100 });
  const copy = await storage.queryRows(actor, String(mapped), { limit: 100 });
  assert.deepEqual(copy.data, original.data);
  const retained = await withOrg(
    pool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ count: string }>(
          "SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1",
          [mapped],
        )
      ).rows[0]!.count,
  );
  const originalCount = await withOrg(
    pool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ count: string }>(
          "SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1",
          [table.id],
        )
      ).rows[0]!.count,
  );
  assert.equal(Number(retained), Number(originalCount));
});

test("IO-01/02: dry run validates upload duplicates without committing rows", async () => {
  const before = (await storage.getTable(actor, table.id)).rowCount;
  const id = await upload(
    "code,name,active,instant,payload\nDRY001,Valid,true,2026-10-02T00:00:00Z,{}\nDRY001,Duplicate,true,2026-10-02T00:00:00Z,{}\n00001,Existing,true,2026-10-02T00:00:00Z,{}\n",
  );
  const started = await enqueueImport(id, {}, "validateImport");
  const result = await terminal(started.jobId);
  assert.equal(result.state, "succeeded", JSON.stringify(result.error));
  assert.equal(result.result?.valid, false);
  assert.equal(result.result?.accepted, 1);
  assert.equal(result.result?.rejected, 2);
  assert.equal((await storage.getTable(actor, table.id)).rowCount, before);
});

test("IO-04/05 JOB-03: cancel after committed batch exposes partial progress and retry resumes without duplication", async () => {
  const id = await upload(
    "code,name,active,instant,payload\nCAN001,One,true,2026-10-02T00:00:00Z,{}\nCAN002,Two,true,2026-10-02T00:00:00Z,{}\nCAN003,Three,true,2026-10-02T00:00:00Z,{}\n",
  );
  const started = await enqueueImport(id);
  hook = async (point, jobId) => {
    if (point === "import.afterCommit" && jobId === started.jobId) {
      hook = null;
      await jobs.execute("cancelJob", actor, { id: jobId });
    }
  };
  const partial = await terminal(started.jobId);
  assert.equal(partial.state, "partially_completed");
  assert.equal(partial.result?.committed, 2);
  assert.equal(partial.result?.cancelled, true);
  await jobs.execute("retryJob", actor, { id: started.jobId });
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result?.committed, 3);
  const rows = await storage.queryRows(actor, table.id, {
    where: { field: "code", op: "prefix", value: "CAN" },
  });
  assert.equal(rows.data.length, 3);
  assert.ok(rows.data.every((row) => row.version === "1"));
});

test("BKP-03: concurrent row writes continue while schema DDL waits through extraction", async () => {
  const oldBackup = backupId;
  const companion = await storage.createTable(actor, databaseId, {
    name: "Companion snapshot",
    fields: [{ apiKey: "name", label: "Name", type: "text", charLimit: 128 }],
    idempotencyKey: newId(),
  });
  const companionRow = await storage.createRow(
    actor,
    companion.id,
    { name: "Before database snapshot" },
    { idempotencyKey: newId() },
  );
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let extracted: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    extracted = resolve;
  });
  let firstTable = true;
  hook = async (point) => {
    if (point === "backup.afterTableExtraction" && firstTable) {
      firstTable = false;
      await storage.updateRow(
        actor,
        companion.id,
        companionRow.id,
        { name: "After first table extracted" },
        { expectedVersion: companionRow.version, idempotencyKey: newId() },
      );
    }
    if (point === "backup.afterExtraction") {
      extracted();
      await barrier;
      hook = null;
    }
  };
  const started = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const running = jobs.runOnce(actor.orgId);
  await reached;
  const row = (
    await storage.queryRows(actor, table.id, {
      where: { field: "code", op: "eq", value: "00001" },
    })
  ).data[0]!;
  await storage.updateRow(
    actor,
    table.id,
    row.id,
    { name: "Concurrent new name" },
    { expectedVersion: row.version, idempotencyKey: newId() },
  );
  let schemaDone = false;
  const ddl = storage
    .createField(actor, table.id, {
      apiKey: "extra",
      label: "Extra",
      type: "text",
      expectedSchemaVersion: table.schemaVersion,
      idempotencyKey: newId(),
    })
    .then((value) => {
      schemaDone = true;
      return value;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(schemaDone, false, "DDL must wait behind schema barrier");
  release();
  await running;
  table = await ddl;
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  backupId = String(completed.result?.backupId);
  const loaded = await jobs.backups.load(actor, backupId);
  const backed = [];
  for await (const batch of jobs.backups
    .source(actor, loaded.manifest)
    .rows(table.id))
    backed.push(...batch);
  assert.equal(
    backed.find((value) => value.values.code === "00001")?.values.name,
    "Name, one",
  );
  assert.equal(
    loaded.manifest.metadata.tables[0]!.fields.some(
      (field) => field.apiKey === "extra",
    ),
    false,
  );
  const companionSnapshot = [];
  for await (const batch of jobs.backups
    .source(actor, loaded.manifest)
    .rows(companion.id))
    companionSnapshot.push(...batch);
  assert.equal(companionSnapshot[0]?.values.name, "Before database snapshot");
  assert.equal(
    (await storage.getRow(actor, companion.id, companionRow.id)).values.name,
    "After first table extracted",
  );
  await deleteBackup(databaseId, oldBackup);
});

test("JOB-02/03 IO-04: SIGKILL after a committed import batch recovers under a new worker lease", async () => {
  const artifact = await upload(
    "code,name,active,instant,payload\nKILL001,One,true,2026-10-02T00:00:00Z,{}\nKILL002,Two,true,2026-10-02T00:00:00Z,{}\nKILL003,Three,true,2026-10-02T00:00:00Z,{}\n",
  );
  const started = await enqueueImport(artifact);
  const childEnv = { ...process.env };
  for (const variable of [
    "ROOTSET_TEST_DATABASE_URL",
    "ROOTSET_TEST_APP_DATABASE_URL",
    "ROOTSET_TEST_DDL_DATABASE_URL",
    "ROOTSET_TEST_IDENTITY_DATABASE_URL",
    "ROOTSET_DATABASE_URL",
    "ROOTSET_DDL_DATABASE_URL",
    "ROOTSET_IDENTITY_DATABASE_URL",
    "ROOTSET_MIGRATION_DATABASE_URL",
  ]) {
    if (childEnv[variable]) {
      const url = new URL(childEnv[variable]!);
      url.pathname = `/${fixture.name}`;
      childEnv[variable] = url.toString();
    }
  }
  const child = fork(new URL("./worker-fixture.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    env: childEnv,
    silent: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Worker checkpoint was not reached: ${stderr}`)),
        10_000,
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`Worker exited before checkpoint: ${stderr}`));
      });
      child.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "point" in message &&
          message.point === "import.afterCommit"
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.send({ orgId: actor.orgId, artifacts: config.artifacts });
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    const crashed = await withOrg(
      ddlPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{
            state: string;
            progress: { committed: number };
            lease_token: string;
          }>(
            "SELECT state,progress,lease_token FROM rootset_control.jobs WHERE id=$1",
            [started.jobId],
          )
        ).rows[0]!,
    );
    assert.equal(crashed.state, "running");
    assert.equal(crashed.progress.committed, 2);
    await withOrg(ddlPool, actor.orgId, (client) =>
      client.query(
        "UPDATE rootset_control.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [started.jobId],
      ),
    );
    const completed = await terminal(started.jobId);
    assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
    assert.equal(completed.result?.committed, 3);
    const rows = await storage.queryRows(actor, table.id, {
      where: { field: "code", op: "prefix", value: "KILL" },
    });
    assert.equal(rows.data.length, 3);
    assert.ok(rows.data.every((row) => row.version === "1"));
    for (const row of rows.data) {
      const history = await storage.cellHistory(
        actor,
        table.id,
        row.id,
        table.fields[0]!.id,
        {},
      );
      assert.equal(history.data.length, 1);
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("BKP-01/02 JOB-05: duplicate scheduler admission persists one UTC occurrence and records overlap", async () => {
  await jobs.execute("setBackupPolicy", actor, {
    databaseId,
    enabled: true,
    cron: "* * * * *",
    timezone: "UTC",
    destination: "installation",
    retentionDays: 30,
    retentionCount: 10,
    encryption: true,
    maxRuntimeSeconds: 3600,
    notifications: false,
  });
  const due = new Date("2026-10-02T00:00:00Z");
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.backup_policies SET next_occurrence=$2 WHERE database_id=$1",
      [databaseId, due],
    ),
  );
  await Promise.all([
    jobs.scheduleDue(actor.orgId, due),
    jobs.scheduleDue(actor.orgId, due),
  ]);
  const occurrence = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ job_id: string }>(
          "SELECT o.job_id FROM rootset_control.backup_occurrences o JOIN rootset_control.backup_policies p ON p.id=o.policy_id WHERE p.database_id=$1 AND o.scheduled_at=$2",
          [databaseId, due],
        )
      ).rows,
  );
  assert.equal(occurrence.length, 1);
  assert.ok(occurrence[0]?.job_id);
  await jobs.scheduleDue(actor.orgId, new Date(due.getTime() + 60_000));
  const missed = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ state: string }>(
          "SELECT o.state FROM rootset_control.backup_occurrences o JOIN rootset_control.backup_policies p ON p.id=o.policy_id WHERE p.database_id=$1 AND o.scheduled_at=$2",
          [databaseId, new Date(due.getTime() + 60_000)],
        )
      ).rows[0],
  );
  assert.equal(missed?.state, "skipped_overlap");
  await jobs.execute("cancelJob", actor, { id: occurrence[0]!.job_id });
  await jobs.execute("setBackupPolicy", actor, {
    databaseId,
    enabled: false,
    cron: "* * * * *",
    timezone: "UTC",
    destination: "installation",
    retentionDays: 30,
    retentionCount: 10,
    encryption: true,
    maxRuntimeSeconds: 3600,
    notifications: false,
  });
});

test("BKP-08/09 JOB-02: replacement requires approval and resumes after durable cutover with target identity intact", async () => {
  const target = await storage.createDatabase(actor, {
    name: `Replacement ${newId()}`,
  });
  const targetTable = await storage.createTable(actor, target.id, {
    name: "Prior generation",
    fields: [{ apiKey: "name", label: "Name", type: "text", charLimit: 128 }],
    idempotencyKey: newId(),
  });
  const targetRow = await storage.createRow(
    actor,
    targetTable.id,
    { name: "Current recovery row" },
    { idempotencyKey: newId() },
  );
  const input = {
    databaseId,
    id: backupId,
    mode: "replace",
    targetDatabaseId: target.id,
  };
  await assert.rejects(
    jobs.execute("restoreBackup", actor, input, { idempotencyKey: newId() }),
    (error) =>
      error instanceof RootsetError && error.code === "STEP_UP_REQUIRED",
  );
  const started = (await jobs.execute("restoreBackup", actor, input, {
    idempotencyKey: newId(),
    stepUpApproved: true,
  })) as { jobId: string };
  let recoveryId: string | undefined;
  hook = async (point, jobId) => {
    if (point === "restore.beforeCutover" && jobId === started.jobId) {
      const publication = await withOrg(
        ddlPool,
        actor.orgId,
        async (client) =>
          (
            await client.query<{ recovery_backup_id: string; state: string }>(
              "SELECT state,recovery_backup_id FROM rootset_control.restore_publications WHERE job_id=$1",
              [jobId],
            )
          ).rows[0]!,
      );
      assert.equal(publication.state, "verified");
      recoveryId = publication.recovery_backup_id;
      const recovery = await jobs.backups.load(actor, recoveryId);
      const records = [];
      for await (const batch of jobs.backups
        .source(actor, recovery.manifest)
        .rows(targetTable.id))
        records.push(...batch);
      assert.equal(records[0]?.values.name, "Current recovery row");
      await assert.rejects(
        storage.updateRow(
          actor,
          targetTable.id,
          targetRow.id,
          { name: "Late write" },
          { expectedVersion: targetRow.version, idempotencyKey: newId() },
        ),
        (error) =>
          error instanceof RootsetError && error.code === "SCHEMA_MAINTENANCE",
      );
      await assert.rejects(
        storage.createField(actor, targetTable.id, {
          apiKey: "late",
          label: "Late",
          type: "boolean",
          expectedSchemaVersion: targetTable.schemaVersion,
          idempotencyKey: newId(),
        }),
        (error) =>
          error instanceof RootsetError && error.code === "SCHEMA_MAINTENANCE",
      );
      await assert.rejects(
        storage.releaseRestoreBarrier(actor, target.id, {
          jobId,
          leaseToken: newId(),
        }),
        (error) => error instanceof RootsetError && error.code === "JOB_FAILED",
      );
      await assert.rejects(
        withOrg(pool, actor.orgId, (client) =>
          client.query(
            `UPDATE "${targetTable.schemaName}"."${targetTable.physicalName}" SET updated_at=now() WHERE row_id=$1`,
            [targetRow.id],
          ),
        ),
        (error) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "55000",
      );
      hook = null;
    }
  };
  failPoint = "restore.afterCutover";
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.result?.databaseId, target.id);
  assert.ok(recoveryId);
  const publication = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ state: string; recovery_backup_id: string }>(
          "SELECT state,recovery_backup_id FROM rootset_control.restore_publications WHERE job_id=$1",
          [started.jobId],
        )
      ).rows[0]!,
  );
  assert.equal(publication.state, "published");
  assert.equal(publication.recovery_backup_id, recoveryId);
  const mapping = completed.result?.tableMapping as Record<string, string>;
  assert.ok(mapping[table.id]);
  const rows = await storage.queryRows(actor, mapping[table.id]!, {});
  assert.ok(rows.data.some((row) => row.values.code === "00001"));
  assert.equal((await storage.getDatabase(actor, target.id)).state, "active");
  assert.equal(
    await withOrg(
      ddlPool,
      actor.orgId,
      async (client) =>
        (
          await client.query(
            "SELECT 1 FROM rootset_control.restore_write_barriers WHERE database_id=$1",
            [target.id],
          )
        ).rowCount,
    ),
    0,
  );
});

test("BKP-09 JOB-03: cancelled replacement releases the owning barrier and retry takes a fresh recovery snapshot", async () => {
  const target = await storage.createDatabase(actor, {
    name: `Cancel restore ${newId()}`,
  });
  const targetTable = await storage.createTable(actor, target.id, {
    name: "Before replacement",
    fields: [{ apiKey: "name", label: "Name", type: "text", charLimit: 128 }],
    idempotencyKey: newId(),
  });
  const row = await storage.createRow(
    actor,
    targetTable.id,
    { name: "Initial" },
    { idempotencyKey: newId() },
  );
  const started = (await jobs.execute(
    "restoreBackup",
    actor,
    { databaseId, id: backupId, mode: "replace", targetDatabaseId: target.id },
    { idempotencyKey: newId(), stepUpApproved: true },
  )) as { jobId: string };
  let originalRecovery = "";
  hook = async (point, jobId) => {
    if (point === "restore.beforeCutover" && jobId === started.jobId) {
      hook = null;
      originalRecovery = await withOrg(
        ddlPool,
        actor.orgId,
        async (client) =>
          (
            await client.query<{ recovery_backup_id: string }>(
              "SELECT recovery_backup_id FROM rootset_control.restore_publications WHERE job_id=$1",
              [jobId],
            )
          ).rows[0]!.recovery_backup_id,
      );
      await jobs.execute("cancelJob", actor, { id: jobId });
    }
  };
  const cancelled = await terminal(started.jobId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(
    (await storage.getRow(actor, targetTable.id, row.id)).values.name,
    "Initial",
  );
  await storage.updateRow(
    actor,
    targetTable.id,
    row.id,
    { name: "New recovery content" },
    { expectedVersion: row.version, idempotencyKey: newId() },
  );
  hook = async (point, jobId) => {
    if (point === "restore.beforeCutover" && jobId === started.jobId) {
      hook = null;
      const recoveryId = await withOrg(
        ddlPool,
        actor.orgId,
        async (client) =>
          (
            await client.query<{ recovery_backup_id: string }>(
              "SELECT recovery_backup_id FROM rootset_control.restore_publications WHERE job_id=$1",
              [jobId],
            )
          ).rows[0]!.recovery_backup_id,
      );
      assert.notEqual(recoveryId, originalRecovery);
      const loaded = await jobs.backups.load(actor, recoveryId);
      const rows = [];
      for await (const batch of jobs.backups
        .source(actor, loaded.manifest)
        .rows(targetTable.id))
        rows.push(...batch);
      assert.equal(rows[0]?.values.name, "New recovery content");
    }
  };
  await jobs.execute("retryJob", actor, { id: started.jobId });
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.result?.databaseId, target.id);
});

test("IO-02: strict numeric lexemes preserve finite floats and reject rounded fractional integers or unsafe JSON numbers", async () => {
  const original = table;
  const isolated = await storage.createDatabase(actor, {
    name: `Lexemes ${newId()}`,
  });
  table = await storage.createTable(actor, isolated.id, {
    name: "Numbers",
    fields: [
      { apiKey: "code", label: "Code", type: "text", charLimit: 32 },
      { apiKey: "value", label: "Value", type: "integer" },
      { apiKey: "ratio", label: "Ratio", type: "float" },
      { apiKey: "payload", label: "Payload", type: "json" },
    ],
    idempotencyKey: newId(),
  });
  try {
    const csv = await upload(
      "code,value,ratio,payload\nvalid,7,1e100,{}\nfraction,9007199254740990.5,1,{}\n",
    );
    const csvJob = await enqueueImport(csv, {
      mapping: {
        code: "code",
        value: "value",
        ratio: "ratio",
        payload: "payload",
      },
    });
    const csvResult = await terminal(csvJob.jobId);
    assert.equal(csvResult.result?.committed, 1);
    assert.equal(csvResult.result?.rejected, 1);
    const jsonl = await upload(
      '{"code":"valid-jsonl","value":8,"ratio":1e100,"payload":{"id":"literal"}}\n{"code":"bad-json","value":8,"ratio":1,"payload":{"unsafe":9007199254740993}}\n',
      "jsonl",
    );
    const jsonJob = await enqueueImport(jsonl, {
      mapping: {
        code: "code",
        value: "value",
        ratio: "ratio",
        payload: "payload",
      },
    });
    const jsonResult = await terminal(jsonJob.jobId);
    assert.equal(jsonResult.result?.committed, 1);
    assert.equal(jsonResult.result?.rejected, 1);
    const rows = await storage.queryRows(actor, table.id, {});
    assert.equal(rows.data.length, 2);
    assert.ok(rows.data.every((row) => row.values.ratio === 1e100));
    assert.equal(
      rows.data.find((row) => row.values.code === "valid-jsonl")?.values
        .payload &&
        (
          rows.data.find((row) => row.values.code === "valid-jsonl")!.values
            .payload as Record<string, JsonValue>
        ).id,
      "literal",
    );
  } finally {
    table = original;
  }
});

test("IO-01/02: rejected dry-run records do not reserve tuples in another unique rule", async () => {
  const original = table;
  const isolated = await storage.createDatabase(actor, {
    name: `Dry rules ${newId()}`,
  });
  table = await storage.createTable(actor, isolated.id, {
    name: "Rules",
    fields: [
      { apiKey: "code", label: "Code", type: "text", charLimit: 32 },
      { apiKey: "name", label: "Name", type: "text", charLimit: 32 },
    ],
    idempotencyKey: newId(),
  });
  try {
    for (const field of table.fields) {
      await storage.createUniqueRule(actor, table.id, {
        name: field.apiKey,
        fieldIds: [field.id],
        expectedSchemaVersion: table.schemaVersion,
        idempotencyKey: newId(),
      });
      table = await storage.getTable(actor, table.id);
    }
    await storage.createRow(
      actor,
      table.id,
      { code: "existing", name: "taken" },
      { idempotencyKey: newId() },
    );
    const artifact = await upload("code,name\nfree,taken\nfree,available\n");
    const started = await enqueueImport(
      artifact,
      { mapping: { code: "code", name: "name" } },
      "validateImport",
    );
    const completed = await terminal(started.jobId);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.result?.valid, false);
    assert.equal(completed.result?.accepted, 1);
    assert.equal(completed.result?.rejected, 1);
    assert.equal((await storage.queryRows(actor, table.id, {})).data.length, 1);
  } finally {
    table = original;
  }
});

test("IO-02/05: invalid JSONL lines are reported at their exact line and later valid records remain importable", async () => {
  const content =
    '{ "code":"LINE001", "name":"First", "active":true, "instant":"2026-10-02T00:00:00Z", "payload":{} }\n{"code":"duplicate","code":"ambiguous"}\n{ "code":"LINE003", "name":"Third", "active":false, "instant":"2026-10-02T00:00:00Z", "payload":{} }\n';
  const artifact = await upload(content, "jsonl");
  const started = await enqueueImport(artifact);
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "partially_completed");
  assert.equal(completed.result?.committed, 2);
  assert.equal(completed.result?.rejected, 1);
  const report = await jobs.downloadArtifact(
    actor,
    String(completed.result?.rejectionArtifactId),
  );
  const chunks = [];
  for await (const chunk of report.stream) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks)
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { record: number; code: string });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.record, 2);
  assert.equal(
    (
      await storage.queryRows(actor, table.id, {
        where: { field: "code", op: "prefix", value: "LINE" },
      })
    ).data.length,
    2,
  );
});

test("JOB-04: metadata cursors bind request limits, filters and current grants", async () => {
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
      { ...actor, grantVersion: 2 },
      { limit: 1, cursor: first.nextCursor },
    ),
    (error) => error instanceof RootsetError && error.code === "CURSOR_INVALID",
  );
});

test("BKP-01 JOB-05: authority revocation suspends only its policy and saving an authorized policy clears suspension", async () => {
  const policy = {
    databaseId,
    enabled: true,
    cron: "* * * * *",
    timezone: "UTC",
    destination: "installation",
    retentionDays: 30,
    retentionCount: 10,
    encryption: true,
    maxRuntimeSeconds: 3600,
    notifications: false,
  };
  await jobs.execute("setBackupPolicy", actor, policy);
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.backup_policies SET next_occurrence=now()-interval '1 minute' WHERE database_id=$1",
      [databaseId],
    ),
  );
  currentAccess = false;
  try {
    assert.equal(await jobs.scheduleDue(actor.orgId), 0);
  } finally {
    currentAccess = true;
  }
  const suspended = (await jobs.execute("getBackupPolicy", actor, {
    databaseId,
  })) as {
    policy: { enabled: boolean; suspension: { code: string; at: string } };
  };
  assert.equal(suspended.policy.enabled, false);
  assert.equal(suspended.policy.suspension.code, "ACCESS_DENIED");
  assert.ok(suspended.policy.suspension.at.endsWith("Z"));
  await jobs.execute("setBackupPolicy", actor, { ...policy, enabled: false });
  const cleared = (await jobs.execute("getBackupPolicy", actor, {
    databaseId,
  })) as { policy: { suspension?: unknown } };
  assert.equal(cleared.policy.suspension, undefined);
});

test("BKP-01 JOB-04: scheduled policy authority is separate from a live manual credential and cannot be spoofed", async () => {
  let liveSession = true;
  let membership = true;
  const service = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      authorisePolicy: async (a) => {
        if (!membership)
          throw new RootsetError(
            "ACCESS_DENIED",
            "Policy membership was revoked",
            403,
          );
        return a;
      },
    },
    authorise: async (a) => {
      if (!liveSession)
        throw new RootsetError(
          "UNAUTHENTICATED",
          "Manual browser session expired",
          401,
        );
      return a;
    },
  });
  const policy = {
    databaseId,
    enabled: true,
    cron: "* * * * *",
    timezone: "UTC",
    destination: "installation",
    retentionDays: 30,
    retentionCount: 10,
    encryption: true,
    maxRuntimeSeconds: 3600,
    notifications: false,
  };
  await service.execute("setBackupPolicy", actor, policy);
  const manualDatabase = await storage.createDatabase(actor, {
    name: `Manual authority ${newId()}`,
  });
  const manual = (await service.execute(
    "createBackup",
    actor,
    { databaseId: manualDatabase.id },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const due = new Date("2026-10-03T00:00:00Z");
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.backup_policies SET next_occurrence=$2 WHERE database_id=$1",
      [databaseId, due],
    ),
  );
  liveSession = false;
  assert.equal(await service.scheduleDue(actor.orgId, due), 1);
  const scheduled = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ job_id: string }>(
          "SELECT o.job_id FROM rootset_control.backup_occurrences o JOIN rootset_control.backup_policies p ON p.id=o.policy_id WHERE p.database_id=$1 AND o.scheduled_at=$2",
          [databaseId, due],
        )
      ).rows[0]!.job_id,
  );
  await service.runOnce(actor.orgId);
  assert.equal(
    (
      (await jobs.execute("getJob", actor, { id: manual.jobId })) as {
        state: string;
        error: { code: string };
      }
    ).error.code,
    "UNAUTHENTICATED",
  );
  await service.runOnce(actor.orgId);
  const completed = (await jobs.execute("getJob", actor, {
    id: scheduled,
  })) as { state: string; result: { backupId: string } };
  assert.equal(completed.state, "succeeded");
  await deleteBackup(databaseId, completed.result.backupId);
  const forged = await service.queue.enqueue(
    actor,
    "createBackup",
    "backup",
    { type: "database", id: databaseId },
    { policyId: newId(), scheduledAt: due.toISOString() },
    newId(),
  );
  await service.runOnce(actor.orgId);
  assert.equal(
    (
      (await jobs.execute("getJob", actor, { id: forged.id })) as {
        error: { code: string };
      }
    ).error.code,
    "ACCESS_DENIED",
  );
  membership = false;
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.backup_policies SET next_occurrence=$2 WHERE database_id=$1",
      [databaseId, new Date(due.getTime() + 60000)],
    ),
  );
  assert.equal(
    await service.scheduleDue(actor.orgId, new Date(due.getTime() + 60000)),
    0,
  );
  const revoked = (await jobs.execute("getBackupPolicy", actor, {
    databaseId,
  })) as { policy: { suspension: { code: string } } };
  assert.equal(revoked.policy.suspension.code, "ACCESS_DENIED");
  await jobs.execute("setBackupPolicy", actor, { ...policy, enabled: false });
});

test("JOB-02/04 IO-09: an expired uploader cannot overwrite the artifact produced by its replacement lease", async () => {
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

test("IO-06/08: CSV roundtrip distinguishes null, empty text, literal null markers and backslashes", async () => {
  const original = table;
  const isolated = await storage.createDatabase(actor, {
    name: `CSV literals ${newId()}`,
  });
  const fields = [
    { apiKey: "name", label: "Name", type: "text" as const, charLimit: 128 },
  ];
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
  table = await storage.createTable(actor, isolated.id, {
    name: "Roundtrip",
    fields,
    idempotencyKey: newId(),
  });
  try {
    const artifact = await upload(csv);
    const imported = await enqueueImport(artifact, {
      mapping: { name: "name" },
    });
    const completed = await terminal(imported.jobId);
    assert.equal(completed.state, "succeeded");
    const rows = await storage.queryRows(actor, table.id, {});
    assert.deepEqual(
      rows.data
        .map((row) => row.values.name)
        .sort((a, b) => String(a).localeCompare(String(b))),
      values.sort((a, b) => String(a).localeCompare(String(b))),
    );
  } finally {
    table = original;
  }
});

test("IO-01/09 JOB-04: upload admission and artifact retrieval enforce declared bytes, checksum, expiry and current access", async () => {
  const content =
    "code,name,active,instant,payload\nBOUND001,Bounded,true,2026-10-02T00:00:00Z,{}\n";
  const input = {
    tableId: table.id,
    format: "csv",
    byteLength: Buffer.byteLength(content),
    checksum: createHash("sha256").update(content).digest("hex"),
  };
  const key = newId();
  const prepare = (await jobs.execute("prepareImportUpload", actor, input, {
    idempotencyKey: key,
  })) as {
    artifactId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  };
  const replay = (await jobs.execute("prepareImportUpload", actor, input, {
    idempotencyKey: key,
  })) as { artifactId: string };
  assert.equal(prepare.artifactId, replay.artifactId);
  await assert.rejects(
    jobs.execute(
      "prepareImportUpload",
      actor,
      { ...input, byteLength: 134217729 },
      { idempotencyKey: newId() },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "PAYLOAD_TOO_LARGE",
  );
  const raw = await jobs.artifacts.get(actor, prepare.artifactId);
  await jobs.artifacts.client.send(
    new PutObjectCommand({
      Bucket: config.artifacts.bucket,
      Key: raw.object_key,
      Body: content + "extra",
    }),
  );
  const oversized = await enqueueImport(raw.id);
  const failed = await terminal(oversized.jobId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "PAYLOAD_TOO_LARGE");
  const checksum = (await jobs.execute(
    "prepareImportUpload",
    actor,
    { ...input, checksum: "0".repeat(64) },
    { idempotencyKey: newId() },
  )) as {
    artifactId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  };
  assert.equal(
    (
      await fetch(checksum.uploadUrl, {
        method: "PUT",
        headers: checksum.headers,
        body: content,
      })
    ).status,
    200,
  );
  const checksumJob = await enqueueImport(checksum.artifactId);
  const corrupt = await terminal(checksumJob.jobId);
  assert.equal(corrupt.state, "failed");
  assert.equal(corrupt.error?.code, "VALIDATION_FAILED");
  const empty = (await jobs.execute("prepareImportUpload", actor, input, {
    idempotencyKey: newId(),
  })) as { artifactId: string };
  const incomplete = await enqueueImport(empty.artifactId);
  const missing = await terminal(incomplete.jobId);
  assert.equal(missing.state, "failed");
  assert.equal(missing.error?.code, "ARTIFACT_INCOMPLETE");
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.artifacts SET expires_at=now()-interval '1 second' WHERE id=$1",
      [empty.artifactId],
    ),
  );
  await assert.rejects(
    jobs.execute("getArtifact", actor, { id: empty.artifactId }),
    (error) =>
      error instanceof RootsetError && error.code === "ARTIFACT_EXPIRED",
  );
  const exportJob = (await jobs.execute(
    "exportRows",
    actor,
    { tableId: table.id, format: "jsonl" },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const exported = await terminal(exportJob.jobId);
  const exportId = String(exported.result?.artifactId);
  const denied = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      artifacts: {
        ...config.artifacts,
        secretAccessKey: "wrong-fixture-object-secret",
      },
    },
  });
  await assert.rejects(
    denied.downloadArtifact(actor, exportId),
    (error) =>
      error instanceof RootsetError &&
      error.code === "ARTIFACT_PERMISSION_DENIED",
  );
  currentAccess = false;
  try {
    await assert.rejects(
      jobs.downloadArtifact(actor, exportId),
      (error) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
  } finally {
    currentAccess = true;
  }
  await assert.rejects(
    jobs.downloadArtifact({ ...actor, orgId: newId() }, exportId),
    (error) =>
      error instanceof RootsetError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("BKP-10/13: isolated verification cleanup failure is observable and retry removes the namespace before success", async () => {
  const started = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  failPoint = "backup.beforeCleanup";
  const failed = await terminal(started.jobId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "BACKUP_UNVERIFIED");
  const records = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{
          id: string;
          cleanup_error: { databaseId: string };
        }>(
          "SELECT id,cleanup_error FROM rootset_control.backups WHERE job_id=$1",
          [started.jobId],
        )
      ).rows[0]!,
  );
  assert.ok(records.cleanup_error.databaseId);
  const visible = (await jobs.execute("getBackup", actor, {
    databaseId,
    id: records.id,
  })) as { state: string; cleanupError: { code: string } };
  assert.equal(visible.state, "failed");
  assert.equal(visible.cleanupError.code, "CLEANUP_FAILED");
  await jobs.execute("retryJob", actor, { id: started.jobId });
  const completed = await terminal(started.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  const cleaned = (await jobs.execute("getBackup", actor, {
    databaseId,
    id: records.id,
  })) as { cleanupError?: unknown; notificationState: string };
  assert.equal(cleaned.cleanupError, undefined);
  assert.equal(cleaned.notificationState, "disabled");
  const staged = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query(
          "SELECT 1 FROM rootset_control.databases WHERE id=$1 AND state='creating'",
          [records.cleanup_error.databaseId],
        )
      ).rowCount,
  );
  assert.equal(staged, 0);
  await deleteBackup(databaseId, records.id);
});

test("BKP-06/07/12 IO-09: last verified recovery point is protected, corrupted artifact and missing recovery key cannot restore", async () => {
  const protectedDeletion = (await jobs.execute("deleteBackup", actor, {
    databaseId,
    id: backupId,
  })) as { jobId: string };
  const protectedOutcome = await terminal(protectedDeletion.jobId);
  assert.equal(protectedOutcome.state, "failed");
  assert.equal(protectedOutcome.error?.code, "BACKUP_UNVERIFIED");
  const loaded = await jobs.backups.load(actor, backupId);
  const artifact = await jobs.artifacts.get(
    actor,
    loaded.manifest.rows[0]!.artifactId,
  );
  const missing = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      artifacts: {
        ...config.artifacts,
        activeKeyId: "rotated",
        encryptionKeys: { rotated: randomBytes(32).toString("base64") },
      },
    },
  });
  await assert.rejects(
    missing.backups.load(actor, backupId),
    (error) =>
      error instanceof RootsetError && error.code === "CONFIGURATION_INVALID",
  );
  await jobs.artifacts.client.send(
    new PutObjectCommand({
      Bucket: config.artifacts.bucket,
      Key: artifact.object_key,
      Body: Buffer.from("corrupted"),
    }),
  );
  await assert.rejects(
    jobs.execute("previewRestore", actor, {
      databaseId,
      id: backupId,
      mode: "new",
    }),
    (error) =>
      error instanceof RootsetError && error.code === "BACKUP_UNVERIFIED",
  );
});

test("AUD-09 BKP-05/12 JOB-03: verified archive survives interrupted purge and database backup embeds complete cold history", async () => {
  const database = await storage.createDatabase(actor, {
    name: `History archive ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "History rows",
    fields: [
      { apiKey: "code", label: "Code", type: "text", charLimit: 32 },
      { apiKey: "payload", label: "Payload", type: "json" },
    ],
    idempotencyKey: newId(),
  });
  let deep: JsonValue = { id: "literal" };
  for (let depth = 0; depth < 31; depth++) deep = { nested: deep };
  for (let offset = 0; offset < 2001; offset += 1000)
    await storage.mutateRows(actor, target.id, {
      operations: Array.from(
        { length: Math.min(1000, 2001 - offset) },
        (_, index) => ({
          kind: "create" as const,
          values: { code: `ARCH${offset + index}`, payload: deep },
        }),
      ),
      idempotencyKey: newId(),
    });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cutoff = new Date().toISOString();
  const original = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ cells: string; rows: string }>(
          "SELECT (SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1)::text AS cells,(SELECT count(*) FROM rootset_control.row_events WHERE table_id=$1)::text AS rows",
          [target.id],
        )
      ).rows[0]!,
  );
  const defaultPolicy = (await jobs.execute(
    "getHistoryRetentionPolicy",
    actor,
    { tableId: target.id },
  )) as { enabled: boolean };
  assert.equal(defaultPolicy.enabled, false);
  const started = (await jobs.execute(
    "archiveHistory",
    actor,
    { tableId: target.id, before: cutoff },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  failPoint = "archive.afterPurgeBatch";
  await jobs.runOnce(actor.orgId);
  const checkpoint = (await jobs.execute("getJob", actor, {
    id: started.jobId,
  })) as { state: string };
  assert.equal(checkpoint.state, "queued");
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.jobs SET next_attempt_at=now()+interval '1 hour' WHERE id=$1",
      [started.jobId],
    ),
  );
  const partial = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{
          state: string;
          cell_count: string;
          purged_cells: string;
        }>("SELECT * FROM rootset_control.history_archives WHERE job_id=$1", [
          started.jobId,
        ])
      ).rows[0]!,
  );
  assert.equal(partial.state, "purging");
  assert.ok(
    Number(partial.purged_cells) > 0 &&
      Number(partial.purged_cells) < Number(partial.cell_count),
  );
  const backed = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId: database.id },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const completedBackup = await terminal(backed.jobId);
  assert.equal(
    completedBackup.state,
    "succeeded",
    JSON.stringify(completedBackup.error),
  );
  const loaded = await jobs.backups.load(
    actor,
    String(completedBackup.result?.backupId),
  );
  assert.equal(loaded.manifest.archiveReferences.length, 1);
  let cells = 0,
    rows = 0;
  for await (const batch of jobs.backups
    .source(actor, loaded.manifest)
    .history())
    for (const event of batch) {
      if (event.recordType === "cell") cells++;
      if (event.recordType === "row") rows++;
    }
  assert.equal(cells, Number(original.cells));
  assert.equal(rows, Number(original.rows));
  const restored = (await jobs.execute(
    "restoreBackup",
    actor,
    {
      databaseId: database.id,
      id: loaded.backup.id,
      mode: "new",
      name: "Cold history materialized",
    },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const restoredJob = await terminal(restored.jobId);
  assert.equal(
    restoredJob.state,
    "succeeded",
    JSON.stringify(restoredJob.error),
  );
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.jobs SET next_attempt_at=now() WHERE id=$1",
      [started.jobId],
    ),
  );
  const archived = await terminal(started.jobId);
  assert.equal(archived.state, "succeeded", JSON.stringify(archived.error));
  const list = (await jobs.execute("listHistoryArchives", actor, {
    tableId: target.id,
    limit: 1,
  })) as { data: Array<{ state: string; artifactId: string }> };
  assert.equal(list.data[0]!.state, "succeeded");
  const counts = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ cells: string; rows: string }>(
          "SELECT (SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1)::text AS cells,(SELECT count(*) FROM rootset_control.row_events WHERE table_id=$1)::text AS rows",
          [target.id],
        )
      ).rows[0]!,
  );
  assert.equal(counts.cells, "0");
  assert.equal(counts.rows, "0");
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.artifacts SET expires_at=now()-interval '1 day',created_at=now()-interval '3 days' WHERE id=$1",
      [list.data[0]!.artifactId],
    ),
  );
  await jobs.cleanupArtifacts(actor.orgId);
  const retained = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ state: string }>(
          "SELECT state FROM rootset_control.artifacts WHERE id=$1",
          [list.data[0]!.artifactId],
        )
      ).rows[0]!,
  );
  assert.equal(retained.state, "ready");
});

test("JOB-03 BKP-10: cancelling a queued committed backup returns its durable success", async () => {
  const run = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  failPoint = "job.beforeFinish";
  await jobs.runOnce(actor.orgId);
  const cancelled = (await jobs.execute(
    "cancelJob",
    actor,
    { id: run.jobId },
    { idempotencyKey: newId() },
  )) as { state: string; result: { backupId: string } };
  assert.equal(cancelled.state, "succeeded");
  assert.ok(cancelled.result.backupId);
});

test("AUD-09 BKP-12: corrupt history archive is refused before gap publication or any hot deletion", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Corrupt history ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Protected events",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    target.id,
    { value: "must survive" },
    { idempotencyKey: newId() },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const beforeCount = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ count: string }>(
          "SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1",
          [target.id],
        )
      ).rows[0]!.count,
  );
  hook = async (point, jobId) => {
    if (point !== "archive.afterUpload") return;
    const artifact = await withOrg(
      ddlPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{ object_key: string }>(
            "SELECT a.object_key FROM rootset_control.artifacts a JOIN rootset_control.history_archives h ON h.artifact_id=a.id WHERE h.job_id=$1",
            [jobId],
          )
        ).rows[0]!,
    );
    await jobs.artifacts.client.send(
      new PutObjectCommand({
        Bucket: config.artifacts.bucket,
        Key: artifact.object_key,
        Body: Buffer.from("corrupt archive"),
      }),
    );
  };
  const started = (await jobs.execute(
    "archiveHistory",
    actor,
    { tableId: target.id, before: new Date().toISOString() },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  let failed;
  try {
    failed = await terminal(started.jobId);
  } finally {
    hook = null;
  }
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "BACKUP_UNVERIFIED");
  const afterState = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ count: string; gaps: string }>(
          "SELECT (SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1)::text AS count,(SELECT count(*) FROM rootset_control.history_gaps WHERE table_id=$1)::text AS gaps",
          [target.id],
        )
      ).rows[0]!,
  );
  assert.equal(afterState.count, beforeCount);
  assert.equal(afterState.gaps, "0");
});

test("ACC-11 BKP-06/13 JOB-03: configured deleted-organisation retention resumes owned cleanup and preserves unrelated objects and tombstones", async () => {
  const retired = { ...actor, orgId: newId() };
  await owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [retired.orgId, "Deleted retention fixture"],
  );
  const database = await storage.createDatabase(retired, {
    name: "Retired data",
  });
  const target = await storage.createTable(retired, database.id, {
    name: "Retired rows",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    retired,
    target.id,
    { value: "expired payload" },
    { idempotencyKey: newId() },
  );
  let policy = {
    organisationDays: null as number | null,
    accountAuditDays: null as number | null,
  };
  const maintenance = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      deletionRetention: async () => policy,
      deletionMetadata: (orgId) =>
        withOrg(
          ddlPool,
          orgId,
          async (client) =>
            (
              await client.query<{
                metadata: { organisationDeletedAt: string | null };
              }>("SELECT rootset_control.deletion_metadata($1) AS metadata", [
                orgId,
              ])
            ).rows[0]!.metadata,
        ),
      purgeAccountAudit: (orgId, before, client) =>
        client
          ? client
              .query<{ removed: number }>(
                "SELECT rootset_control.purge_retained_account_audit($1,$2) AS removed",
                [orgId, before],
              )
              .then((result) => result.rows[0]!.removed)
          : withOrg(
              ddlPool,
              orgId,
              async (c) =>
                (
                  await c.query<{ removed: number }>(
                    "SELECT rootset_control.purge_retained_account_audit($1,$2) AS removed",
                    [orgId, before],
                  )
                ).rows[0]!.removed,
            ),
    },
  });
  const exported = (await maintenance.execute(
    "exportRows",
    retired,
    { tableId: target.id, format: "jsonl" },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  await maintenance.runOnce(retired.orgId);
  const exportState = await withOrg(
    ddlPool,
    retired.orgId,
    async (client) =>
      (
        await client.query<{ state: string }>(
          "SELECT state FROM rootset_control.jobs WHERE id=$1",
          [exported.jobId],
        )
      ).rows[0]!.state,
  );
  assert.equal(exportState, "succeeded");
  const unrelated = (await jobs.execute(
    "exportRows",
    actor,
    { tableId: table.id, format: "jsonl" },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const unrelatedJob = await terminal(unrelated.jobId);
  assert.equal(unrelatedJob.state, "succeeded");
  const unrelatedId = String(unrelatedJob.result?.artifactId);
  await owner.query(
    "INSERT INTO rootset_control.account_audit(id,org_id,actor_kind,actor_id,operation,target_id,outcome,created_at) VALUES($1,$2::varchar(26),'operator',$3,'deleteOrganisation',$2::varchar(26),'{\"state\":\"deleted\"}',now()-interval '3 days')",
    [newId(), retired.orgId, actor.id],
  );
  await owner.query(
    "UPDATE rootset_control.organisations SET state='deleted' WHERE id=$1",
    [retired.orgId],
  );
  assert.equal(await maintenance.scheduleMaintenance(retired.orgId), 0);
  const untouched = await withOrg(
    ddlPool,
    retired.orgId,
    async (client) =>
      (
        await client.query<{ count: string }>(
          "SELECT count(*) FROM rootset_control.artifacts WHERE state='ready'",
        )
      ).rows[0]!.count,
  );
  assert.equal(untouched, "1");
  assert.ok(
    (
      await ddlPool.query<{ id: string }>(
        "SELECT id FROM rootset_control.maintenance_org_directory()",
      )
    ).rows.some((row) => row.id === retired.orgId),
  );
  await assert.rejects(
    pool.query("SELECT rootset_control.deletion_metadata($1)", [retired.orgId]),
    (error) => (error as { code: string }).code === "42501",
  );
  await assert.rejects(
    withOrg(ddlPool, actor.orgId, (client) =>
      client.query("SELECT rootset_control.deletion_metadata($1)", [
        retired.orgId,
      ]),
    ),
    (error) => (error as { code: string }).code === "42501",
  );
  policy = { organisationDays: 1, accountAuditDays: null };
  assert.equal(await maintenance.scheduleMaintenance(retired.orgId), 1);
  failPoint = "retention.afterArtifactDelete";
  await maintenance.runOnce(retired.orgId);
  const run = await withOrg(
    ddlPool,
    retired.orgId,
    async (client) =>
      (
        await client.query<{
          id: string;
          state: string;
          checkpoint: { deletedArtifacts: number };
        }>(
          "SELECT * FROM rootset_control.jobs WHERE kind='organisation_retention'",
        )
      ).rows[0]!,
  );
  assert.equal(run.state, "queued");
  assert.equal(run.checkpoint.deletedArtifacts, 1);
  await withOrg(ddlPool, retired.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.jobs SET next_attempt_at=now() WHERE id=$1",
      [run.id],
    ),
  );
  await maintenance.runOnce(retired.orgId);
  const outcome = await withOrg(
    ddlPool,
    retired.orgId,
    async (client) =>
      (
        await client.query<{
          state: string;
          result: { deletedArtifacts: number; retainedTombstones: boolean };
        }>("SELECT state,result FROM rootset_control.jobs WHERE id=$1", [
          run.id,
        ])
      ).rows[0]!,
  );
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.result.deletedArtifacts, 1);
  assert.equal(outcome.result.retainedTombstones, true);
  const remaining = await withOrg(
    ddlPool,
    retired.orgId,
    async (client) =>
      (
        await client.query<{ artifacts: string; cells: string; rows: string }>(
          "SELECT (SELECT count(*) FROM rootset_control.artifacts WHERE state<>'deleted')::text AS artifacts,(SELECT count(*) FROM rootset_control.cell_changes)::text AS cells,(SELECT count(*) FROM rootset_control.row_events)::text AS rows",
        )
      ).rows[0]!,
  );
  assert.deepEqual(remaining, { artifacts: "0", cells: "0", rows: "0" });
  assert.equal(
    (
      await owner.query<{ state: string }>(
        "SELECT state FROM rootset_control.organisations WHERE id=$1",
        [retired.orgId],
      )
    ).rows[0]!.state,
    "deleted",
  );
  assert.equal(
    (
      await owner.query<{ count: string }>(
        "SELECT count(*) FROM rootset_control.account_audit WHERE org_id=$1 AND operation='deleteOrganisation'",
        [retired.orgId],
      )
    ).rows[0]!.count,
    "1",
  );
  const download = await jobs.downloadArtifact(actor, unrelatedId);
  let downloaded = 0;
  for await (const chunk of download.stream)
    downloaded += Buffer.byteLength(chunk);
  assert.ok(downloaded > 0);
  assert.ok(
    !(
      await ddlPool.query<{ id: string }>(
        "SELECT id FROM rootset_control.maintenance_org_directory()",
      )
    ).rows.some((row) => row.id === retired.orgId),
  );
});

test("ACC-10 AUD-09 JOB-03: audit expiry requires a permanent deletion marker and commits its checkpoint with the bounded purge", async () => {
  const deletedUser = newId(),
    disabledOnly = newId(),
    activeUser = newId();
  for (const userId of [deletedUser, disabledOnly, activeUser])
    await owner.query(
      "INSERT INTO rootset_control.account_audit(id,org_id,actor_kind,actor_id,user_id,operation,outcome,created_at) VALUES($1,$2,'operator',$3,$4,'updateProfile','{}',now()-interval '4 days')",
      [newId(), actor.orgId, actor.id, userId],
    );
  await owner.query(
    "INSERT INTO rootset_control.account_audit(id,org_id,actor_kind,actor_id,user_id,operation,target_id,outcome,created_at) VALUES($1,$2,'operator',$3,$4::varchar(26),'deleteAccount',$4::varchar(26),'{\"state\":\"deleted\",\"retainedActorIdentity\":true}',now()-interval '3 days')",
    [newId(), actor.orgId, actor.id, deletedUser],
  );
  const maintenance = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      deletionRetention: async () => ({
        organisationDays: null,
        accountAuditDays: 1,
      }),
      purgeAccountAudit: async (orgId, before, client) => {
        assert.ok(client);
        return (
          await client.query<{ removed: number }>(
            "SELECT rootset_control.purge_retained_account_audit($1,$2) AS removed",
            [orgId, before],
          )
        ).rows[0]!.removed;
      },
    },
  });
  assert.equal(await maintenance.scheduleMaintenance(actor.orgId), 1);
  failPoint = "retention.afterAuditBatch";
  await maintenance.runOnce(actor.orgId);
  const run = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{
          id: string;
          state: string;
          checkpoint: { deletedAuditRecords: number };
        }>(
          "SELECT * FROM rootset_control.jobs WHERE kind='account_audit_retention'",
        )
      ).rows[0]!,
  );
  assert.equal(run.state, "queued");
  assert.equal(run.checkpoint.deletedAuditRecords, 1);
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.jobs SET next_attempt_at=now() WHERE id=$1",
      [run.id],
    ),
  );
  await maintenance.runOnce(actor.orgId);
  const result = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{
          state: string;
          result: { deletedAuditRecords: number };
        }>("SELECT state,result FROM rootset_control.jobs WHERE id=$1", [
          run.id,
        ])
      ).rows[0]!,
  );
  assert.equal(result.state, "succeeded");
  assert.equal(result.result.deletedAuditRecords, 1);
  const retained = (
    await owner.query<{ user_id: string; operation: string }>(
      "SELECT user_id,operation FROM rootset_control.account_audit WHERE user_id=ANY($1::text[])",
      [[deletedUser, disabledOnly, activeUser]],
    )
  ).rows;
  assert.equal(retained.length, 3);
  assert.ok(
    retained.some(
      (row) => row.user_id === deletedUser && row.operation === "deleteAccount",
    ),
  );
  assert.ok(
    retained.some(
      (row) =>
        row.user_id === disabledOnly && row.operation === "updateProfile",
    ),
  );
  assert.ok(
    retained.some(
      (row) => row.user_id === activeUser && row.operation === "updateProfile",
    ),
  );
});

test("IO-01/09 JOB-04: same-origin streaming upload preserves exact replay, bounded source checks and current authority", async () => {
  let denyEncryptionFor: string | undefined;
  const transfer = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      artifacts: {
        ...config.artifacts,
        uploadBaseURL: "http://127.0.0.1:3000",
      },
    },
    authorise: async (a) => {
      if (!currentAccess)
        throw new RootsetError("ACCESS_DENIED", "Upload access revoked", 403);
      if (denyEncryptionFor) {
        const pending = await withOrg(
          pool,
          a.orgId,
          async (client) =>
            (
              await client.query<{ metadata: Record<string, unknown> }>(
                "SELECT metadata FROM rootset_control.artifacts WHERE id=$1",
                [denyEncryptionFor],
              )
            ).rows[0],
        );
        if (pending?.metadata.uploadedObjectKey)
          throw new RootsetError(
            "ACCESS_DENIED",
            "Upload authority revoked before encrypted publication",
            403,
          );
      }
      return a;
    },
  });
  const content =
    "code,name,active,instant,payload\nPROXY01,Same origin,true,2026-10-02T00:00:00Z,{}\n";
  const prepared = (await transfer.execute(
    "prepareImportUpload",
    actor,
    {
      tableId: table.id,
      format: "csv",
      byteLength: Buffer.byteLength(content),
      checksum: createHash("sha256").update(content).digest("hex"),
    },
    { idempotencyKey: newId() },
  )) as {
    artifactId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  };
  assert.equal(new URL(prepared.uploadUrl).origin, "http://127.0.0.1:3000");
  assert.equal(prepared.headers["content-type"], "application/octet-stream");
  const source = async function* () {
    yield Buffer.from(content.slice(0, 20));
    yield Buffer.from(content.slice(20));
  };
  const receipt = await transfer.uploadArtifact(
    actor,
    prepared.artifactId,
    source(),
  );
  assert.equal(receipt.byteLength, Buffer.byteLength(content));
  const uploadedMetadata = (await transfer.execute(
    "getArtifact",
    actor,
    { id: prepared.artifactId },
    {},
  )) as { downloadUrl: string; checksum: string };
  assert.equal(uploadedMetadata.checksum, receipt.checksum);
  const immediatelyReadable = await transfer.downloadArtifact(
    actor,
    prepared.artifactId,
  );
  const immediatelyRead: Buffer[] = [];
  for await (const part of immediatelyReadable.stream)
    immediatelyRead.push(Buffer.from(part));
  assert.equal(Buffer.concat(immediatelyRead).toString(), content);
  assert.deepEqual(
    await transfer.uploadArtifact(actor, prepared.artifactId, source()),
    receipt,
  );
  await assert.rejects(
    transfer.uploadArtifact(
      actor,
      prepared.artifactId,
      (async function* () {
        yield Buffer.from(content.replace("PROXY01", "PROXY02"));
      })(),
    ),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const run = (await transfer.execute(
    "importRows",
    actor,
    {
      tableId: table.id,
      artifactId: prepared.artifactId,
      expectedSchemaVersion: (await storage.getTable(actor, table.id))
        .schemaVersion,
      mapping: {
        code: "code",
        name: "name",
        active: "active",
        instant: "instant",
        payload: "payload",
      },
      mode: "create",
      batchSize: 2,
    },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const imported = await terminal(run.jobId, transfer);
  assert.equal(imported.state, "succeeded", JSON.stringify(imported.error));
  assert.equal(imported.result?.committed, 1);
  const incomplete = (await transfer.execute(
    "prepareImportUpload",
    actor,
    { tableId: table.id, format: "csv", byteLength: 10 },
    { idempotencyKey: newId() },
  )) as { artifactId: string };
  await assert.rejects(
    transfer.uploadArtifact(
      actor,
      incomplete.artifactId,
      (async function* () {
        yield Buffer.from("short");
      })(),
    ),
    (error) =>
      error instanceof RootsetError && error.code === "VALIDATION_FAILED",
  );
  await assert.rejects(
    transfer.uploadArtifact(
      actor,
      incomplete.artifactId,
      (async function* () {
        yield Buffer.alloc(11);
      })(),
    ),
    (error) =>
      error instanceof RootsetError && error.code === "PAYLOAD_TOO_LARGE",
  );
  const revoked = (await transfer.execute(
    "prepareImportUpload",
    actor,
    { tableId: table.id, format: "csv", byteLength: 10 },
    { idempotencyKey: newId() },
  )) as { artifactId: string };
  try {
    await assert.rejects(
      transfer.uploadArtifact(
        actor,
        revoked.artifactId,
        (async function* () {
          yield Buffer.from("01234");
          currentAccess = false;
          yield Buffer.from("56789");
        })(),
      ),
      (error) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
  } finally {
    currentAccess = true;
  }
  const metadata = await jobs.artifacts.get(actor, revoked.artifactId);
  assert.equal(metadata.metadata.uploadedObjectKey, undefined);
  assert.equal(metadata.metadata.httpUploadToken, undefined);
  const encryptionRevoked = (await transfer.execute(
    "prepareImportUpload",
    actor,
    { tableId: table.id, format: "csv", byteLength: 10 },
    { idempotencyKey: newId() },
  )) as { artifactId: string };
  denyEncryptionFor = encryptionRevoked.artifactId;
  const tenBytes = async function* () {
    yield Buffer.from("0123456789");
  };
  try {
    await assert.rejects(
      transfer.uploadArtifact(actor, encryptionRevoked.artifactId, tenBytes()),
      (error) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
  } finally {
    denyEncryptionFor = undefined;
  }
  const unencrypted = await transfer.artifacts.get(
    actor,
    encryptionRevoked.artifactId,
  );
  assert.equal(unencrypted.metadata.finalizedArtifactId, undefined);
  assert.ok(unencrypted.metadata.uploadedObjectKey);
  await assert.rejects(
    transfer.artifacts.finalizeUpload(actor, unencrypted, null, {
      deadlineAt: Date.now() - 1,
    }),
    (error) =>
      error instanceof RootsetError && error.code === "ARTIFACT_EXPIRED",
  );
  await transfer.uploadArtifact(
    actor,
    encryptionRevoked.artifactId,
    tenBytes(),
  );
  const encrypted = await transfer.artifacts.get(
    actor,
    encryptionRevoked.artifactId,
  );
  assert.ok(encrypted.metadata.finalizedArtifactId);
});

test("JOB-04 IO-04: authority loss between committed import batches stops further mutations with an exact partial outcome", async () => {
  const artifact = await upload(
    "code,name,active,instant,payload\nREVOKE01,First,true,2026-10-02T00:00:00Z,{}\nREVOKE02,Second,true,2026-10-02T00:00:00Z,{}\nREVOKE03,Forbidden,true,2026-10-02T00:00:00Z,{}\n",
  );
  const run = await enqueueImport(artifact);
  hook = async (point) => {
    if (point === "import.afterCommit") currentAccess = false;
  };
  try {
    await jobs.runOnce(actor.orgId);
  } finally {
    currentAccess = true;
    hook = null;
  }
  const result = (await jobs.execute("getJob", actor, { id: run.jobId })) as {
    state: string;
    result: { committed: number };
    error: { code: string };
  };
  assert.equal(result.state, "partially_completed");
  assert.equal(result.result.committed, 2);
  assert.equal(result.error.code, "ACCESS_DENIED");
  const rows = (
    await storage.queryRows(actor, table.id, { limit: 1000 })
  ).data.filter((row) => String(row.values.code).startsWith("REVOKE"));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.version === "1"));
  await jobs.execute("retryJob", actor, { id: run.jobId });
  const completed = await terminal(run.jobId);
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result?.committed, 3);
});

test("JOB-02/04 BKP-10: committed verified backup reconciles after a completion crash without reusing revoked authority", async () => {
  const run = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  failPoint = "job.beforeFinish";
  await jobs.runOnce(actor.orgId);
  const journal = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{ state: string; verified_at: Date }>(
          "SELECT state,verified_at FROM rootset_control.backups WHERE job_id=$1",
          [run.jobId],
        )
      ).rows[0]!,
  );
  assert.equal(journal.state, "succeeded");
  assert.ok(journal.verified_at);
  await withOrg(ddlPool, actor.orgId, (client) =>
    client.query(
      "UPDATE rootset_control.jobs SET state='running',attempt=max_attempts,lease_until=now()-interval '1 second',next_attempt_at=now() WHERE id=$1",
      [run.jobId],
    ),
  );
  currentAccess = false;
  try {
    await jobs.runOnce(actor.orgId);
  } finally {
    currentAccess = true;
  }
  const reconciled = (await jobs.execute("getJob", actor, {
    id: run.jobId,
  })) as { state: string; result: { verifiedAt: string } };
  assert.equal(reconciled.state, "succeeded");
  assert.equal(reconciled.result.verifiedAt, journal.verified_at.toISOString());
});

test("BKP-09/12 JOB-03: terminal recovery-backup failure aborts replacement and releases its target write barrier", async () => {
  const source = await storage.createDatabase(actor, {
    name: `Recovery source ${newId()}`,
  });
  const sourceTable = await storage.createTable(actor, source.id, {
    name: "Source",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    sourceTable.id,
    { value: "source" },
    { idempotencyKey: newId() },
  );
  const backupRun = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId: source.id },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const backed = await terminal(backupRun.jobId);
  assert.equal(backed.state, "succeeded");
  const target = await storage.createDatabase(actor, {
    name: `Protected target ${newId()}`,
  });
  const targetTable = await storage.createTable(actor, target.id, {
    name: "Target",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  const existing = await storage.createRow(
    actor,
    targetTable.id,
    { value: "original target" },
    { idempotencyKey: newId() },
  );
  hook = async (point) => {
    if (point === "backup.beforeValidation")
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Forced recovery validation failure",
        409,
      );
  };
  const run = (await jobs.execute(
    "restoreBackup",
    actor,
    {
      databaseId: source.id,
      id: String(backed.result?.backupId),
      mode: "replace",
      targetDatabaseId: target.id,
    },
    { idempotencyKey: newId(), stepUpApproved: true },
  )) as { jobId: string };
  let failed;
  try {
    failed = await terminal(run.jobId);
  } finally {
    hook = null;
  }
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "BACKUP_UNVERIFIED");
  assert.equal(
    (await storage.getRow(actor, targetTable.id, existing.id)).values.value,
    "original target",
  );
  assert.equal(
    await withOrg(
      ddlPool,
      actor.orgId,
      async (client) =>
        (
          await client.query(
            "SELECT 1 FROM rootset_control.restore_write_barriers WHERE database_id=$1",
            [target.id],
          )
        ).rowCount,
    ),
    0,
  );
  await storage.createRow(
    actor,
    targetTable.id,
    { value: "write permitted" },
    { idempotencyKey: newId() },
  );
});

test("API-09 JOB-03: policy, cancellation and retry replay commit with their supplied transaction", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Replay policy ${newId()}`,
  });
  const policy = {
    databaseId: database.id,
    enabled: false,
    cron: "0 0 * * *",
    timezone: "UTC",
    destination: "installation",
    retentionDays: 30,
    retentionCount: 10,
    encryption: true,
    maxRuntimeSeconds: 3600,
    notifications: false,
  };
  const key = "K".repeat(255);
  const replies = await Promise.all(
    Array.from({ length: 3 }, () =>
      jobs.execute("setBackupPolicy", actor, policy, { idempotencyKey: key }),
    ),
  );
  assert.deepEqual(replies[0], replies[1]);
  assert.deepEqual(replies[0], replies[2]);
  await assert.rejects(
    jobs.execute(
      "setBackupPolicy",
      actor,
      { ...policy, retentionCount: 11 },
      { idempotencyKey: key },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const rolledBackKey = newId();
  await assert.rejects(
    withOrg(pool, actor.orgId, async (client) => {
      await jobs.execute(
        "setBackupPolicy",
        actor,
        { ...policy, retentionCount: 12 },
        { idempotencyKey: rolledBackKey, client },
      );
      throw new Error("Rollback policy receipt and effects");
    }),
  );
  const afterRollback = (await jobs.execute("getBackupPolicy", actor, {
    databaseId: database.id,
  })) as { policy: { retentionCount: number } };
  assert.equal(afterRollback.policy.retentionCount, 10);
  await jobs.execute(
    "setBackupPolicy",
    actor,
    { ...policy, retentionCount: 13 },
    { idempotencyKey: rolledBackKey },
  );
  currentAccess = false;
  try {
    await assert.rejects(
      jobs.execute("setBackupPolicy", actor, policy, { idempotencyKey: key }),
      (error) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
  } finally {
    currentAccess = true;
  }
  const queued = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId: database.id },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const cancellationKey = newId();
  const cancelled = await jobs.execute(
    "cancelJob",
    actor,
    { id: queued.jobId },
    { idempotencyKey: cancellationKey },
  );
  assert.deepEqual(
    await jobs.execute(
      "cancelJob",
      actor,
      { id: queued.jobId },
      { idempotencyKey: cancellationKey },
    ),
    cancelled,
  );
  const differentTarget = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId: database.id },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  await assert.rejects(
    jobs.execute(
      "cancelJob",
      actor,
      { id: differentTarget.jobId },
      { idempotencyKey: cancellationKey },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await jobs.execute(
    "cancelJob",
    actor,
    { id: differentTarget.jobId },
    { idempotencyKey: newId() },
  );
  const retryKey = newId();
  const retried = (await jobs.execute(
    "retryJob",
    actor,
    { id: queued.jobId },
    { idempotencyKey: retryKey },
  )) as { jobId: string };
  assert.deepEqual(
    await jobs.execute(
      "retryJob",
      actor,
      { id: queued.jobId },
      { idempotencyKey: retryKey },
    ),
    retried,
  );
  assert.equal((await terminal(retried.jobId)).state, "succeeded");
});

test("BKP-06/13 JOB-02/03 API-09: queued backup deletion defers effects until commit, resumes object checkpoints and reconciles a real SIGKILL after final publication", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Deletion fence ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Values",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    target.id,
    { value: "Retained" },
    { idempotencyKey: newId() },
  );
  const backups: string[] = [];
  for (let i = 0; i < 3; i++) {
    const started = (await jobs.execute(
      "createBackup",
      actor,
      { databaseId: database.id },
      { idempotencyKey: newId() },
    )) as { jobId: string };
    const finished = await terminal(started.jobId);
    assert.equal(finished.state, "succeeded", JSON.stringify(finished.error));
    backups.push(String(finished.result!.backupId));
  }
  const first = await jobs.backups.load(actor, backups[0]!);
  const firstArtifact = await jobs.artifacts.get(
    actor,
    first.manifest.rows[0]!.artifactId,
  );
  const key = newId();
  let abortedId = "";
  await assert.rejects(
    withOrg(ddlPool, actor.orgId, async (client) => {
      const proposed = (await jobs.execute(
        "deleteBackup",
        actor,
        { databaseId: database.id, id: backups[0]! },
        { idempotencyKey: key, client },
      )) as { jobId: string };
      abortedId = proposed.jobId;
      const invisible = await withOrg(
        pool,
        actor.orgId,
        async (c) =>
          (
            await c.query("SELECT 1 FROM rootset_control.jobs WHERE id=$1", [
              abortedId,
            ])
          ).rowCount,
      );
      assert.equal(invisible, 0);
      const untouched = await jobs.artifacts.client.send(
        new GetObjectCommand({
          Bucket: config.artifacts.bucket,
          Key: firstArtifact.object_key,
        }),
      );
      assert.ok(untouched.Body);
      (untouched.Body as import("node:stream").Readable).destroy();
      assert.equal(
        (await jobs.backups.load(actor, backups[0]!)).backup.state,
        "succeeded",
      );
      throw new Error("Rollback approved admission");
    }),
  );
  assert.equal(
    await withOrg(
      pool,
      actor.orgId,
      async (c) =>
        (
          await c.query("SELECT 1 FROM rootset_control.jobs WHERE id=$1", [
            abortedId,
          ])
        ).rowCount,
    ),
    0,
  );
  const deletion = (await jobs.execute(
    "deleteBackup",
    actor,
    { databaseId: database.id, id: backups[0]! },
    { idempotencyKey: key },
  )) as { jobId: string };
  assert.notEqual(deletion.jobId, abortedId);
  assert.equal(
    (
      (await jobs.execute(
        "deleteBackup",
        actor,
        { databaseId: database.id, id: backups[0]! },
        { idempotencyKey: key },
      )) as { jobId: string }
    ).jobId,
    deletion.jobId,
  );
  await assert.rejects(
    jobs.execute(
      "deleteBackup",
      actor,
      { databaseId: database.id, id: backups[1]! },
      { idempotencyKey: key },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  failPoint = "backupDelete.afterObject";
  await jobs.runOnce(actor.orgId);
  const checkpoint = await withOrg(
    ddlPool,
    actor.orgId,
    async (c) =>
      (
        await c.query<{
          checkpoint: { deletedArtifacts: number };
          state: string;
        }>("SELECT checkpoint,state FROM rootset_control.jobs WHERE id=$1", [
          deletion.jobId,
        ])
      ).rows[0]!,
  );
  assert.equal(checkpoint.state, "queued");
  assert.equal(checkpoint.checkpoint.deletedArtifacts, 1);
  await withOrg(ddlPool, actor.orgId, (c) =>
    c.query(
      "UPDATE rootset_control.jobs SET next_attempt_at=now() WHERE id=$1",
      [deletion.jobId],
    ),
  );
  assert.equal((await terminal(deletion.jobId)).state, "succeeded");
  const finalDeletion = (await jobs.execute(
    "deleteBackup",
    actor,
    { databaseId: database.id, id: backups[1]! },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv))
    if (
      /^ROOTSET_(TEST_)?(APP_|DDL_|IDENTITY_|MIGRATION_)?DATABASE_URL$/.test(
        name,
      ) &&
      childEnv[name]
    ) {
      const url = new URL(childEnv[name]!);
      url.pathname = `/${fixture.name}`;
      childEnv[name] = url.toString();
    }
  const child = fork(new URL("./worker-fixture.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    env: childEnv,
    silent: true,
  });
  let stderr = "";
  child.stderr?.on("data", (part) => {
    stderr = (stderr + String(part)).slice(-2000);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`Deletion publication checkpoint not reached: ${stderr}`),
          ),
        10000,
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`Deletion worker exited early: ${stderr}`));
      });
      child.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "point" in message &&
          message.point === "job.beforeFinish"
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.send({
        orgId: actor.orgId,
        artifacts: config.artifacts,
        pauseAt: "job.beforeFinish",
      });
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    const persisted = await withOrg(
      ddlPool,
      actor.orgId,
      async (c) =>
        (
          await c.query<{
            state: string;
            result: JsonValue;
            backup_state: string;
          }>(
            "SELECT j.state,o.result,b.state AS backup_state FROM rootset_control.jobs j JOIN rootset_control.operation_outcomes o ON o.job_id=j.id JOIN rootset_control.backups b ON b.id=j.input->>'id' WHERE j.id=$1",
            [finalDeletion.jobId],
          )
        ).rows[0]!,
    );
    assert.equal(persisted.state, "running");
    assert.equal(persisted.backup_state, "deleted");
    assert.deepEqual(persisted.result, { deleted: true });
    await withOrg(ddlPool, actor.orgId, (c) =>
      c.query(
        "UPDATE rootset_control.jobs SET lease_until=now()-interval '1 second',attempt=max_attempts WHERE id=$1",
        [finalDeletion.jobId],
      ),
    );
    currentAccess = false;
    try {
      await jobs.runOnce(actor.orgId);
    } finally {
      currentAccess = true;
    }
    const recovered = (await jobs.execute("getJob", actor, {
      id: finalDeletion.jobId,
    })) as { state: string; result: JsonValue };
    assert.equal(recovered.state, "succeeded");
    assert.deepEqual(recovered.result, { deleted: true });
    assert.equal(
      (await jobs.backups.load(actor, backups[2]!)).backup.state,
      "succeeded",
    );
    assert.equal((await storage.getTable(actor, target.id)).rowCount, 1);
  } finally {
    child.kill("SIGKILL");
  }
});

test("AUD-09 BKP-01 JOB-04: history policy, archive detail, schedule preview and backup lists obey strict contracts and current target grants", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Handler lifecycle ${newId()}`,
    description: "Verified metadata",
  });
  const target = await storage.createTable(actor, database.id, {
    name: "History",
    description: "Retained definitions",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 64 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    target.id,
    { value: "Archive me" },
    { idempotencyKey: newId() },
  );
  const historyPolicy = {
    tableId: target.id,
    enabled: false,
    retentionDays: 30,
    cron: "0 2 * * *",
    timezone: "UTC",
    maxRuntimeSeconds: 3600,
  };
  const policyKey = newId();
  const policy = await jobs.execute(
    "setHistoryRetentionPolicy",
    actor,
    historyPolicy,
    { idempotencyKey: policyKey },
  );
  getOperation("setHistoryRetentionPolicy").outputSchema.parse(policy);
  assert.deepEqual(
    await jobs.execute("setHistoryRetentionPolicy", actor, historyPolicy, {
      idempotencyKey: policyKey,
    }),
    policy,
  );
  await assert.rejects(
    jobs.execute(
      "setHistoryRetentionPolicy",
      actor,
      { ...historyPolicy, retentionDays: 31 },
      { idempotencyKey: policyKey },
    ),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const historicalAt = new Date(Date.now() - 60000).toISOString();
  await owner.query(
    "UPDATE rootset_control.cell_changes SET changed_at=$2 WHERE org_id=$1 AND table_id=$3",
    [actor.orgId, historicalAt, target.id],
  );
  await owner.query(
    "UPDATE rootset_control.row_events SET changed_at=$2 WHERE org_id=$1 AND table_id=$3",
    [actor.orgId, historicalAt, target.id],
  );
  const before = new Date(Date.now() - 5000).toISOString();
  const archive = (await jobs.execute(
    "archiveHistory",
    actor,
    { tableId: target.id, before },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const archived = await terminal(archive.jobId);
  assert.equal(archived.state, "succeeded", JSON.stringify(archived.error));
  const archiveInput = {
    tableId: target.id,
    id: String(archived.result!.archiveId),
  };
  const detail = (await jobs.execute(
    "getHistoryArchive",
    actor,
    archiveInput,
  )) as { state: string; cellEvents: number; rowEvents: number };
  getOperation("getHistoryArchive").outputSchema.parse(detail);
  assert.equal(detail.state, "succeeded");
  assert.equal(detail.cellEvents, 1);
  assert.equal(detail.rowEvents, 1);
  const previewInput = {
    databaseId: database.id,
    cron: "0 4 * * *",
    timezone: "America/New_York",
    from: "2026-11-01T00:00:00Z",
    count: 3,
  };
  const preview = (await jobs.execute(
    "previewBackupSchedule",
    actor,
    previewInput,
  )) as { occurrences: string[] };
  getOperation("previewBackupSchedule").outputSchema.parse(preview);
  assert.equal(preview.occurrences.length, 3);
  const backup = (await jobs.execute(
    "createBackup",
    actor,
    { databaseId: database.id },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  const backed = await terminal(backup.jobId);
  assert.equal(backed.state, "succeeded", JSON.stringify(backed.error));
  const listInput = { databaseId: database.id, limit: 1 };
  const list = (await jobs.execute("listBackups", actor, listInput)) as {
    data: Array<{ id: string; state: string }>;
  };
  getOperation("listBackups").outputSchema.parse(list);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0]!.id, backed.result!.backupId);
  assert.equal(list.data[0]!.state, "succeeded");
  const operations = [
    { id: "setHistoryRetentionPolicy", input: historyPolicy, key: policyKey },
    { id: "getHistoryArchive", input: archiveInput },
    { id: "previewBackupSchedule", input: previewInput },
    { id: "listBackups", input: listInput },
  ];
  const restricted: Actor = {
    ...actor,
    operator: false,
    unrestricted: false,
    targets: [{ databaseId, level: "manage" }],
  };
  const scoped = new JobsService({ pool, ddlPool, storage, config });
  for (const operation of operations) {
    await assert.rejects(
      scoped.execute(operation.id, restricted, operation.input, {
        idempotencyKey: operation.key ?? newId(),
      }),
      (error) =>
        error instanceof RootsetError && error.code === "ACCESS_DENIED",
    );
    currentAccess = false;
    try {
      await assert.rejects(
        jobs.execute(operation.id, actor, operation.input, {
          idempotencyKey: operation.key ?? newId(),
        }),
        (error) =>
          error instanceof RootsetError && error.code === "ACCESS_DENIED",
      );
    } finally {
      currentAccess = true;
    }
  }
});

test("ACC-10 AUD-09 JOB-03: suspended-organisation audit retention discovers only permanent account deletions and preserves unrelated audit", async () => {
  const suspended = newId(),
    disabledOnlyOrg = newId(),
    deletedUser = newId(),
    otherUser = newId();
  for (const orgId of [suspended, disabledOnlyOrg])
    await owner.query(
      "INSERT INTO rootset_control.organisations(id,name,state) VALUES($1,$2,'suspended')",
      [orgId, `Suspended ${orgId}`],
    );
  for (const orgId of [suspended, disabledOnlyOrg])
    for (const userId of [deletedUser, otherUser])
      await owner.query(
        "INSERT INTO rootset_control.account_audit(id,org_id,actor_kind,actor_id,user_id,operation,outcome,created_at) VALUES($1,$2,'operator',$3,$4,'updateProfile','{}',now()-interval '4 days')",
        [newId(), orgId, actor.id, userId],
      );
  await owner.query(
    "INSERT INTO rootset_control.account_audit(id,org_id,actor_kind,actor_id,user_id,operation,target_id,outcome,created_at) VALUES($1,$2,'operator',$3,$4::varchar(26),'deleteAccount',$4::varchar(26),'{\"state\":\"deleted\",\"retainedActorIdentity\":true}',now()-interval '3 days')",
    [newId(), suspended, actor.id, deletedUser],
  );
  await owner.query(
    "INSERT INTO rootset_control.account_audit(id,org_id,actor_kind,actor_id,user_id,operation,target_id,outcome,created_at) VALUES($1,$2,'operator',$3,$4::varchar(26),'deleteAccount',$4::varchar(26),'{\"state\":\"disabled\",\"retainedActorIdentity\":true}',now()-interval '3 days')",
    [newId(), disabledOnlyOrg, actor.id, deletedUser],
  );
  const directory = async () =>
    (
      await ddlPool.query<{ id: string }>(
        "SELECT * FROM rootset_control.maintenance_org_directory()",
      )
    ).rows;
  const discovered = await directory();
  assert.ok(discovered.some((row) => row.id === suspended));
  assert.equal(
    discovered.some((row) => row.id === disabledOnlyOrg),
    false,
  );
  for (const row of discovered) assert.deepEqual(Object.keys(row), ["id"]);
  await assert.rejects(
    pool.query("SELECT * FROM rootset_control.maintenance_org_directory()"),
    (error) => (error as { code: string }).code === "42501",
  );
  await assert.rejects(
    withOrg(ddlPool, suspended, (c) =>
      c.query("SELECT rootset_control.purge_retained_account_audit($1,now())", [
        disabledOnlyOrg,
      ]),
    ),
    (error) => (error as { code: string }).code === "42501",
  );
  let auditDays: number | null = null;
  const maintenance = new JobsService({
    pool,
    ddlPool,
    storage,
    config: {
      ...config,
      deletionRetention: async () => ({
        organisationDays: null,
        accountAuditDays: auditDays,
      }),
      purgeAccountAudit: async (org, before, client) => {
        assert.ok(client);
        return (
          await client.query<{ removed: number }>(
            "SELECT rootset_control.purge_retained_account_audit($1,$2) AS removed",
            [org, before],
          )
        ).rows[0]!.removed;
      },
    },
  });
  assert.equal(await maintenance.scheduleMaintenance(suspended), 0);
  auditDays = 1;
  assert.equal(await maintenance.scheduleMaintenance(suspended), 1);
  await maintenance.runOnce(suspended);
  const result = await withOrg(
    ddlPool,
    suspended,
    async (c) =>
      (
        await c.query<{
          state: string;
          result: { deletedAuditRecords: number };
        }>(
          "SELECT state,result FROM rootset_control.jobs WHERE kind='account_audit_retention'",
        )
      ).rows[0]!,
  );
  assert.equal(result.state, "succeeded");
  assert.equal(result.result.deletedAuditRecords, 1);
  const kept = (
    await owner.query<{ org_id: string; user_id: string; operation: string }>(
      "SELECT org_id,user_id,operation FROM rootset_control.account_audit WHERE org_id=ANY($1::text[])",
      [[suspended, disabledOnlyOrg]],
    )
  ).rows;
  assert.equal(kept.length, 5);
  assert.equal(
    kept.filter(
      (row) =>
        row.org_id === suspended &&
        row.user_id === deletedUser &&
        row.operation === "updateProfile",
    ).length,
    0,
  );
  assert.ok(
    kept.some(
      (row) => row.org_id === suspended && row.operation === "deleteAccount",
    ),
  );
  assert.ok(
    kept.some(
      (row) =>
        row.org_id === suspended &&
        row.user_id === otherUser &&
        row.operation === "updateProfile",
    ),
  );
  assert.equal(kept.filter((row) => row.org_id === disabledOnlyOrg).length, 3);
  const after = await directory();
  assert.equal(
    after.some((row) => row.id === suspended),
    false,
  );
  assert.equal(
    after.some((row) => row.id === disabledOnlyOrg),
    false,
  );
});

test("OC-03 API-09 JOB-04: Viewer-owned export cancellation and retry execute under original scopes and deny foreign requesters or lost current authority", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Viewer export ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Values",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 32 }],
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
      "rows:read",
      "jobs:read",
      "jobs:cancel",
      "jobs:retry",
    ],
    targets: [{ databaseId: database.id, tableId: target.id, level: "read" }],
  };
  let liveViewer = viewer;
  const fallback = new JobsService({ pool, ddlPool, storage, config });
  const service = new JobsService({
    pool,
    ddlPool,
    storage,
    config,
    authorise: async (a, op, t) =>
      fallback.authorise(a.id === viewer.id ? liveViewer : a, op, t),
  });
  const queued = (await service.execute(
    "exportRows",
    viewer,
    { tableId: target.id, format: "jsonl" },
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
  liveViewer = { ...viewer, targets: [] };
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
  liveViewer = {
    ...viewer,
    scopes: viewer.scopes.filter((scope) => scope !== "exports:read"),
  };
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
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
    value: "Viewer row",
  });
  liveViewer = {
    ...viewer,
    scopes: viewer.scopes.filter((scope) => scope !== "rows:read"),
  };
  await assert.rejects(
    service.execute(
      "retryJob",
      viewer,
      { id: queued.jobId },
      { idempotencyKey: retryKey },
    ),
    (error) => error instanceof RootsetError && error.code === "ACCESS_DENIED",
  );
  liveViewer = viewer;
  const revoked = (await service.execute(
    "exportRows",
    viewer,
    { tableId: target.id, format: "jsonl" },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  liveViewer = { ...viewer, targets: [] };
  await service.runOnce(viewer.orgId);
  liveViewer = viewer;
  const refused = (await service.execute("getJob", viewer, {
    id: revoked.jobId,
  })) as { state: string; error: { code: string } };
  getOperation("getJob").outputSchema.parse(refused);
  assert.equal(refused.state, "failed");
  assert.equal(refused.error.code, "ACCESS_DENIED");
});

test("JOB-03/04 IO-09: running exports recheck cancellation and current authority before publishing their artifact", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Export publication ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Values",
    fields: [{ apiKey: "value", label: "Value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  await storage.createRow(
    actor,
    target.id,
    { value: "Only authorized output" },
    { idempotencyKey: newId() },
  );
  for (const action of ["cancel", "revoke"] as const) {
    const run = (await jobs.execute(
      "exportRows",
      actor,
      { tableId: target.id, format: "jsonl" },
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
    const result = (await jobs.execute("getJob", actor, { id: run.jobId })) as {
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
});

test("IO-01/02 JOB-04/06: slow all-rejected validation keeps its transaction live and owns a forced PostgreSQL disconnect", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Validation transaction recovery ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Rejected records",
    fields: [{ apiKey: "flag", label: "Flag", type: "boolean" }],
    idempotencyKey: newId(),
  });
  const prepare = async (records: number) => {
    const content =
      Array.from({ length: records }, () =>
        JSON.stringify({ flag: "invalid" }),
      ).join("\n") + "\n";
    const accepted = (await jobs.execute("prepareImportUpload", actor, {
      tableId: target.id,
      format: "jsonl",
      byteLength: Buffer.byteLength(content),
      checksum: createHash("sha256").update(content).digest("hex"),
    })) as { artifactId: string };
    await jobs.uploadArtifact(
      actor,
      accepted.artifactId,
      (async function* () {
        yield Buffer.from(content);
      })(),
    );
    return jobs.execute("validateImport", actor, {
      tableId: target.id,
      artifactId: accepted.artifactId,
      expectedSchemaVersion: target.schemaVersion,
      mapping: { flag: "flag" },
      mode: "create",
    }) as Promise<{ jobId: string }>;
  };
  const slow = await prepare(65);
  let paused = 0;
  hook = async (point) => {
    if (point !== "import.validation.afterRecord") return;
    paused++;
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  const started = performance.now();
  try {
    await jobs.runOnce(actor.orgId);
  } finally {
    hook = null;
  }
  assert.ok(performance.now() - started > 30000);
  assert.equal(paused, 65);
  const completed = (await jobs.execute("getJob", actor, {
    id: slow.jobId,
  })) as {
    state: string;
    attempt: number;
    result: { examined: number; accepted: number; rejected: number };
  };
  getOperation("getJob").outputSchema.parse(completed);
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.attempt, 1);
  assert.equal(completed.result.examined, 65);
  assert.equal(completed.result.accepted, 0);
  assert.equal(completed.result.rejected, 65);
  assert.equal((await storage.getTable(actor, target.id)).rowCount, 0);

  const interrupted = await prepare(2);
  let terminated = false;
  hook = async (point) => {
    if (point !== "import.validation.afterRecord" || terminated) return;
    const clients = await owner.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query='CREATE INDEX ON rootset_import_seen(rule_id,digest)'",
    );
    assert.equal(clients.rows.length, 1);
    const killed = await owner.query<{ stopped: boolean }>(
      "SELECT pg_terminate_backend($1) AS stopped",
      [clients.rows[0]!.pid],
    );
    assert.equal(killed.rows[0]!.stopped, true);
    terminated = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  try {
    await jobs.runOnce(actor.orgId);
  } finally {
    hook = null;
  }
  assert.equal(terminated, true);
  const failed = (await jobs.execute("getJob", actor, {
    id: interrupted.jobId,
  })) as { state: string; error: { code: string; message: string } };
  getOperation("getJob").outputSchema.parse(failed);
  assert.equal(failed.state, "queued");
  assert.equal(failed.error.code, "JOB_FAILED");
  assert.equal(
    failed.error.message,
    "The background operation failed; inspect redacted worker logs",
  );
  assert.equal((await storage.getTable(actor, target.id)).rowCount, 0);
  assert.equal(
    (await pool.query("SELECT 1 AS available")).rows[0]!.available,
    1,
  );
  const retry = await owner.query<{ next_attempt_at: Date }>(
    "SELECT next_attempt_at FROM rootset_control.jobs WHERE id=$1",
    [interrupted.jobId],
  );
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, retry.rows[0]!.next_attempt_at.getTime() - Date.now() + 100),
    ),
  );
  const recovered = await terminal(interrupted.jobId);
  assert.equal(recovered.state, "succeeded", JSON.stringify(recovered.error));
  assert.equal(recovered.result?.examined, 2);
  assert.equal(recovered.result?.rejected, 2);
});

test("BKP-05 JOB-06: slow immutable history read precedes the native verification snapshot and interrupted snapshot clients recover", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Verification snapshot liveness ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Canonical history",
    fields: [{ apiKey: "payload", label: "Payload", type: "json" }],
    idempotencyKey: newId(),
  });
  const row = await storage.createRow(actor, target.id, {
    payload: { id: "literal", nested: [null, true, "original"] },
  });
  await storage.updateRow(
    actor,
    target.id,
    row.id,
    { payload: { id: "literal", nested: [null, false, "changed"] } },
    { expectedVersion: row.version, idempotencyKey: newId() },
  );
  const admitted = (await jobs.execute("createBackup", actor, {
    databaseId: database.id,
  })) as { jobId: string };
  const completed = await terminal(admitted.jobId);
  assert.equal(completed.state, "succeeded", JSON.stringify(completed.error));
  const loaded = await jobs.backups.load(
    actor,
    String(completed.result?.backupId),
  );
  const staged = await storage.restoreDatabase(
    actor,
    jobs.backups.source(actor, loaded.manifest),
    {
      name: `Slow history verification ${newId()}`,
      verification: true,
      staged: true,
      jobId: newId(),
    },
  );
  const historyArtifact = await jobs.artifacts.get(
    actor,
    loaded.manifest.history.artifactId,
  );
  let slowReads = 0;
  const delayMiddleware = "verificationExpectedHistoryLatency";
  jobs.artifacts.client.middlewareStack.add(
    (next) => async (args) => {
      if (
        "Key" in args.input &&
        args.input.Key === historyArtifact.object_key
      ) {
        slowReads++;
        const barrier = await owner.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [staged.databaseId],
        );
        assert.equal(barrier.rows[0]!.acquired, true);
        await owner.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          staged.databaseId,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 35000));
      }
      return next(args);
    },
    { name: delayMiddleware, step: "initialize" },
  );
  const started = performance.now();
  try {
    await jobs.backups.verifyRestored(actor, loaded.manifest, staged);
  } finally {
    jobs.artifacts.client.middlewareStack.remove(delayMiddleware);
    await storage.discardRestore(actor, staged);
  }
  assert.equal(slowReads, 1);
  assert.ok(performance.now() - started > 30000);
  assert.equal(
    (
      await pool.query(
        "SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout'",
      )
    ).rows[0]!.setting,
    "30000",
  );
  let interruptedPid = 0;
  await assert.rejects(
    snapshotTransaction(ddlPool, actor.orgId, database.id, async (client) => {
      interruptedPid = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      const killed = await owner.query<{ stopped: boolean }>(
        "SELECT pg_terminate_backend($1) AS stopped",
        [interruptedPid],
      );
      assert.equal(killed.rows[0]!.stopped, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await client.query("SELECT 1");
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "57P01" &&
      /terminating connection due to administrator command/.test(error.message),
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1",
        [interruptedPid],
      )
    ).rows[0]!.count,
    "0",
  );
  assert.equal(
    await snapshotTransaction(
      ddlPool,
      actor.orgId,
      database.id,
      async (client) =>
        (await client.query("SELECT 1 AS recovered")).rows[0]!.recovered,
    ),
    1,
  );
  const original = await storage.getRow(actor, target.id, row.id);
  assert.equal(original.version, "2");
  assert.deepEqual(original.values.payload, {
    id: "literal",
    nested: [null, false, "changed"],
  });
});
