import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, migrate, withOrg, type Pool } from "@rootset/database";
import { canonicalJson, newId, rowBytes, type Actor } from "@rootset/contracts";
import { TableStorage } from "./index.js";

const configured = Boolean(
  process.env.ROOTSET_TEST_DATABASE_URL &&
  process.env.ROOTSET_TEST_APP_DATABASE_URL &&
  process.env.ROOTSET_TEST_DDL_DATABASE_URL,
);
let owner: Pool | null = null,
  app: Pool | null = null,
  ddl: Pool | null = null,
  admin: Pool | null = null;
let storage: TableStorage | null = null;
const isolatedName = `rootset_storage_${newId().toLowerCase()}`;
const actor: Actor = {
  id: newId(),
  orgId: newId(),
  kind: "operator",
  operator: true,
  role: "owner",
  scopes: ["*"],
  targets: [],
  unrestricted: true,
};
let databaseId: string;
let schemaName: string;
before(async () => {
  if (!configured) return;
  const source = new URL(process.env.ROOTSET_TEST_DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname))
    throw new Error(
      "Disposable storage tests require a loopback PostgreSQL service",
    );
  admin = createPool(source.toString(), 1);
  await admin.query(`CREATE DATABASE "${isolatedName}" TEMPLATE template0`);
  const target = (key: string) => {
    const url = new URL(process.env[key]!);
    url.pathname = `/${isolatedName}`;
    return url.toString();
  };
  owner = createPool(target("ROOTSET_TEST_DATABASE_URL"), 1);
  app = createPool(target("ROOTSET_TEST_APP_DATABASE_URL"), 4);
  ddl = createPool(target("ROOTSET_TEST_DDL_DATABASE_URL"), 2);
  await migrate(owner);
  storage = new TableStorage({
    pool: app,
    ddlPool: ddl,
    cursorSecret: "storage-regression-secret-longer-than-thirty-two-bytes",
  });
  await owner!.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [actor.orgId, "Storage numeric and transport regressions"],
  );
  const database = await storage!.createDatabase(actor, {
    name: "Regressions",
  });
  databaseId = database.id;
  schemaName = database.schemaName;
});
after(async () => {
  await Promise.all([owner?.end(), app?.end(), ddl?.end()]);
  if (admin) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}"`);
    } finally {
      await admin.end();
    }
  }
});

test(
  "PostgreSQL canonical numeric bytes match JavaScript finite-double vectors, including shortest-rounding boundaries",
  { skip: !configured },
  async () => {
    const values = [
      1e100,
      1e-100,
      1e-6,
      1e-7,
      1e20,
      1e21,
      1e23,
      -0,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      1.2345678901234567,
      9007199254740991,
    ];
    let seed = 58342911;
    for (let index = 0; index < 10000; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const mantissa = seed / 4294967296;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value =
        (mantissa + 0.001) * 10 ** ((seed % 625) - 316) * (index % 2 ? -1 : 1);
      if (Number.isFinite(value)) values.push(value);
    }
    const result = await owner!.query<{ canonical: string }>(
      "SELECT rootset_control.canonical_json(value) AS canonical FROM jsonb_array_elements($1::jsonb)",
      [JSON.stringify(values)],
    );
    assert.deepEqual(
      result.rows.map((row) => row.canonical),
      values.map((value) => canonicalJson(value)),
    );
    const table = await storage!.createTable(actor, databaseId, {
      name: "Float byte boundary",
      fields: [
        { apiKey: "text", label: "Text", type: "text", charLimit: 65536 },
        { apiKey: "float", label: "Float", type: "float" },
      ],
    });
    const text = "x".repeat(
      65536 - rowBytes(table.fields, { text: "", float: 1e23 }),
    );
    const row = await storage!.createRow(actor, table.id, {
      text,
      float: 1e23,
    });
    assert.equal(rowBytes(table.fields, row.values), 65536);
    await assert.rejects(
      storage!.updateRow(
        actor,
        table.id,
        row.id,
        { text: text + "x" },
        { expectedVersion: row.version },
      ),
      { code: "ROW_SIZE_LIMIT" },
    );
    assert.equal((await storage!.getRow(actor, table.id, row.id)).version, "1");
  },
);

test(
  "MCP-sized mutation rejection rolls back every row and audit event; imports keep bounded outcomes",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Wide batch",
      fields: [
        { apiKey: "text", label: "Text", type: "text", charLimit: 64000 },
        { apiKey: "flag", label: "Flag", type: "boolean" },
      ],
    });
    const rows = [];
    for (let index = 0; index < 20; index++)
      rows.push(
        await storage!.createRow(actor, table.id, {
          text: "x".repeat(60000),
          flag: false,
        }),
      );
    const operations = rows.map((row) => ({
      kind: "update" as const,
      rowId: row.id,
      expectedVersion: "1",
      values: { flag: true },
    }));
    await assert.rejects(
      storage!.mutateRows(actor, table.id, {
        operations,
        idempotencyKey: "wide-mcp",
        context: { source: "mcp" },
      }),
      { code: "PAYLOAD_TOO_LARGE" },
    );
    for (const row of rows) {
      const current = await storage!.getRow(actor, table.id, row.id);
      assert.equal(current.version, "1");
      assert.equal(current.values.flag, false);
    }
    const audit = await withOrg(app!, actor.orgId, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rootset_control.cell_changes WHERE table_id=$1 AND operation=$2",
        [table.id, "update"],
      ),
    );
    assert.equal(audit.rows[0]!.count, "0");
    const imported = await storage!.mutateRows(actor, table.id, {
      operations,
      idempotencyKey: "wide-import",
      context: { source: "import" },
    });
    assert.deepEqual(imported.rows, []);
    assert.ok(Buffer.byteLength(JSON.stringify(imported)) < 2048);
    assert.equal(
      (await storage!.getRow(actor, table.id, rows[0]!.id)).version,
      "2",
    );
    const first = await storage!.queryHistory(actor, table.id, {
      fieldId: table.fields[0]!.id,
      limit: 25000,
      byteLimit: 1024 * 1024,
    });
    assert.equal(first.hasMore, true);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024);
    const second = await storage!.queryHistory(actor, table.id, {
      fieldId: table.fields[0]!.id,
      limit: 25000,
      byteLimit: 1024 * 1024,
      cursor: first.nextCursor!,
    });
    assert.equal(second.hasMore, false);
    assert.equal(
      new Set([...first.data, ...second.data].map((event) => event.row_id))
        .size,
      20,
    );
  },
);

test(
  "Two concurrent secondary-index retries create one validated index and increment schema once",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Index replay",
      fields: [{ apiKey: "code", label: "Code", type: "text", charLimit: 20 }],
    });
    const input = {
      fieldId: table.fields[0]!.id,
      kind: "btree" as const,
      expectedSchemaVersion: 1,
      idempotencyKey: "concurrent-index",
    };
    const settled = await Promise.allSettled([
      storage!.createIndex(actor, table.id, input),
      storage!.createIndex(actor, table.id, input),
    ]);
    for (const result of settled)
      if (result.status === "rejected") throw result.reason;
    const completed = settled.map(
      (result) =>
        (
          result as PromiseFulfilledResult<
            Awaited<ReturnType<TableStorage["createIndex"]>>
          >
        ).value,
    );
    const first = completed[0]!,
      second = completed[1]!;
    assert.equal(first.id, second.id);
    assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 2);
    assert.equal(
      (await storage!.createIndex(actor, table.id, input)).id,
      first.id,
    );
    const native = await owner!.query<{ indisvalid: boolean }>(
      "SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)",
      [`"${schemaName}"."${first.physicalName}"`],
    );
    assert.equal(native.rows[0]!.indisvalid, true);
  },
);

