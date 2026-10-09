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
import { stableStringify } from "./types.js";
import { runMutation } from "@rootset/idempotency";

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
    encryptionKey:
      process.env.ROOTSET_ENCRYPTION_KEY ?? randomBytes(32).toString("base64"),
  },
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

async function completePastHistoryRange(
  tableId: string,
  expected: { cells: string; rows: string },
) {
  const native = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{
          cells: string;
          rows: string;
          cutoff_ms: string | null;
        }>(
          `WITH events AS (
        SELECT 'cell' AS kind,changed_at FROM rootset_control.cell_changes WHERE table_id=$1
        UNION ALL
        SELECT 'row' AS kind,changed_at FROM rootset_control.row_events WHERE table_id=$1
      ) SELECT count(*) FILTER(WHERE kind='cell')::text AS cells,
        count(*) FILTER(WHERE kind='row')::text AS rows,
        (floor(extract(epoch FROM max(changed_at))*1000)+1)::bigint::text AS cutoff_ms FROM events`,
          [tableId],
        )
      ).rows[0]!,
  );
  assert.deepEqual({ cells: native.cells, rows: native.rows }, expected);
  assert.ok(native.cutoff_ms);
  const cutoff = new Date(Number(native.cutoff_ms)).toISOString();
  const deadline = performance.now() + 1000;
  for (;;) {
    const databasePast = await withOrg(
      ddlPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{ past: boolean }>(
            "SELECT $1::timestamptz < clock_timestamp() AS past",
            [cutoff],
          )
        ).rows[0]!.past,
    );
    assert.ok(
      performance.now() < deadline,
      "The native cutoff did not become past in both observed fixture clocks within one second",
    );
    if (Date.parse(cutoff) < Date.now() && databasePast) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const eligible = await withOrg(
    ddlPool,
    actor.orgId,
    async (client) =>
      (
        await client.query<{
          cells: string;
          rows: string;
          database_past: boolean;
        }>(
          "SELECT (SELECT count(*) FROM rootset_control.cell_changes WHERE table_id=$1 AND changed_at<$2::timestamptz)::text AS cells,(SELECT count(*) FROM rootset_control.row_events WHERE table_id=$1 AND changed_at<$2::timestamptz)::text AS rows,$2::timestamptz<clock_timestamp() AS database_past",
          [tableId, cutoff],
        )
      ).rows[0]!,
  );
  assert.deepEqual({ cells: eligible.cells, rows: eligible.rows }, expected);
  assert.equal(eligible.database_past, true);
  assert.ok(Date.parse(cutoff) < Date.now());
  return cutoff;
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
    });
    await jobs.runOnce(actor.orgId);
  } finally {
    await fixture.close();
  }
});

