import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, migrate, withOrg, type Pool } from "@rootset/database";
import {
  FieldDefinitionSchema,
  newId,
  RootsetError,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";
import { TableStorage } from "./index.js";
import {
  restoredId,
  type RestoreHistoryKind,
  type RestoreHistoryRecord,
  type RestoreRow,
  type RestoreSource,
  type RestoreTable,
} from "./restore.js";

const configured = Boolean(process.env.ROOTSET_TEST_DATABASE_URL);
const isolatedName = `rootset_restore_${newId().toLowerCase()}`;
const actor: Actor = {
  id: newId(),
  orgId: newId(),
  kind: "operator",
  role: "admin",
  scopes: ["viewer", "member", "admin"],
};
const stamp = "2026-10-17T01:02:03.123456Z";
let admin: Pool, pool: Pool, storage: TableStorage, sourceDatabaseId: string;
before(async () => {
  if (!configured) return;
  const url = new URL(process.env.ROOTSET_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  admin = createPool(url.href, 1);
  await admin.query(`CREATE DATABASE "${isolatedName}" TEMPLATE template0`);
  url.pathname = `/${isolatedName}`;
  pool = createPool(url.href, 12);
  await migrate(pool);
  await pool.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Restore tests')",
    [actor.orgId],
  );
  storage = new TableStorage({
    pool,
    ddlPool: pool,
    cursorSecret: "restore-tests-secret-over-thirty-two-bytes",
  });
  sourceDatabaseId = (
    await storage.createDatabase(actor, { name: "Source stays intact" })
  ).id;
  await pool.query(
    "INSERT INTO rootset_control.users(id,name,email) VALUES($1,'Original owner','owner@example.test')",
    [actor.id],
  );
});
after(async () => {
  await pool?.end();
  if (admin) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}"`);
    } finally {
      await admin.end();
    }
  }
});