test(
  "Numeric zero window does not build ranked anchors or claim a filtered count",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Zero window",
      fields: [{ apiKey: "code", label: "Code", type: "text" }],
    });
    await storage!.createRow(actor, table.id, { code: "match" });
    const result = await storage!.queryWindow(actor, table.id, {
      position: 0,
      query: { where: { field: "code", op: "eq", value: "match" }, limit: 200 },
    });
    assert.equal(result.totalRows, null);
    assert.equal(result.countKind, "unknown");
    assert.equal(result.anchorsReady, false);
    assert.equal(result.result.data.length, 1);
  },
);

test(
  "Projection changes retain existing ranked window anchors without changing cursor binding",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Projection session",
      fields: [
        { apiKey: "code", label: "Code", type: "text" },
        { apiKey: "flag", label: "Flag", type: "boolean" },
      ],
    });
    await storage!.mutateRows(actor, table.id, {
      operations: Array.from({ length: 6 }, (_, index) => ({
        kind: "create",
        values: { code: String(index), flag: index % 2 === 0 },
      })),
    });
    const first = await storage!.queryWindow(actor, table.id, {
      position: "middle",
      query: { select: ["code"], limit: 2 },
    });
    assert.equal(first.anchorsReady, true);
    const second = await storage!.queryWindow(actor, table.id, {
      position: "middle",
      sessionId: first.sessionId,
      query: { select: ["flag"], limit: 2 },
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.position, first.position);
    assert.deepEqual(
      second.result.data.map((row) => row.id),
      first.result.data.map((row) => row.id),
    );
    assert.deepEqual(Object.keys(second.result.data[0]!.values), ["flag"]);
    await assert.rejects(
      storage!.queryRows(actor, table.id, {
        select: ["flag"],
        limit: 2,
        cursor: first.result.page.nextCursor,
      }),
      { code: "CURSOR_INVALID" },
    );
  },
);

test(
  "Schema idempotency keys bind database and field path identities",
  { skip: !configured },
  async () => {
    const create = { name: "Database identity", idempotencyKey: newId() };
    const first = await storage!.createDatabase(actor, create);
    const second = await storage!.createDatabase(actor, {
      name: "Other database identity",
    });
    try {
      assert.equal((await storage!.createDatabase(actor, create)).id, first.id);
      const update = { name: "Updated database", idempotencyKey: newId() };
      await storage!.updateDatabase(actor, first.id, update);
      await assert.rejects(storage!.updateDatabase(actor, second.id, update), {
        code: "IDEMPOTENCY_CONFLICT",
      });
      const deletion = { idempotencyKey: newId() };
      await storage!.deleteDatabase(actor, first.id, deletion);
      await assert.rejects(
        storage!.deleteDatabase(actor, second.id, deletion),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      assert.equal(
        (await storage!.getDatabase(actor, second.id)).state,
        "active",
      );
      const table = await storage!.createTable(actor, databaseId, {
        name: "Field identity",
        fields: [
          { apiKey: "first", label: "First", type: "text" },
          { apiKey: "second", label: "Second", type: "text" },
        ],
      });
      const patch = {
        label: "Updated",
        expectedSchemaVersion: 1,
        idempotencyKey: newId(),
      };
      await storage!.updateField(actor, table.id, table.fields[0]!.id, patch);
      await assert.rejects(
        storage!.updateField(actor, table.id, table.fields[1]!.id, patch),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      assert.equal(
        (
          await storage!.updateField(
            actor,
            table.id,
            table.fields[0]!.id,
            patch,
          )
        ).schemaVersion,
        2,
      );
      const remove = { expectedSchemaVersion: 2, idempotencyKey: newId() };
      await storage!.deleteField(actor, table.id, table.fields[0]!.id, remove);
      await assert.rejects(
        storage!.deleteField(actor, table.id, table.fields[1]!.id, remove),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      assert.equal(
        (
          await storage!.deleteField(
            actor,
            table.id,
            table.fields[0]!.id,
            remove,
          )
        ).fields.length,
        1,
      );
      const appended = await storage!.createField(actor, table.id, {
        apiKey: "third",
        label: "Third",
        type: "text",
        expectedSchemaVersion: 3,
      });
      assert.deepEqual(
        appended.fields.map((field) => field.order),
        [0, 1],
      );
    } finally {
      await storage!.deleteDatabase(actor, first.id);
      await storage!.deleteDatabase(actor, second.id);
      await owner!.query(`DROP SCHEMA IF EXISTS "${first.schemaName}" CASCADE`);
      await owner!.query(
        `DROP SCHEMA IF EXISTS "${second.schemaName}" CASCADE`,
      );
    }
  },
);

test(
  "A depth-32 JSON cell survives mutation envelopes, projected queries, and idempotent replay after schema and row deletion",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Depth and durable replay",
      fields: [{ apiKey: "data", label: "Data", type: "json" }],
    });
    let nested: import("@rootset/contracts").JsonValue = "leaf";
    for (let i = 0; i < 32; i++) nested = [nested];
    const options = {
      idempotencyKey: "nested32",
      expectedSchemaVersion: table.schemaVersion,
    };
    const row = await storage!.createRow(
      actor,
      table.id,
      { data: nested },
      options,
    );
    assert.deepEqual(row.values.data, nested);
    const page = await storage!.queryRows(actor, table.id, {
      select: ["data"],
      limit: 1,
    });
    assert.deepEqual(page.data[0]!.values.data, nested);
    const advanced = await storage!.createField(actor, table.id, {
      apiKey: "flag",
      label: "Flag",
      type: "boolean",
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage!.createRow(actor, table.id, { data: nested }, options)).id,
      row.id,
    );
    await storage!.deleteRow(actor, table.id, row.id, {
      expectedVersion: row.version,
    });
    assert.equal(
      (await storage!.createRow(actor, table.id, { data: nested }, options)).id,
      row.id,
    );
    assert.equal((await storage!.getTable(actor, table.id)).rowCount, 0);
    await storage!.deleteTable(actor, table.id, {
      expectedSchemaVersion: advanced.schemaVersion,
    });
    assert.equal(
      (await storage!.createRow(actor, table.id, { data: nested }, options)).id,
      row.id,
    );
  },
);