test("V1-24 V1-25: import commit interruption resumes exact rows/history with leading zeros", async () => {
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

test("V1-24 V1-25: partial large import reports exact rejected record while atomic import rolls back", async () => {
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

test("V1-18 V1-25: exact unique-rule upsert updates existing rows and rejects absent explicit row IDs", async () => {
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

test("V1-25: filtered snapshot export has canonical quoted content and encrypted storage", async () => {
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

test("V1-25: dry run validates upload duplicates without committing rows", async () => {
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

test("V1-24 V1-25: cancel after committed batch exposes partial progress and retry resumes without duplication", async () => {
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

test("V1-24 V1-25: SIGKILL after a committed import batch recovers under a new worker lease", async () => {
  const artifact = await upload(
    "code,name,active,instant,payload\nKILL001,One,true,2026-10-02T00:00:00Z,{}\nKILL002,Two,true,2026-10-02T00:00:00Z,{}\nKILL003,Three,true,2026-10-02T00:00:00Z,{}\n",
  );
  const started = await enqueueImport(artifact);
  const childEnv = { ...process.env };
  for (const variable of [
    "ROOTSET_TEST_DATABASE_URL",
    "ROOTSET_DATABASE_URL",
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

test("V1-25: strict numeric lexemes preserve finite floats and reject rounded fractional integers or unsafe JSON numbers", async () => {
  const original = table;
  const isolated = await storage.createDatabase(actor, {
    name: `Lexemes ${newId()}`,
  });
  table = await storage.createTable(actor, isolated.id, {
    name: "Numbers",
    fields: [
      { name: "code", type: "text", charLimit: 32 },
      { name: "value", type: "integer" },
      { name: "ratio", type: "float" },
      { name: "payload", type: "json" },
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

test("V1-25: rejected dry-run records do not reserve tuples in another unique rule", async () => {
  const original = table;
  const isolated = await storage.createDatabase(actor, {
    name: `Dry rules ${newId()}`,
  });
  table = await storage.createTable(actor, isolated.id, {
    name: "Rules",
    fields: [
      { name: "code", type: "text", charLimit: 32 },
      { name: "name", type: "text", charLimit: 32 },
    ],
    idempotencyKey: newId(),
  });
  try {
    for (const field of table.fields) {
      await storage.createUniqueRule(actor, table.id, {
        name: field.name,
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

test("V1-24 V1-25: invalid JSONL lines are reported at their exact line and later valid records remain importable", async () => {
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

test("V1-25: CSV roundtrip distinguishes null, empty text, literal null markers and backslashes", async () => {
  const original = table;
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

test("V1-07 V1-24 V1-25 V1-30: upload admission and artifact retrieval enforce declared bytes, checksum, expiry and current access", async () => {
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

test("V1-21 V1-24 V1-30: verified archive survives interrupted purge and preserves cold history", async () => {
  const database = await storage.createDatabase(actor, {
    name: `History archive ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "History rows",
    fields: [
      { name: "code", type: "text", charLimit: 32 },
      { name: "payload", type: "json" },
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
  const cutoff = await completePastHistoryRange(target.id, {
    cells: "4002",
    rows: "2001",
  });
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

test("V1-21 V1-30: corrupt history archive is refused before gap publication or any hot deletion", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Corrupt history ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Protected events",
    fields: [{ name: "value", type: "text", charLimit: 32 }],
    idempotencyKey: newId(),
  });
  const protectedRow = await storage.createRow(
    actor,
    target.id,
    { value: "must survive" },
    { idempotencyKey: newId() },
  );
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
  const cutoff = await completePastHistoryRange(target.id, {
    cells: "1",
    rows: "1",
  });
  hook = async (point, jobId) => {
    if (point !== "archive.afterUpload") return;
    const archivedCounts = await withOrg(
      ddlPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{ cell_count: string; row_count: string }>(
            "SELECT cell_count,row_count FROM rootset_control.history_archives WHERE job_id=$1",
            [jobId],
          )
        ).rows[0]!,
    );
    assert.deepEqual(archivedCounts, { cell_count: "1", row_count: "1" });
    const artifact = await withOrg(
      ddlPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{ id: string; object_key: string }>(
            "SELECT a.id,a.object_key FROM rootset_control.artifacts a JOIN rootset_control.history_archives h ON h.artifact_id=a.id WHERE h.job_id=$1",
            [jobId],
          )
        ).rows[0]!,
    );
    const opened = await jobs.artifacts.openVerified(
      actor,
      await jobs.artifacts.get(actor, artifact.id),
    );
    const archivedBytes: Buffer[] = [];
    try {
      for await (const chunk of opened.stream)
        archivedBytes.push(Buffer.from(chunk));
    } finally {
      await opened.cleanup();
    }
    const events = Buffer.concat(archivedBytes)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const cells = events.filter((event) => event.recordType === "cell"),
      rows = events.filter((event) => event.recordType === "row");
    assert.equal(cells.length, 1);
    assert.equal(rows.length, 1);
    assert.equal(cells[0].data.new_value, "must survive");
    assert.equal(cells[0].data.row_id, protectedRow.id);
    assert.equal(rows[0].data.row_id, protectedRow.id);
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
    { tableId: target.id, before: cutoff },
    { idempotencyKey: newId() },
  )) as { jobId: string };
  let failed;
  try {
    failed = await terminal(started.jobId);
  } finally {
    hook = null;
  }
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "ARTIFACT_UNVERIFIED");
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

test("V1-07 V1-24 V1-25 V1-30: same-origin streaming upload preserves exact replay, bounded source checks and current authority", async () => {
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

test("V1-07 V1-24 V1-25: authority loss between committed import batches stops further mutations with an exact partial outcome", async () => {
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

test("V1-07 V1-21 V1-24 V1-26: history policy and archive detail obey strict contracts and current role authority", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Handler lifecycle ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "History",
    fields: [{ name: "value", type: "text", charLimit: 64 }],
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
  const operations = [
    { id: "setHistoryRetentionPolicy", input: historyPolicy, key: policyKey },
    { id: "getHistoryArchive", input: archiveInput },
  ];
  const viewer: Actor = { ...actor, role: "viewer" };
  const scoped = new JobsService({ pool, ddlPool, storage, config });
  for (const operation of operations) {
    if (operation.id === "setHistoryRetentionPolicy")
      await assert.rejects(
        scoped.execute(operation.id, viewer, operation.input, {
          idempotencyKey: operation.key ?? newId(),
        }),
        (error) => error instanceof RootsetError && error.code === "FORBIDDEN",
      );
    else
      getOperation(operation.id).outputSchema.parse(
        await scoped.execute(operation.id, viewer, operation.input),
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
    scopes: [],
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
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
    value: "Viewer row",
  });
  liveViewer = undefined;
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
  liveViewer = undefined;
  await service.runOnce(viewer.orgId);
  liveViewer = viewer;
  const refused = (await service.execute("getJob", viewer, {
    id: revoked.jobId,
  })) as { state: string; error: { code: string } };
  getOperation("getJob").outputSchema.parse(refused);
  assert.equal(refused.state, "failed");
  assert.equal(refused.error.code, "ACCESS_DENIED");
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

test("V1-07 V1-23 V1-24 V1-25: slow all-rejected validation keeps its transaction live and owns a forced PostgreSQL disconnect", async () => {
  const database = await storage.createDatabase(actor, {
    name: `Validation transaction recovery ${newId()}`,
  });
  const target = await storage.createTable(actor, database.id, {
    name: "Rejected records",
    fields: [{ name: "flag", type: "boolean" }],
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
  for (const changed of [
    { source: "rest" as const },
    { approvalId: newId() },
    { stepUpApproved: true },
  ])
    await assert.rejects(
      () =>
        service.enqueueOperation(actor, "countRows", input, {
          idempotencyKey: key,
          requestId: newId(),
          source: "mcp",
          ...changed,
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
        stepUpApproved: true,
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
  assert.equal(original.input.operationContext.admissionStepUpApproved, true);
  assert.equal(original.input.operationContext.stepUpApproved, true);
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
  for (const options of [
    { source: "rest" },
    { stepUpApproved: false },
    { stepUpApproved: undefined },
    { approvalId: newId() },
  ])
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
    { admissionStepUpApproved: false, stepUpApproved: false },
    { approvalId: newId() },
    { idempotencyKey: newId() },
    { admissionSource: 1 },
    { admissionStepUpApproved: "true" },
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
        stepUpApproved: true,
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