function fixture() {
  const definitions = [
    { name: "RECORD_ID", type: "integer", required: true, autoIncrement: true },
    { name: "CODE", type: "text", required: true, charLimit: 12 },
    { name: "EDITION", type: "integer", required: true },
    { name: "PARENT_CODE", type: "text", charLimit: 12 },
    { name: "PARENT_EDITION", type: "integer" },
    { name: "ENABLED", type: "boolean", default: false },
    { name: "NOTE", type: "text" },
    {
      name: "PAYLOAD",
      type: "json",
      zodSchema:
        "z.object({ id: z.string(), zero: z.literal(0), flag: z.boolean() })",
    },
    { name: "WEIGHT", type: "float", default: 1e100 },
  ];
  const fields = definitions.map((field, order) =>
    FieldDefinitionSchema.parse({ ...field, id: newId(), order }),
  );
  const table: RestoreTable = {
    id: newId(),
    name: "Restored records",
    description: "Exact logical snapshot",
    state: "active",
    schemaVersion: 8,
    rowCount: 2,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    fields,
    allFields: fields.map((definition, position) => ({
      id: definition.id,
      name: definition.name,
      definition,
      position,
      state: "active",
      createdAt: stamp,
      deletedAt: null,
    })),
    uniqueRules: [
      {
        id: newId(),
        name: "Composite identity",
        fieldIds: [fields[1]!.id, fields[2]!.id],
        strategy: "native",
      },
      {
        id: newId(),
        name: "Enabled notes",
        fieldIds: [fields[6]!.id],
        where: { field: fields[5]!.id, op: "eq", value: true },
        strategy: "registry",
      },
    ],
    foreignKeys: [],
    counters: [{ fieldId: fields[0]!.id, nextValue: "12" }],
  };
  table.foreignKeys = [
    {
      id: newId(),
      fieldIds: [fields[3]!.id, fields[4]!.id],
      referencedTableId: table.id,
      referencedFieldIds: [fields[1]!.id, fields[2]!.id],
      referencedRuleId: table.uniqueRules[0]!.id,
    },
  ];
  const values = (named: JsonValue[]) =>
    Object.fromEntries(fields.map((field, index) => [field.id, named[index]!]));
  const records: RestoreRow[] = [
    {
      id: newId(),
      version: "7",
      createdAt: stamp,
      updatedAt: stamp,
      values: values([
        10,
        "001",
        0,
        null,
        null,
        false,
        "",
        { id: table.id, zero: 0, flag: false },
        1e100,
      ]),
    },
    {
      id: newId(),
      version: "9",
      createdAt: stamp,
      updatedAt: stamp,
      values: values([11, "002", 1, "001", 0, true, "Unique note", null, 0]),
    },
  ];
  const empty: RestoreTable = {
    ...table,
    id: newId(),
    name: "Empty",
    rowCount: 0,
    fields: [],
    allFields: [],
    uniqueRules: [],
    foreignKeys: [],
    counters: [],
  };
  const deleted: RestoreTable = {
    ...empty,
    id: newId(),
    name: "Archived catalog",
    state: "deleted",
    deletedAt: stamp,
  };
  const mutationId = newId();
  const history: Record<RestoreHistoryKind, RestoreHistoryRecord[]> = {
    comments: [],
    mutations: [],
    "cell-changes": [],
    "resource-history": [],
    views: [],
  };
  const entry = (kind: RestoreHistoryKind, value: Record<string, unknown>) =>
    history[kind].push({ value, numbers: [] });
  entry("mutations", {
    id: mutationId,
    table_id: table.id,
    actor: { kind: "session", id: actor.id },
    context: { source: "ui" },
    schema_version: 8,
    committed_at: stamp,
  });
  entry("comments", {
    id: newId(),
    org_id: actor.orgId,
    table_id: table.id,
    row_id: records[0]!.id,
    author_user_id: null,
    author_name_snapshot: "Original author",
    actor: { kind: "session", id: newId() },
    body: "**Retained** comment",
    created_at: stamp,
    deleted_at: null,
  });
  entry("cell-changes", {
    id: "1",
    public_id: newId(),
    org_id: actor.orgId,
    database_id: sourceDatabaseId,
    table_id: table.id,
    row_id: records[0]!.id,
    field_id: fields[6]!.id,
    mutation_id: mutationId,
    old_value: null,
    new_value: "",
    field_definition: fields[6],
    old_version: "6",
    new_version: "7",
    operation: "update",
    actor: { kind: "session", id: actor.id },
    context: { source: "ui" },
    changed_at: stamp,
  });
  entry("resource-history", {
    id: "1",
    org_id: actor.orgId,
    database_id: sourceDatabaseId,
    table_id: table.id,
    resource_id: fields[6]!.id,
    operation: "field.create",
    before_value: null,
    after_value: { definition: fields[6] },
    actor: { kind: "session", id: actor.id },
    context: { source: "ui" },
    changed_at: stamp,
  });
  const view = {
    id: newId(),
    org_id: actor.orgId,
    table_id: table.id,
    owner_user_id: actor.id,
    owner_name_snapshot: "Original owner",
    name: "Needs review",
    visibility: "personal",
    definition: {
      frozenColumns: 0,
      query: { where: { field: fields[1]!.id, op: "eq", value: table.id } },
      columnOrder: fields.map((field) => field.id),
      hiddenColumns: [fields[5]!.id],
      columnWidths: { [fields[1]!.id]: 180 },
    },
    schema_version: 8,
    version: "3",
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  };
  entry("views", view);
  entry("views", {
    ...view,
    id: newId(),
    name: "Missing owner",
    owner_user_id: newId(),
  });
  const source: RestoreSource = {
    database: {
      id: sourceDatabaseId,
      name: "Source stays intact",
      description: "Preserved description",
    },
    tables: [table, empty, deleted],
    async *rows(id) {
      if (id === table.id) yield records;
    },
    async *history(kind) {
      if (history[kind].length) yield history[kind];
    },
    async check() {},
  };
  return { source, table, fields, records, history, view };
}
async function request() {
  const jobId = newId(),
    backupId = newId(),
    databaseId = newId(),
    checksum = "a".repeat(64);
  await withOrg(pool, actor.orgId, async (c) => {
    await c.query(
      "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key) VALUES($1,$2,'restore','restoreDatabaseBackup',$3,$4,'organisation',$2,'{}',$5,$6)",
      [jobId, actor.orgId, JSON.stringify(actor), actor.id, checksum, jobId],
    );
    await c.query(
      "INSERT INTO rootset_control.database_backups(id,org_id,database_id,kind,trigger,scheduled_at,bucket,prefix,backend_id,published,result,snapshot_at,object_key,byte_length,checksum,completed_at) VALUES($1,$2,$3,'backup','manual',now(),'test','test','test',true,'{}',$4,'test.rootset-backup',1,$5,now())",
      [backupId, actor.orgId, sourceDatabaseId, stamp, checksum],
    );
  });
  return {
    databaseId,
    name: "Recovered snapshot",
    backupId,
    checksum,
    snapshotAt: stamp,
    jobId,
  };
}
async function absent(databaseId: string) {
  const result = await withOrg(pool, actor.orgId, (c) =>
    c.query(
      "SELECT (SELECT count(*)::int FROM rootset_control.databases WHERE id=$1) AS databases,(SELECT count(*)::int FROM rootset_control.tables WHERE database_id=$1) AS tables,(SELECT count(*)::int FROM pg_namespace WHERE nspname=$2) AS schemas,(SELECT count(*)::int FROM rootset_control.restore_results WHERE database_id=$1) AS receipts",
      [databaseId, `rsd_${databaseId.toLowerCase()}`],
    ),
  );
  assert.deepEqual(result.rows[0], {
    databases: 0,
    tables: 0,
    schemas: 0,
    receipts: 0,
  });
}