test(
  "Verified archive publication is lease fenced; partial purge snapshots contain cold references exactly once and missing artifacts block backups",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Retained cold history",
      fields: [
        { apiKey: "value", label: "Value", type: "text", charLimit: 100 },
        { apiKey: "payload", label: "Payload", type: "json" },
      ],
    });
    const row = await storage!.createRow(
      actor,
      table.id,
      { value: "first", payload: { preserve: actor.id } },
      { context: { source: "rest", requestId: actor.id } },
    );
    await storage!.updateRow(
      actor,
      table.id,
      row.id,
      { value: "second" },
      { expectedVersion: row.version },
    );
    await owner!.query(
      "UPDATE rootset_control.cell_changes SET changed_at=changed_at-interval '10 seconds' WHERE table_id=$1",
      [table.id],
    );
    await owner!.query(
      "UPDATE rootset_control.row_events SET changed_at=changed_at-interval '10 seconds' WHERE table_id=$1",
      [table.id],
    );
    const to = new Date(Date.now() - 5000).toISOString();
    const c = await ddl!.connect();
    let metadata: Awaited<
      ReturnType<TableStorage["snapshotHistory"]>
    >["metadata"];
    const cold: Record<string, unknown>[] = [];
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await c.query("SELECT set_config('rootset.org_id',$1,true)", [
        actor.orgId,
      ]);
      await assert.rejects(
        storage!.snapshotHistory(
          actor,
          table.id,
          { to: new Date(Date.now() + 60000).toISOString() },
          c,
        ),
        { code: "VALIDATION_FAILED" },
      );
      const source = await storage!.snapshotHistory(actor, table.id, { to }, c);
      metadata = source.metadata;
      for await (const batch of source.history()) cold.push(...batch);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    assert.equal(
      cold.filter((e) => e.recordType === "cell").length,
      metadata!.cellCount,
    );
    assert.equal(
      cold.filter((e) => e.recordType === "row").length,
      metadata!.rowCount,
    );
    assert.equal(metadata!.interpretations.length, 2);
    const cells = cold.filter((e) => e.recordType === "cell");
    assert.deepEqual((cells[0]!.data as Record<string, unknown>).context, {
      source: "rest",
      requestId: actor.id,
    });
    assert.match(
      String((cells[0]!.data as Record<string, unknown>).changed_at),
      /\.\d{6}Z$/,
    );
    const jobId = newId(),
      leaseToken = newId(),
      archiveId = newId(),
      artifactId = newId();
    const manifest: import("./index.js").HistoryArchiveManifest = {
      formatVersion: 1,
      archiveId,
      orgId: actor.orgId,
      databaseId,
      tableId: table.id,
      from: metadata!.from,
      to,
      snapshotAt: metadata!.snapshotAt,
      cellCount: metadata!.cellCount,
      rowCount: metadata!.rowCount,
      artifactId,
      checksum: "a".repeat(64),
      byteLength: 1234,
      encryptionKeyId: "test-key",
      fingerprint: "fixture-storage-native-range-fingerprint",
      interpretations: metadata!.interpretations,
      verifiedAt: new Date().toISOString(),
    };
    await withOrg(owner!, actor.orgId, async (c) => {
      await c.query(
        "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key,state,lease_token,lease_until) VALUES($1::varchar(26),$2,'history_archive','archiveHistory',$3::jsonb,$4,'table',$5,'{}','hash',$1::text,'running',$6,now()+interval '5 minutes')",
        [
          jobId,
          actor.orgId,
          JSON.stringify(actor),
          actor.id,
          table.id,
          leaseToken,
        ],
      );
      await c.query(
        "INSERT INTO rootset_control.artifacts(id,org_id,job_id,requester_id,target_type,target_id,purpose,object_key,state,format,media_type,byte_length,checksum,encryption_key_id,expires_at) VALUES($1::varchar(26),$2,$3,$4,'table',$5,'history-archive',$1::text,'ready','jsonl','application/x-ndjson',$6,$7,$8,'9999-12-31')",
        [
          artifactId,
          actor.orgId,
          jobId,
          actor.id,
          table.id,
          manifest.byteLength,
          manifest.checksum,
          manifest.encryptionKeyId,
        ],
      );
      await c.query(
        "INSERT INTO rootset_control.history_archives(id,org_id,database_id,table_id,job_id,state,from_time,to_time,artifact_id,manifest,cell_count,row_count,verified_at) VALUES($1,$2,$3,$4,$5,'verified',$6,$7,$8,$9::jsonb,$10,$11,$12)",
        [
          archiveId,
          actor.orgId,
          databaseId,
          table.id,
          jobId,
          manifest.from,
          manifest.to,
          artifactId,
          JSON.stringify(manifest),
          manifest.cellCount,
          manifest.rowCount,
          manifest.verifiedAt,
        ],
      );
    });
    await assert.rejects(
      storage!.publishHistoryArchive(actor, table.id, manifest, {
        jobId,
        leaseToken: newId(),
      }),
      { code: "JOB_LEASE_LOST" },
    );
    const published = await storage!.publishHistoryArchive(
      actor,
      table.id,
      manifest,
      { jobId, leaseToken },
    );
    assert.deepEqual(
      await storage!.publishHistoryArchive(actor, table.id, manifest, {
        jobId,
        leaseToken,
      }),
      published,
    );
    const first = await storage!.purgeArchivedHistory(
      actor,
      table.id,
      archiveId,
      { jobId, leaseToken, batchSize: 1 },
    );
    assert.equal(first.done, false);
    assert.equal(first.deletedCells, 1);
    assert.equal(first.deletedRows, 1);
    const snapshot = await ddl!.connect();
    try {
      await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await snapshot.query("SELECT set_config('rootset.org_id',$1,true)", [
        actor.orgId,
      ]);
      const source = await storage!.snapshotDatabase(
        actor,
        databaseId,
        snapshot,
      );
      assert.equal(
        source.metadata.archiveReferences!.filter(
          (ref) => ref.archiveId === archiveId,
        ).length,
        1,
      );
      const events: Record<string, unknown>[] = [];
      for await (const batch of source.history()) events.push(...batch);
      assert.equal(
        events.filter(
          (e) =>
            ["cell", "row"].includes(String(e.recordType)) &&
            (e.data as Record<string, unknown>).table_id === table.id,
        ).length,
        0,
      );
      assert.equal(
        events.filter(
          (e) =>
            e.recordType === "retentionGap" &&
            (
              (e.data as Record<string, unknown>).manifest as Record<
                string,
                unknown
              >
            ).archiveId === archiveId,
        ).length,
        1,
      );
      await snapshot.query("COMMIT");
    } finally {
      snapshot.release();
    }
    let done = false;
    while (!done)
      done = (
        await storage!.purgeArchivedHistory(actor, table.id, archiveId, {
          jobId,
          leaseToken,
          batchSize: 1,
        })
      ).done;
    const history = await storage!.cellHistory(
      actor,
      table.id,
      row.id,
      table.fields[0]!.id,
    );
    assert.equal(history.data.length, 0);
    assert.equal(history.gaps[0]!.archive_id, archiveId);
    const metrics = (
      await owner!.query<{ events: string }>(
        "SELECT events::text FROM rootset_control.history_metrics WHERE org_id=$1 AND table_id=$2",
        [actor.orgId, table.id],
      )
    ).rows[0];
    assert.equal(Number(metrics?.events ?? 0), 0);
    await owner!.query(
      "UPDATE rootset_control.artifacts SET state='failed' WHERE id=$1",
      [artifactId],
    );
    await assert.rejects(
      withOrg(ddl!, actor.orgId, (c) =>
        storage!.snapshotDatabase(actor, databaseId, c),
      ),
      { code: "BACKUP_UNVERIFIED" },
    );
    await owner!.query(
      "UPDATE rootset_control.artifacts SET state='ready' WHERE id=$1",
      [artifactId],
    );
  },
);

