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
  assert.ok(content.startsWith("code,name,active,instant,payload\n"));
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