test(
  "restore publishes a new database with exact records, constraints, counters, history and owned views",
  { skip: !configured },
  async () => {
    const { source, table, fields, records, history, view } = fixture(),
      input = await request();
    const sourceBefore = await storage.getDatabase(actor, sourceDatabaseId);
    const result = await storage.restoreDatabase(actor, input, source, {
      context: { source: "schema" },
    });
    assert.deepEqual(result, {
      databaseId: input.databaseId,
      sourceDatabaseId,
      sourceBackupId: input.backupId,
      snapshotAt: stamp,
      tableCount: 2,
      rowCount: 2,
      commentCount: 1,
      historyEvents: 2,
      mutationCount: 1,
      viewCount: 1,
      skippedPersonalViews: 1,
    });
    assert.deepEqual(
      await storage.getDatabase(actor, sourceDatabaseId),
      sourceBefore,
    );
    const tableId = restoredId(input.databaseId, "table", table.id);
    const restored = await storage.getTable(actor, tableId);
    const payloadField = restored.fields.find(
      (field) => field.name === "PAYLOAD",
    )!;
    assert.equal(
      payloadField.zodSchema,
      fields.find((field) => field.type === "json")!.zodSchema,
    );
    await withOrg(pool, actor.orgId, async (client) => {
      const constraint = await client.query(
        "SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2",
        [
          `${restored.schemaName}.${restored.physicalName}`,
          `rsj_${payloadField.id.toLowerCase()}`,
        ],
      );
      assert.equal(constraint.rowCount, 1);
    });
    assert.equal(restored.schemaVersion, 8);
    assert.equal(restored.rowCount, 2);
    const summary = (await storage.listTables(actor, input.databaseId)).find(
      (entry) => entry.id === tableId,
    )!;
    assert.equal(summary.fieldCount, fields.length);
    assert.ok(summary.lastDataChangeAt && summary.lastDataChangeAt > stamp);
    const databaseSummary = (await storage.listDatabases(actor)).find(
      (entry) => entry.id === input.databaseId,
    )!;
    assert.equal(databaseSummary.rowCount, 2);
    assert.equal(databaseSummary.lastDataChangeAt, summary.lastDataChangeAt);
    assert.ok(
      restored.fields.every((field, index) => field.id !== fields[index]!.id),
    );
    const row = await storage.getRow(actor, tableId, records[0]!.id);
    assert.equal(row.version, "7");
    assert.deepEqual(row.values, {
      RECORD_ID: 10,
      CODE: "001",
      EDITION: 0,
      PARENT_CODE: null,
      PARENT_EDITION: null,
      ENABLED: false,
      NOTE: "",
      PAYLOAD: { id: table.id, zero: 0, flag: false },
      WEIGHT: 1e100,
    });
    await withOrg(pool, actor.orgId, async (c) => {
      const raw = (
        await c.query(
          `SELECT created_at::text,updated_at::text FROM "${restored.schemaName}"."${restored.physicalName}" WHERE row_id=$1`,
          [row.id],
        )
      ).rows[0]!;
      assert.match(raw.created_at, /03\.123456\+00$/);
      assert.match(raw.updated_at, /03\.123456\+00$/);
      const comment = (
        await c.query(
          "SELECT id,body,author_name_snapshot,created_at::text FROM rootset_control.row_comments WHERE table_id=$1",
          [tableId],
        )
      ).rows[0]!;
      assert.equal(
        comment.id,
        restoredId(
          input.databaseId,
          "comment",
          String(history.comments[0]!.value.id),
        ),
      );
      assert.equal(comment.body, "**Retained** comment");
      assert.match(comment.created_at, /03\.123456\+00$/);
      const mutation = (
        await c.query(
          "SELECT idempotency_key,outcome,committed_at::text FROM rootset_control.mutations WHERE table_id=$1",
          [tableId],
        )
      ).rows[0]!;
      assert.equal(mutation.idempotency_key, null);
      assert.equal(mutation.outcome, null);
      assert.match(mutation.committed_at, /03\.123456\+00$/);
      const saved = (
        await c.query(
          "SELECT owner_user_id,definition,version::text FROM rootset_control.saved_views WHERE table_id=$1",
          [tableId],
        )
      ).rows[0]!;
      assert.equal(saved.owner_user_id, actor.id);
      assert.equal(saved.version, "3");
      assert.deepEqual(saved.definition.query.where, {
        field: restoredId(input.databaseId, "field", fields[1]!.id),
        op: "eq",
        value: table.id,
      });
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM rootset_control.backup_schedules WHERE database_id=$1",
            [input.databaseId],
          )
        ).rows[0]!.n,
        0,
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM rootset_control.saved_views WHERE id=$1",
            [restoredId(input.databaseId, "view", String(view.id))],
          )
        ).rows[0]!.n,
        1,
      );
    });
    await assert.rejects(
      storage.createRow(actor, tableId, {
        CODE: "003",
        EDITION: 0,
        PARENT_CODE: "missing",
        PARENT_EDITION: 0,
      }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    await assert.rejects(
      storage.createRow(actor, tableId, { CODE: "002", EDITION: 1 }),
      { code: "UNIQUE_CONFLICT" },
    );
    await assert.rejects(
      storage.createRow(actor, tableId, {
        CODE: "003",
        EDITION: 0,
        ENABLED: true,
        NOTE: "Unique note",
      }),
      { code: "UNIQUE_CONFLICT" },
    );
    const next = await storage.createRow(actor, tableId, {
      CODE: "003",
      EDITION: 0,
      PARENT_CODE: "001",
      PARENT_EDITION: 0,
    });
    assert.equal(next.values.RECORD_ID, 12);
    assert.equal(next.values.ENABLED, false);
    assert.equal(next.values.WEIGHT, 1e100);
    assert.deepEqual(
      await storage.restoreDatabase(actor, input, source, { context: {} }),
      result,
    );
    await assert.rejects(
      storage.restoreDatabase(
        actor,
        { ...input, checksum: "b".repeat(64) },
        source,
        { context: {} },
      ),
      { code: "VALIDATION_FAILED" },
    );
  },
);