test(
  "Configured quotas cover actual TableStorage schema, rows, history, and concurrent native index publication without SQL reservation forgery",
  { skip: !configured },
  async () => {
    const { CapacityService } = await import("@rootset/capacity");
    const capacity = new CapacityService(owner!);
    const status = () =>
      withOrg(owner!, actor.orgId, (c) => capacity.status(c, actor.orgId));
    const configure = (quota: string | null) =>
      withOrg(owner!, actor.orgId, (c) =>
        capacity.configure(c, {
          organisationOverrides: [{ orgId: actor.orgId, quotaBytes: quota }],
        }),
      );
    try {
      const used = BigInt((await status()).organisation!.usedBytes);
      await configure((used + 33554432n).toString());
      const table = await storage!.createTable(actor, databaseId, {
        name: "Admitted schema and native mutations",
        fields: [
          { apiKey: "code", label: "Code", type: "text", charLimit: 100 },
        ],
      });
      const row = await storage!.createRow(
        actor,
        table.id,
        { code: "first" },
        { idempotencyKey: "capacity-original" },
      );
      const index = await storage!.createIndex(actor, table.id, {
        fieldId: table.fields[0]!.id,
        kind: "btree",
        expectedSchemaVersion: table.schemaVersion,
        idempotencyKey: "capacity-index",
      });
      assert.equal(index.state, "active");
      const schema = await storage!.getTable(actor, table.id);
      const changed = await storage!.createField(actor, table.id, {
        apiKey: "added",
        label: "Added",
        type: "boolean",
        default: false,
        expectedSchemaVersion: schema.schemaVersion,
      });
      assert.equal(changed.rowCount, 1);
      const current = await storage!.getRow(actor, table.id, row.id);
      assert.equal(current.values.added, false);
      const historyBefore = await storage!.cellHistory(
        actor,
        table.id,
        row.id,
        table.fields[0]!.id,
      );
      await assert.rejects(
        withOrg(app!, actor.orgId, async (c) => {
          await c.query(
            "SELECT set_config('rootset.capacity_reserved','true',true)",
          );
          await c.query(
            `UPDATE "${schemaName}"."${table.physicalName}" SET "f_${table.fields[0]!.id.toLowerCase()}"='forged' WHERE row_id=$1`,
            [row.id],
          );
        }),
        (error) =>
          (error as { message: string }).message ===
          "ROOTSET_CAPACITY:STORAGE_RESERVATION_REQUIRED",
      );
      const pressure = BigInt((await status()).organisation!.usedBytes);
      await configure((pressure + 16384n).toString());
      await assert.rejects(
        storage!.updateRow(
          actor,
          table.id,
          row.id,
          { code: "refused" },
          { expectedVersion: current.version },
        ),
        { code: "STORAGE_QUOTA_EXCEEDED" },
      );
      assert.equal(
        (await storage!.getRow(actor, table.id, row.id)).values.code,
        "first",
      );
      assert.equal(
        (
          await storage!.cellHistory(
            actor,
            table.id,
            row.id,
            table.fields[0]!.id,
          )
        ).data.length,
        historyBefore.data.length,
      );
      // Replay is an immutable read of the already committed mutation under pressure.
      assert.equal(
        (
          await storage!.createRow(
            actor,
            table.id,
            { code: "first" },
            { idempotencyKey: "capacity-original" },
          )
        ).id,
        row.id,
      );
      await configure((pressure + 33554432n).toString());
      await storage!.deleteRow(actor, table.id, row.id, {
        expectedVersion: current.version,
      });
      assert.equal((await storage!.getTable(actor, table.id)).rowCount, 0);
      assert.equal(
        (
          await storage!.cellHistory(
            actor,
            table.id,
            row.id,
            table.fields[0]!.id,
          )
        ).data.at(-1)!.operation,
        "delete",
      );
    } finally {
      await configure(null);
    }
  },
);

test(
  "Concurrent index creation never waits on an admission-blocked writer snapshot and preserves unconfigured online edits",
  { skip: !configured },
  async () => {
    const { CapacityService } = await import("@rootset/capacity");
    const capacity = new CapacityService(owner!);
    for (const configuredQuota of [false, true]) {
      const table = await storage!.createTable(actor, databaseId, {
        name: `Live index writer ${configuredQuota}`,
        fields: [
          { apiKey: "code", label: "Code", type: "text", charLimit: 40 },
        ],
      });
      await storage!.createRow(actor, table.id, { code: "initial" });
      if (configuredQuota) {
        const used = BigInt(
          (
            await withOrg(owner!, actor.orgId, (c) =>
              capacity.status(c, actor.orgId),
            )
          ).organisation!.usedBytes,
        );
        await withOrg(owner!, actor.orgId, (c) =>
          capacity.configure(c, {
            organisationOverrides: [
              { orgId: actor.orgId, quotaBytes: (used + 33554432n).toString() },
            ],
          }),
        );
      }
      const blocker = await app!.connect();
      let build:
        Promise<Awaited<ReturnType<TableStorage["createIndex"]>>> | undefined;
      try {
        await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await blocker.query("SELECT set_config('rootset.org_id',$1,true)", [
          actor.orgId,
        ]);
        await blocker.query(
          `SELECT row_id FROM "${schemaName}"."${table.physicalName}"`,
        );
        build = storage!.createIndex(actor, table.id, {
          fieldId: table.fields[0]!.id,
          kind: "btree",
          expectedSchemaVersion: table.schemaVersion,
          idempotencyKey: `live-index-${configuredQuota}`,
        });
        // Attach rejection handling while we observe the deliberately blocked build.
        void build.catch(() => undefined);
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const progress = (
            await owner!.query<{ phase: string }>(
              "SELECT phase FROM pg_stat_progress_create_index WHERE relid=$1::regclass",
              [`"${schemaName}"."${table.physicalName}"`],
            )
          ).rows[0];
          if (progress?.phase.includes("old snapshots")) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(
          waiting,
          true,
          "CIC reached its actual wait for the old reader snapshot",
        );
        const started = Date.now();
        const write = () =>
          storage!.createRow(
            actor,
            table.id,
            { code: "online" },
            { idempotencyKey: `online-write-${configuredQuota}` },
          );
        if (configuredQuota)
          await assert.rejects(write(), { code: "STORAGE_ADMISSION_BUSY" });
        else assert.equal((await write()).values.code, "online");
        assert.ok(
          Date.now() - started < 1000,
          "Competing writer does not block inside a transaction snapshot",
        );
        await blocker.query("COMMIT");
        assert.equal((await build).state, "active");
        build = undefined;
        if (configuredQuota)
          assert.equal((await write()).values.code, "online");
        assert.equal((await storage!.getTable(actor, table.id)).rowCount, 2);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        if (build) await build.catch(() => undefined);
        await withOrg(owner!, actor.orgId, (c) =>
          capacity.configure(c, { organisationOverrides: [] }),
        );
      }
    }
  },
);