test(
  "restore rolls back all staged objects for invalid relationships, counters and current authority loss",
  { skip: !configured },
  async () => {
    for (const failure of [
      "relationship",
      "counter",
      "authority",
      "cancel",
    ] as const) {
      const { source, table, records } = fixture(),
        input = await request();
      if (failure === "relationship")
        records[1]!.values[table.fields[3]!.id] = "missing";
      if (failure === "counter") table.counters[0]!.nextValue = "10";
      if (failure === "cancel")
        source.check = async () => {
          if (
            (
              await withOrg(pool, actor.orgId, (c) =>
                c.query(
                  "SELECT count(*)::int AS n FROM rootset_control.databases WHERE id=$1",
                  [input.databaseId],
                ),
              )
            ).rows[0]!.n !== 0
          )
            throw Error("uncommitted database leaked");
        };
      let progressed = false;
      await assert.rejects(
        storage.restoreDatabase(actor, input, source, {
          context: {
            beforePublish: async () => {
              if (failure === "authority")
                throw new RootsetError(
                  "ACCESS_DENIED",
                  "Authority revoked",
                  403,
                );
            },
          },
          progress: async (stage) => {
            progressed = true;
            if (failure === "cancel" && stage === "restoring_rows")
              throw new RootsetError("JOB_CANCELLED", "Cancelled", 409);
          },
        }),
        failure === "relationship"
          ? { code: "FOREIGN_KEY_CONFLICT" }
          : failure === "counter"
            ? { code: "VALIDATION_FAILED" }
            : failure === "authority"
              ? { code: "ACCESS_DENIED" }
              : { code: "JOB_CANCELLED" },
      );
      assert.equal(progressed, true);
      await absent(input.databaseId);
      assert.equal(
        (await storage.getDatabase(actor, sourceDatabaseId)).name,
        "Source stays intact",
      );
    }
  },
);