async function runningJob(targetId: string, operationId = "createField") {
  const jobId = newId(),
    leaseToken = newId();
  await withOrg(owner!, actor.orgId, (c) =>
    c.query(
      "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key,state,lease_token,lease_until) VALUES($1,$2,'operation',$3,$4::jsonb,$5,'table',$6,'{}','hash',$7,'running',$8,clock_timestamp()+interval '5 minutes')",
      [
        jobId,
        actor.orgId,
        operationId,
        JSON.stringify(actor),
        actor.id,
        targetId,
        `lease-${jobId}`,
        leaseToken,
      ],
    ),
  );
  return { jobId, leaseToken };
}

async function frozenSnapshot(dbId: string) {
  const c = await ddl!.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await c.query("SELECT set_config('rootset.org_id',$1,true)", [actor.orgId]);
    const source = await storage!.snapshotDatabase(actor, dbId, c);
    const rows = new Map<string, import("@rootset/contracts").Row[]>();
    for (const table of source.metadata.tables) {
      const saved: import("@rootset/contracts").Row[] = [];
      for await (const batch of source.rows(table.id)) saved.push(...batch);
      rows.set(table.id, saved);
    }
    const history: Record<string, unknown>[] = [];
    for await (const batch of source.history()) history.push(...batch);
    await c.query("COMMIT");
    return {
      metadata: source.metadata,
      rows: async function* (tableId: string) {
        yield rows.get(tableId)!;
      },
      history: async function* () {
        yield history;
      },
    } satisfies import("./index.js").SnapshotSource;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

test(
  "Worker schema publication rechecks cancellation and authority atomically, and private lease tokens never enter retained history",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Fenced schema worker",
      fields: [{ apiKey: "value", label: "Value", type: "text" }],
    });
    const fence = await runningJob(table.id);
    let checks = 0;
    await assert.rejects(
      storage!.createField(actor, table.id, {
        apiKey: "cancelled",
        label: "Cancelled",
        type: "boolean",
        expectedSchemaVersion: 1,
        idempotencyKey: "cancel-at-publication",
        context: {
          jobId: fence.jobId,
          jobFence: fence,
          beforePublish: async () => {
            if (++checks === 2)
              await owner!.query(
                "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
                [fence.jobId],
              );
          },
        },
      }),
      { code: "JOB_LEASE_LOST" },
    );
    assert.equal(checks, 2);
    assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 1);
    assert.deepEqual(
      (await storage!.getTable(actor, table.id)).fields.map((f) => f.apiKey),
      ["value"],
    );
    await owner!.query(
      "UPDATE rootset_control.jobs SET cancel_requested=false WHERE id=$1",
      [fence.jobId],
    );
    await assert.rejects(
      storage!.createField(actor, table.id, {
        apiKey: "forbidden",
        label: "Forbidden",
        type: "boolean",
        expectedSchemaVersion: 1,
        context: {
          jobFence: fence,
          beforePublish: async () => {
            throw Object.assign(new Error("Credential revoked"), {
              code: "ACCESS_DENIED",
            });
          },
        },
      }),
      { code: "ACCESS_DENIED" },
    );
    const updated = await storage!.createField(actor, table.id, {
      apiKey: "valid",
      label: "Valid",
      type: "boolean",
      expectedSchemaVersion: 1,
      context: {
        jobId: fence.jobId,
        jobFence: fence,
        beforePublish: async () => {
          checks++;
        },
      },
    });
    assert.equal(updated.schemaVersion, 2);
    const retained = await owner!.query<{ body: string }>(
      "SELECT row_to_json(s)::text AS body FROM rootset_control.schema_operations s WHERE s.table_id=$1 UNION ALL SELECT row_to_json(h)::text AS body FROM rootset_control.resource_history h WHERE h.table_id=$1",
      [table.id],
    );
    assert.equal(
      retained.rows.some((r) => r.body.includes(fence.leaseToken)),
      false,
    );
    assert.equal(
      retained.rows.some((r) => r.body.includes("beforePublish")),
      false,
    );
  },
);

test(
  "Verification restores fence every batch and discard copied values and all interpretation metadata while retaining a minimal provenance marker",
  { skip: !configured },
  async () => {
    const database = await storage!.createDatabase(actor, {
      name: "Private verification source",
    });
    const table = await storage!.createTable(actor, database.id, {
      name: "Private copied values",
      fields: [
        {
          apiKey: "secret",
          label: "Private label",
          type: "text",
          charLimit: 80,
        },
      ],
    });
    const row = await storage!.createRow(actor, table.id, {
      secret: "retained-private-value",
    });
    await storage!.updateRow(
      actor,
      table.id,
      row.id,
      { secret: "retained-second-value" },
      { expectedVersion: row.version },
    );
    const source = await frozenSnapshot(database.id);
    const fence = await runningJob(table.id, "verifyBackup");
    const before = Number(
      (
        await owner!.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM rootset_control.restore_provenance WHERE org_id=$1",
          [actor.orgId],
        )
      ).rows[0]!.count,
    );
    await assert.rejects(
      storage!.restoreDatabase(actor, source, {
        name: "Rejected verification",
        jobId: fence.jobId,
        staged: true,
        verification: true,
        jobFence: { ...fence, leaseToken: newId() },
      }),
      { code: "JOB_LEASE_LOST" },
    );
    assert.equal(
      Number(
        (
          await owner!.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM rootset_control.restore_provenance WHERE org_id=$1",
            [actor.orgId],
          )
        ).rows[0]!.count,
      ),
      before,
    );
    const restored = await storage!.restoreDatabase(actor, source, {
      name: "Successful private verification",
      jobId: fence.jobId,
      staged: true,
      verification: true,
      jobFence: fence,
    });
    const mappedTableId = restored.tableMapping[table.id]!;
    assert.equal(
      (
        await owner!.query(
          "SELECT id FROM rootset_control.mutations WHERE table_id=$1",
          [mappedTableId],
        )
      ).rowCount,
      2,
    );
    assert.ok(
      (
        await owner!.query(
          "SELECT id FROM rootset_control.cell_changes WHERE table_id=$1",
          [mappedTableId],
        )
      ).rowCount! > 0,
    );
    await storage!.discardRestore(actor, restored);
    await storage!.discardRestore(actor, restored);
    for (const relation of [
      "cell_changes",
      "row_events",
      "mutations",
      "schema_operations",
      "fields",
      "indexes",
      "unique_rules",
      "history_gaps",
      "query_sessions",
      "history_metrics",
    ])
      assert.equal(
        Number(
          (
            await owner!.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM rootset_control.${relation} WHERE table_id=$1`,
              [mappedTableId],
            )
          ).rows[0]!.count,
        ),
        0,
        `${relation} contains no copied payload`,
      );
    assert.equal(
      (
        await owner!.query(
          "SELECT id FROM rootset_control.tables WHERE id=$1",
          [mappedTableId],
        )
      ).rowCount,
      0,
    );
    const marker = (
      await owner!.query<{ operation: string; body: string }>(
        "SELECT operation,row_to_json(h)::text AS body FROM rootset_control.resource_history h WHERE database_id=$1",
        [restored.databaseId],
      )
    ).rows;
    assert.deepEqual(
      marker.map((r) => r.operation),
      ["database.restore.discard"],
    );
    assert.equal(marker[0]!.body.includes("retained-private-value"), false);
    assert.equal(marker[0]!.body.includes("Private copied values"), false);
    assert.equal(
      (
        await owner!.query<{ state: string }>(
          "SELECT state FROM rootset_control.restore_provenance WHERE database_id=$1",
          [restored.databaseId],
        )
      ).rows[0]!.state,
      "discarded",
    );
  },
);

test(
  "A quota-refused index and a live incomplete index survive backup restoration as inactive definitions with original source attribution",
  { skip: !configured },
  async () => {
    const { CapacityService } = await import("@rootset/capacity");
    const capacity = new CapacityService(owner!);
    const database = await storage!.createDatabase(actor, {
      name: "Incomplete schema source",
    });
    const table = await storage!.createTable(actor, database.id, {
      name: "Index attribution",
      fields: [{ apiKey: "code", label: "Code", type: "text", charLimit: 40 }],
    });
    await storage!.createRow(actor, table.id, { code: "original" });
    const configure = (quotaBytes: string | null) =>
      withOrg(owner!, actor.orgId, (c) =>
        capacity.configure(c, {
          organisationOverrides: [{ orgId: actor.orgId, quotaBytes }],
        }),
      );
    try {
      const used = BigInt(
        (
          await withOrg(owner!, actor.orgId, (c) =>
            capacity.status(c, actor.orgId),
          )
        ).organisation!.usedBytes,
      );
      await configure((used + 1572864n).toString());
      await assert.rejects(
        storage!.createIndex(actor, table.id, {
          fieldId: table.fields[0]!.id,
          kind: "btree",
          expectedSchemaVersion: 1,
          idempotencyKey: "refused-schema-backup",
        }),
        { code: "STORAGE_QUOTA_EXCEEDED" },
      );
    } finally {
      await configure(null);
    }
    assert.equal(
      (await storage!.listIndexes(actor, table.id))[0]!.state,
      "failed",
    );
    const blocker = await app!.connect();
    let build: Promise<import("./index.js").IndexRecord> | undefined;
    let source: import("./index.js").SnapshotSource;
    try {
      await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await blocker.query("SELECT set_config('rootset.org_id',$1,true)", [
        actor.orgId,
      ]);
      await blocker.query(
        `SELECT row_id FROM "${database.schemaName}"."${table.physicalName}"`,
      );
      build = storage!.createIndex(actor, table.id, {
        fieldId: table.fields[0]!.id,
        kind: "btree",
        expectedSchemaVersion: 1,
        idempotencyKey: "pending-schema-backup",
      });
      void build.catch(() => undefined);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const phase = (
          await owner!.query<{ phase: string }>(
            "SELECT phase FROM pg_stat_progress_create_index WHERE relid=$1::regclass",
            [`"${database.schemaName}"."${table.physicalName}"`],
          )
        ).rows[0]?.phase;
        if (phase?.includes("old snapshots")) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true);
      source = await frozenSnapshot(database.id);
      assert.deepEqual(
        source.metadata.tables[0]!.indexes.map((i) => i.state).sort(),
        ["building", "failed"],
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (build) await build;
    }
    const restored = await storage!.restoreDatabase(actor, source!, {
      name: "Restored inactive definitions",
      jobId: newId(),
      staged: true,
      verification: true,
    });
    const restoredTableId = restored.tableMapping[table.id]!;
    const indices = await storage!
      .listIndexes(actor, restoredTableId)
      .catch(async () =>
        withOrg(ddl!, actor.orgId, async (c) => {
          return (
            await storage!.snapshotDatabase(actor, restored.databaseId, c, {
              includeStaged: true,
            })
          ).metadata.tables[0]!.indexes;
        }),
      );
    const actual = (
      await owner!.query<{
        state: string;
        error: { code?: string };
        physical_name: string;
      }>(
        "SELECT state,error,physical_name FROM rootset_control.indexes WHERE table_id=$1 ORDER BY id",
        [restoredTableId],
      )
    ).rows;
    assert.deepEqual(
      actual.map((i) => i.state),
      ["failed", "failed"],
    );
    assert.equal(
      actual.some((i) => i.error?.code === "RESTORED_PENDING_INDEX"),
      true,
    );
    for (const index of actual)
      assert.equal(
        (
          await owner!.query<{ present: string | null }>(
            "SELECT to_regclass($1)::text AS present",
            [`rsd_${restored.databaseId.toLowerCase()}.${index.physical_name}`],
          )
        ).rows[0]!.present,
        null,
      );
    assert.equal(indices.length, 2);
    await withOrg(ddl!, actor.orgId, async (c) => {
      const verified = await storage!.snapshotDatabase(
        actor,
        restored.databaseId,
        c,
        { includeStaged: true },
      );
      assert.deepEqual(
        verified.metadata.tables[0]!.indexes.map((i) => i.state).sort(),
        ["building", "failed"],
      );
    });
    await storage!.discardRestore(actor, restored);
  },
);

test(
  "Native unique rules use exact typed grouping and extend the SQL budget only for a current authorised queued worker",
  { skip: !configured },
  async () => {
    const url = new URL(process.env.ROOTSET_TEST_DDL_DATABASE_URL!);
    url.pathname = `/${isolatedName}`;
    const observedPool = createPool(url.toString(), 2);
    const observations: { timeout: string; sql: string }[] = [];
    observedPool.on(
      "connect",
      (client: import("@rootset/database").PoolClient) => {
        const execute = client.query.bind(client) as unknown as (
          sql: string,
          parameters?: unknown[],
        ) => Promise<{ rows: Record<string, unknown>[] }>;
        client.query = (async (sql: string, parameters?: unknown[]) => {
          if (typeof sql === "string" && sql.includes("HAVING count(*)>1")) {
            const setting = await execute("SHOW statement_timeout");
            observations.push({
              timeout: String(setting.rows[0]!.statement_timeout),
              sql,
            });
          }
          return execute(sql, parameters);
        }) as typeof client.query;
      },
    );
    const observed = new TableStorage({
      pool: app!,
      ddlPool: observedPool,
      cursorSecret: "unique-rule-budget-regression-secret-at-least-32-bytes",
    });
    const fixture = async (label: string, duplicates = false) => {
      const table = await observed.createTable(actor, databaseId, {
        name: label,
        fields: [
          { apiKey: "code", label: "Code", type: "text", charLimit: 40 },
          { apiKey: "count", label: "Count", type: "integer" },
          { apiKey: "rate", label: "Rate", type: "float" },
        ],
      });
      await observed.mutateRows(actor, table.id, {
        operations: [
          { kind: "create", values: { code: "Case", count: 1, rate: 0 } },
          {
            kind: "create",
            values: { code: duplicates ? "Case" : "case", count: 1, rate: -0 },
          },
          { kind: "create", values: { code: null, count: 1, rate: 0 } },
          { kind: "create", values: { code: null, count: 1, rate: 0 } },
        ],
      });
      return table;
    };
    try {
      const ordinary = await fixture("Ordinary typed grouping");
      assert.equal(
        (
          await observed.createUniqueRule(actor, ordinary.id, {
            fieldIds: ordinary.fields.map((f) => f.id),
            expectedSchemaVersion: 1,
          })
        ).strategy,
        "native",
      );
      assert.equal(observations.at(-1)!.timeout, "10s");
      assert.ok(observations.at(-1)!.sql.startsWith("WITH duplicates AS"));
      assert.equal(observations.at(-1)!.sql.includes("canonical_json"), false);
      const worker = await fixture("Queued typed grouping");
      const fence = await runningJob(worker.id, "createUniqueRule");
      assert.equal(
        (
          await observed.createUniqueRule(actor, worker.id, {
            fieldIds: worker.fields.map((f) => f.id),
            expectedSchemaVersion: 1,
            context: { jobFence: fence },
          })
        ).state,
        "active",
      );
      assert.equal(observations.at(-1)!.timeout, "0");
      const expired = await fixture("Expired queued grouping");
      const deadFence = await runningJob(expired.id, "createUniqueRule");
      await owner!.query(
        "UPDATE rootset_control.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [deadFence.jobId],
      );
      const scans = observations.length;
      await assert.rejects(
        observed.createUniqueRule(actor, expired.id, {
          fieldIds: expired.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
          context: { jobFence: deadFence },
        }),
        { code: "JOB_LEASE_LOST" },
      );
      await assert.rejects(
        observed.createUniqueRule(actor, expired.id, {
          fieldIds: expired.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
          context: {
            jobFence: fence,
            beforePublish: async () => {
              throw Object.assign(new Error("Authority revoked"), {
                code: "ACCESS_DENIED",
              });
            },
          },
        }),
        { code: "ACCESS_DENIED" },
      );
      assert.equal(observations.length, scans);
      assert.equal(
        (await observed.listUniqueRules(actor, expired.id)).length,
        0,
      );
      const duplicate = await fixture("Signed-zero duplicates", true);
      await assert.rejects(
        observed.createUniqueRule(actor, duplicate.id, {
          fieldIds: duplicate.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
        }),
        (error) => {
          const result = error as {
            code: string;
            details: { conflicts: { count: number; rowIds: string[] }[] };
          };
          assert.equal(result.code, "UNIQUE_CONFLICT");
          assert.equal(result.details.conflicts[0]!.count, 2);
          assert.equal(result.details.conflicts[0]!.rowIds.length, 2);
          return true;
        },
      );
      const cancelled = await fixture("Cancellation at rule publication");
      const cancelledFence = await runningJob(cancelled.id, "createUniqueRule");
      let checks = 0;
      await assert.rejects(
        observed.createUniqueRule(actor, cancelled.id, {
          fieldIds: cancelled.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
          context: {
            jobFence: cancelledFence,
            beforePublish: async () => {
              if (++checks === 2)
                await owner!.query(
                  "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
                  [cancelledFence.jobId],
                );
            },
          },
        }),
        { code: "JOB_LEASE_LOST" },
      );
      assert.equal(checks, 2);
      assert.equal(
        (await observed.getTable(actor, cancelled.id)).schemaVersion,
        1,
      );
      assert.equal(
        (await observed.listUniqueRules(actor, cancelled.id)).length,
        0,
      );
      assert.equal(
        (
          await owner!.query(
            "SELECT c.oid FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE i.indrelid=$1::regclass AND c.relname LIKE 'rsu_%'",
            [`"${schemaName}"."${cancelled.physicalName}"`],
          )
        ).rowCount,
        0,
      );
    } finally {
      await observedPool.end();
    }
  },
);

test(
  "Rule idempotency replays the exact durable outcome when names share fields and after subsequent rule deletion",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Exact rule result",
      fields: [{ apiKey: "code", label: "Code", type: "text", charLimit: 20 }],
    });
    const firstInput = {
      name: "First named rule",
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: 1,
      idempotencyKey: "first-exact-rule",
    };
    const secondInput = {
      name: "Second named rule",
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: 2,
      idempotencyKey: "second-exact-rule",
    };
    const first = await storage!.createUniqueRule(actor, table.id, firstInput);
    const second = await storage!.createUniqueRule(
      actor,
      table.id,
      secondInput,
    );
    assert.notEqual(second.id, first.id);
    const restarted = new TableStorage({
      pool: app!,
      ddlPool: ddl!,
      cursorSecret: "restarted-rule-outcome-secret-at-least-thirty-two-bytes",
    });
    assert.deepEqual(
      await restarted.createUniqueRule(actor, table.id, secondInput),
      second,
    );
    await restarted.deleteUniqueRule(actor, table.id, second.id, {
      expectedSchemaVersion: 3,
    });
    const afterDeletion = await restarted.getTable(actor, table.id);
    assert.equal(
      (await restarted.listUniqueRules(actor, table.id)).some(
        (rule) => rule.id === second.id,
      ),
      false,
    );
    assert.equal(afterDeletion.schemaVersion, 4);
    assert.deepEqual(
      await restarted.createUniqueRule(actor, table.id, secondInput),
      second,
    );
    const saved = (
      await owner!.query<{ plan: { ruleId: string; outcome: unknown } }>(
        "SELECT plan FROM rootset_control.schema_operations WHERE org_id=$1 AND idempotency_key=$2",
        [actor.orgId, secondInput.idempotencyKey],
      )
    ).rows[0]!.plan;
    assert.equal(saved.ruleId, second.id);
    assert.deepEqual(saved.outcome, second);
    await owner!.query(
      "UPDATE rootset_control.schema_operations SET plan=plan-'outcome' WHERE org_id=$1 AND idempotency_key=$2",
      [actor.orgId, secondInput.idempotencyKey],
    );
    await assert.rejects(
      restarted.createUniqueRule(actor, table.id, secondInput),
      { code: "INTERNAL_ERROR", status: 500 },
    );
    assert.equal((await restarted.getTable(actor, table.id)).schemaVersion, 4);
    assert.equal((await restarted.listUniqueRules(actor, table.id)).length, 1);
  },
);

test(
  "Conversions rebuild unaffected native, trigram and JSON indexes on the authoritative generation and preserve registry uniqueness across repeated conversion and replay",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Generation enforcement",
      fields: [
        { apiKey: "code", label: "Code", type: "text", charLimit: 30 },
        { apiKey: "wide", label: "Wide", type: "text", charLimit: 4000 },
        { apiKey: "value", label: "Value", type: "float" },
        { apiKey: "payload", label: "Payload", type: "json" },
      ],
    });
    const native = await storage!.createUniqueRule(actor, table.id, {
      name: "Native unchanged",
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: 1,
    });
    const registry = await storage!.createUniqueRule(actor, table.id, {
      name: "Registry unchanged",
      fieldIds: [table.fields[1]!.id],
      expectedSchemaVersion: 2,
    });
    assert.equal(registry.strategy, "registry");
    for (const [index, kind] of (
      ["btree", "trigram", "json"] as const
    ).entries())
      await storage!.createIndex(actor, table.id, {
        fieldId: table.fields[kind === "json" ? 3 : 0]!.id,
        kind,
        expectedSchemaVersion: 3 + index,
      });
    const rows = [];
    for (let i = 0; i < 3; i++)
      rows.push(
        await storage!.createRow(actor, table.id, {
          code: `code-${i}`,
          wide: `wide-${i}`,
          value: i + 0.25,
          payload: { keep: i },
        }),
      );
    const jobFence = await runningJob(table.id, "updateField");
    const requestId = newId();
    const input = {
      type: "text" as const,
      conversion: { strategy: "stringify" as const },
      expectedSchemaVersion: 6,
      idempotencyKey: "generation-stringify",
      context: {
        source: "mcp" as const,
        requestId,
        jobId: jobFence.jobId,
        jobFence,
      },
    };
    const converted = await storage!.updateField(
      actor,
      table.id,
      table.fields[2]!.id,
      input,
    );
    assert.equal(converted.generation, 2);
    for (const relation of ["mutations", "cell_changes", "resource_history"]) {
      const records = await owner!.query<{ context: unknown; body: string }>(
        `SELECT context,row_to_json(r)::text AS body FROM rootset_control.${relation} r WHERE table_id=$1 AND context->>'jobId'=$2`,
        [table.id, jobFence.jobId],
      );
      assert.ok(records.rowCount! > 0);
      for (const record of records.rows) {
        assert.deepEqual(record.context, {
          source: "schema",
          requestId,
          jobId: jobFence.jobId,
        });
        assert.equal(record.body.includes(jobFence.leaseToken), false);
        assert.equal(record.body.includes("jobFence"), false);
      }
    }
    async function enforcement(current: typeof converted) {
      const rules = await storage!.listUniqueRules(actor, table.id),
        indexes = await storage!.listIndexes(actor, table.id);
      assert.deepEqual(
        rules.map((r) => r.id).sort(),
        [native.id, registry.id].sort(),
      );
      for (const definition of [
        ...rules.filter((r) => r.strategy === "native"),
        ...indexes,
      ]) {
        const info = (
          await owner!.query<{
            relid: string;
            valid: boolean;
            definition: string;
          }>(
            "SELECT i.indrelid::regclass::text AS relid,i.indisvalid AS valid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i WHERE i.indexrelid=$1::regclass",
            [`"${current.schemaName}"."${definition.physicalName}"`],
          )
        ).rows[0]!;
        assert.equal(
          info.relid,
          `${current.schemaName}.${current.physicalName}`,
        );
        assert.equal(info.valid, true);
        if ("kind" in definition && definition.kind === "trigram")
          assert.ok(info.definition.includes("gin_trgm_ops"));
        if ("kind" in definition && definition.kind === "json")
          assert.ok(info.definition.includes("USING gin"));
      }
      const value = current.fields[2]!.type === "text" ? "7" : 7;
      await assert.rejects(
        storage!.createRow(actor, table.id, {
          code: "code-0",
          wide: "unused-wide",
          value,
          payload: null,
        }),
        { code: "UNIQUE_CONFLICT" },
      );
      await assert.rejects(
        storage!.createRow(actor, table.id, {
          code: "unused-code",
          wide: "wide-0",
          value,
          payload: null,
        }),
        { code: "UNIQUE_CONFLICT" },
      );
      assert.equal((await storage!.getTable(actor, table.id)).rowCount, 3);
    }
    await enforcement(converted);
    assert.equal(
      (await storage!.updateField(actor, table.id, table.fields[2]!.id, input))
        .generation,
      2,
    );
    assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 7);
    const reverted = await storage!.updateField(
      actor,
      table.id,
      table.fields[2]!.id,
      {
        type: "float",
        conversion: { strategy: "parse" },
        expectedSchemaVersion: 7,
        idempotencyKey: "generation-parse",
      },
    );
    assert.equal(reverted.generation, 3);
    await enforcement(reverted);
    for (const row of rows)
      assert.equal(
        (await storage!.getRow(actor, table.id, row.id)).version,
        "3",
      );
    assert.equal(
      (
        await owner!.query(
          "SELECT id FROM rootset_control.cell_changes WHERE table_id=$1 AND operation='conversion'",
          [table.id],
        )
      ).rowCount,
      6,
    );
  },
);

test(
  "Restart reconciliation publishes an actually built index after SIGKILL before metadata cutover, then exact retry increments the schema only once",
  { skip: !configured },
  async () => {
    const { spawn } = await import("node:child_process");
    const table = await storage!.createTable(actor, databaseId, {
      name: "Killed valid native build",
      fields: [{ apiKey: "code", label: "Code", type: "text", charLimit: 30 }],
    });
    await storage!.createRow(actor, table.id, { code: "kept" });
    const appUrl = new URL(process.env.ROOTSET_TEST_APP_DATABASE_URL!),
      ddlUrl = new URL(process.env.ROOTSET_TEST_DDL_DATABASE_URL!);
    appUrl.pathname = ddlUrl.pathname = `/${isolatedName}`;
    const input = {
      fieldId: table.fields[0]!.id,
      kind: "btree" as const,
      expectedSchemaVersion: 1,
      idempotencyKey: "actual-killed-index",
    };
    const program = `import {TableStorage} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};import {createPool} from '@rootset/database';const app=createPool(process.env.PROBE_APP_URL),ddl=createPool(process.env.PROBE_DDL_URL);const storage=new TableStorage({pool:app,ddlPool:ddl,cursorSecret:'child-index-restart-secret-at-least-thirty-two-bytes'});let calls=0;await storage.createIndex(${JSON.stringify(actor)},${JSON.stringify(table.id)},{...${JSON.stringify(input)},context:{beforePublish:async()=>{if(++calls===2){process.send({nativeBuilt:true});await new Promise(()=>{});}}}});`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", program],
      {
        env: {
          ...process.env,
          PROBE_APP_URL: appUrl.toString(),
          PROBE_DDL_URL: ddlUrl.toString(),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk.toString()));
    const ended = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Native index checkpoint missing: " + stderr)),
          5000,
        );
        child.once("message", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("Child exited before checkpoint: " + stderr));
        });
      });
      const pending = await storage!.listIndexes(actor, table.id);
      assert.equal(pending[0]!.state, "building");
      assert.equal(
        (
          await owner!.query<{ valid: boolean }>(
            "SELECT indisvalid AS valid FROM pg_index WHERE indexrelid=$1::regclass",
            [`"${schemaName}"."${pending[0]!.physicalName}"`],
          )
        ).rows[0]!.valid,
        true,
      );
      child.kill("SIGKILL");
      assert.equal((await ended).signal, "SIGKILL");
      const restarted = new TableStorage({
        pool: app!,
        ddlPool: ddl!,
        cursorSecret:
          "index-restart-verification-secret-at-least-thirty-two-bytes",
      });
      assert.equal(
        (await restarted.reconcileSchemaOperations(actor)).recovered.length,
        1,
      );
      assert.equal(
        (await restarted.createIndex(actor, table.id, input)).id,
        pending[0]!.id,
      );
      assert.equal(
        (await restarted.getTable(actor, table.id)).schemaVersion,
        2,
      );
      assert.equal(
        (await restarted.listIndexes(actor, table.id))[0]!.state,
        "active",
      );
      assert.equal((await restarted.getTable(actor, table.id)).rowCount, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await ended;
    }
  },
);
