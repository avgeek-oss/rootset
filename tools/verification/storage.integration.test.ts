import assert from "node:assert/strict";
import { before, after } from "node:test";
import {
  newId,
  rowBytes,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import {
  TableStorage,
  type FieldInput,
  type TableRecord,
} from "../../packages/table-storage/src/index.js";
import { fieldColumn } from "../../packages/table-storage/src/query.js";
import { fixtureSecret } from "./environment.js";
import { isolatedDatabase } from "./isolated-database.js";
import { verificationCase } from "./evidence.js";

let pools: Awaited<ReturnType<typeof isolatedDatabase>>;
let storage: TableStorage;
const orgId = newId();
const otherOrgId = newId();
const actor: Actor = {
  id: `fixture:${newId()}`,
  orgId,
  kind: "session",
  userId: newId(),
  role: "admin",
  scopes: [],
  membershipVersion: 1,
};
let databaseId: string;
let schemaName: string;

before(async () => {
  pools = await isolatedDatabase();
  storage = new TableStorage({
    pool: pools.app,
    ddlPool: pools.ddl,
    cursorSecret: fixtureSecret("ROOTSET_SECRET"),
  });
  await pools.owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [orgId, "Storage verification fixture"],
  );
  const database = await storage.createDatabase(actor, {
    name: "Storage conformance",
  });
  databaseId = database.id;
  schemaName = database.schemaName;
});
after(async () => {
  if (databaseId) await storage.deleteDatabase(actor, databaseId);
  if (schemaName)
    await pools.owner.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await pools?.close();
});

const text = (name = "CODE", charLimit = 40): FieldInput => ({
  name,
  type: "text",
  charLimit,
});
async function table(
  fields: FieldInput[],
  name = "Case fixture",
): Promise<TableRecord> {
  return storage.createTable(actor, databaseId, {
    name,
    fields,
    idempotencyKey: newId(),
  });
}
const key = () => newId();
const code =
  (expected: string) =>
  (error: unknown): boolean =>
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === expected;

verificationCase(
  {
    id: "STORAGE-FIELD-NAME-01",
    gates: ["V1-11"],
    scope:
      "Native definitions accept 1–64 letters/underscores, reject digits and invalid names, and enforce table-local name uniqueness",
  },
  async () => {
    const t = await table([text("A"), text("_"), text("z".repeat(64))]);
    assert.equal(t.fields.length, 3);
    for (const name of ["", "A1", "1", "a-b", "a b", "é", "z".repeat(65)])
      await assert.rejects(
        storage.createField(actor, t.id, {
          ...text(name),
          expectedSchemaVersion: 1,
        }),
        code("VALIDATION_FAILED"),
      );
    await assert.rejects(
      storage.createField(actor, t.id, {
        ...text("A"),
        expectedSchemaVersion: 1,
      }),
    );
    assert.equal((await storage.getTable(actor, t.id)).fields.length, 3);
    assert.equal((await storage.getTable(actor, t.id)).schemaVersion, 1);
  },
);

verificationCase(
  {
    id: "STORAGE-FILTERED-WINDOW-01",
    gates: ["V1-22"],
    scope:
      "Filtered first-window count stays unknown until matching anchors exist; middle/last use actual five matches rather than thirty physical rows",
  },
  async () => {
    const t = await table([{ name: "COUNT", type: "integer" }]);
    await storage.mutateRows(actor, t.id, {
      operations: Array.from({ length: 30 }, (_, index) => ({
        kind: "create" as const,
        values: { COUNT: index },
      })),
      idempotencyKey: key(),
    });
    const query = {
      where: { field: "COUNT", op: "gte" as const, value: 25 },
      orderBy: [{ field: "COUNT", direction: "asc" as const }],
      limit: 2,
    };
    const first = await storage.queryWindow(actor, t.id, {
      position: "first",
      query,
    });
    assert.equal(first.totalRows, null);
    assert.equal(first.countKind, "unknown");
    assert.equal(first.tableRowCount, 30);
    assert.deepEqual(
      first.result.data.map((row) => row.values.COUNT),
      [25, 26],
    );
    const last = await storage.queryWindow(actor, t.id, {
      position: "last",
      query,
      sessionId: first.sessionId,
    });
    assert.equal(last.totalRows, 5);
    assert.equal(last.countKind, "exact");
    assert.equal(last.position, 3);
    assert.deepEqual(
      last.result.data.map((row) => row.values.COUNT),
      [28, 29],
    );
    const middle = await storage.queryWindow(actor, t.id, {
      position: "middle",
      query,
      sessionId: first.sessionId,
    });
    assert.deepEqual(
      middle.result.data.map((row) => row.values.COUNT),
      [27, 28],
    );
  },
);

verificationCase(
  {
    id: "STORAGE-CATALOG-01",
    gates: ["V1-10", "V1-19", "V1-38"],
    scope:
      "Native physical types, hidden ULID metadata, forced RLS, one ordinary non-superuser database role and required history trigger",
  },
  async () => {
    const t = await table([
      text(),
      { name: "COUNT", type: "integer" },
      { name: "RATIO", type: "float" },
      { name: "ACTIVE", type: "boolean" },
      { name: "DAY", type: "date" },
      { name: "CLOCK", type: "time" },
      { name: "INSTANT", type: "date-time" },
      { name: "DETAIL", type: "json" },
    ]);
    const relation = await pools.owner.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner: string;
    }>(
      "SELECT c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relname=$2",
      [t.schemaName, t.physicalName],
    );
    assert.equal(relation.rowCount, 1);
    assert.deepEqual(relation.rows[0], {
      relrowsecurity: true,
      relforcerowsecurity: true,
      owner: new URL(fixtureSecret("ROOTSET_TEST_DATABASE_URL")).username,
    });
    const role = await pools.app.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      current_user: string;
    }>(
      "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(role.rows[0], {
      current_user: new URL(fixtureSecret("ROOTSET_TEST_DATABASE_URL"))
        .username,
      rolsuper: false,
      rolbypassrls: false,
    });
    const columns = await pools.owner.query<{ attname: string; type: string }>(
      "SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped",
      [t.schemaName, t.physicalName],
    );
    const types = Object.fromEntries(
      columns.rows.map((column) => [column.attname, column.type]),
    );
    assert.deepEqual(
      t.fields.map((field) => types[fieldColumn(field)]),
      [
        "text",
        "bigint",
        "double precision",
        "boolean",
        "date",
        "time(3) without time zone",
        "timestamp(3) with time zone",
        "jsonb",
      ],
    );
    const triggers = await pools.owner.query(
      "SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal",
      [t.schemaName, t.physicalName],
    );
    assert.ok(
      triggers.rows.some(
        (trigger: { tgname: string }) => trigger.tgname === "rootset_enforce",
      ),
    );
    const row = await storage.createRow(actor, t.id, { CODE: "001" });
    assert.match(row.id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.ok(
      !Object.hasOwn(row.values, "id") && !Object.hasOwn(row.values, "row_id"),
    );
  },
);

verificationCase(
  {
    id: "STORAGE-TYPES-01",
    gates: ["V1-11", "V1-13", "V1-14", "V1-15", "V1-17"],
    scope:
      "All eight native types round-trip canonical values via actual PostgreSQL service; this case does not establish browser/REST/MCP parity",
  },
  async () => {
    const t = await table([
      text("TEXT", 20),
      { name: "INTEGER", type: "integer" },
      { name: "FLOAT", type: "float" },
      { name: "BOOLEAN", type: "boolean" },
      { name: "DATE", type: "date" },
      { name: "TIME", type: "time" },
      { name: "DATETIME", type: "date-time" },
      { name: "JSON", type: "json" },
    ]);
    const values = {
      TEXT: "航空✈️\n001",
      INTEGER: Number.MIN_SAFE_INTEGER,
      FLOAT: -0.125,
      BOOLEAN: false,
      DATE: "0001-01-01",
      TIME: "23:59:59.1Z",
      DATETIME: "2024-02-29T12:30:00Z",
      JSON: { a: [null, false, 0.1], b: "001" },
    };
    const expected = {
      ...values,
      TIME: "23:59:59.100Z",
      DATETIME: "2024-02-29T12:30:00.000Z",
    };
    const inserted = await storage.createRow(actor, t.id, values, {
      idempotencyKey: key(),
    });
    assert.deepEqual(inserted.values, expected);
    const fetched = await storage.getRow(actor, t.id, inserted.id);
    assert.deepEqual(fetched.values, expected);
    assert.equal(fetched.version, "1");
    const history = await pools.owner.query(
      "SELECT field_id,new_value,operation FROM rootset_control.cell_changes WHERE table_id=$1 AND row_id=$2",
      [t.id, inserted.id],
    );
    assert.equal(history.rowCount, 8);
    assert.ok(
      history.rows.every(
        (event: { operation: string }) => event.operation === "insert",
      ),
    );
  },
);

const rejectionCases: {
  name: string;
  field: FieldInput;
  accepted: JsonValue;
  rejected: JsonValue[];
  gate: string;
}[] = [
  {
    name: "text",
    field: text("VALUE", 3),
    accepted: "😀éA",
    rejected: ["😀éAA", "\u0000", "\ud800", 123],
    gate: "V1-13",
  },
  {
    name: "integer",
    field: {
      name: "VALUE",
      type: "integer",
      min: -3,
      max: 3,
    },
    accepted: -3,
    rejected: [-4, 4, 0.25, "2", Number.MAX_SAFE_INTEGER + 1],
    gate: "V1-13",
  },
  {
    name: "float",
    field: {
      name: "VALUE",
      type: "float",
      min: -0.5,
      max: 1.5,
    },
    accepted: 1.5,
    rejected: [-0.50001, 1.50001, "1.5", Number.NaN, Infinity, -Infinity],
    gate: "V1-13",
  },
  {
    name: "boolean",
    field: { name: "VALUE", type: "boolean" },
    accepted: false,
    rejected: ["false", 0, 1],
    gate: "V1-13",
  },
  {
    name: "date",
    field: {
      name: "VALUE",
      type: "date",
      min: "2024-02-28",
      max: "2024-03-01",
    },
    accepted: "2024-02-29",
    rejected: [
      "2023-02-29",
      "2024-02-30",
      "0000-01-01",
      "2024-02-27",
      "2024-03-02",
      "2024-02-29T00:00:00Z",
    ],
    gate: "V1-14",
  },
  {
    name: "time",
    field: { name: "VALUE", type: "time" },
    accepted: "00:00:00Z",
    rejected: [
      "00:00:00",
      "00:00:00+00:00",
      "24:00:00Z",
      "23:59:60Z",
      "00:00:00.1234Z",
    ],
    gate: "V1-14",
  },
  {
    name: "date-time",
    field: {
      name: "VALUE",
      type: "date-time",
      min: "2024-01-01T00:00:00.000Z",
      max: "2024-12-31T23:59:59.999Z",
    },
    accepted: "2024-02-29T23:59:59Z",
    rejected: [
      "2024-02-30T00:00:00Z",
      "2024-02-29T00:00:00",
      "2024-02-29T00:00:00+00:00",
      "2024-02-29T00:00:00.1234Z",
      "2023-12-31T23:59:59Z",
    ],
    gate: "V1-14",
  },
  {
    name: "json",
    field: { name: "VALUE", type: "json" },
    accepted: [true, { x: null }],
    rejected: [
      { invalid: "\u0000" },
      { invalid: "\udfff" },
      { number: Number.MAX_SAFE_INTEGER + 1 },
      { number: Infinity },
    ],
    gate: "V1-13",
  },
];
for (const [index, scenario] of rejectionCases.entries())
  verificationCase(
    {
      id: `STORAGE-BOUNDARY-${String(index + 1).padStart(2, "0")}`,
      gates: [scenario.gate, "V1-20"],
      scope: `${scenario.name} boundary validation rejects without row/count/history mutation on PostgreSQL service`,
    },
    async () => {
      const t = await table([scenario.field]);
      await storage.createRow(actor, t.id, { VALUE: scenario.accepted });
      for (const value of scenario.rejected)
        await assert.rejects(
          storage.createRow(
            actor,
            t.id,
            { VALUE: value },
            { idempotencyKey: key() },
          ),
          code("VALIDATION_FAILED"),
        );
      assert.equal((await storage.getTable(actor, t.id)).rowCount, 1);
      const count = await pools.owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rootset_control.cell_changes WHERE table_id=$1",
        [t.id],
      );
      assert.equal(count.rows[0]?.count, "1");
    },
  );

verificationCase(
  {
    id: "STORAGE-DEFAULTS-01",
    gates: ["V1-13", "V1-17"],
    scope:
      "Defaults apply only on omitted create input, patch preserves absent values, explicit null clears nullable cells, required cells/system writes reject",
  },
  async () => {
    const t = await table([
      { ...text("CODE"), required: true, default: "default" },
      text("NULLABLE"),
      { name: "BOOL", type: "boolean", default: false },
    ]);
    const inserted = await storage.createRow(actor, t.id, {});
    assert.deepEqual(inserted.values, {
      CODE: "default",
      NULLABLE: null,
      BOOL: false,
    });
    const updated = await storage.updateRow(
      actor,
      t.id,
      inserted.id,
      { NULLABLE: "present" },
      { expectedVersion: inserted.version },
    );
    assert.deepEqual(updated.values, {
      CODE: "default",
      NULLABLE: "present",
      BOOL: false,
    });
    const cleared = await storage.updateRow(
      actor,
      t.id,
      inserted.id,
      { NULLABLE: null },
      { expectedVersion: updated.version },
    );
    assert.equal(cleared.values.NULLABLE, null);
    await assert.rejects(
      storage.createRow(actor, t.id, { CODE: null }),
      code("VALIDATION_FAILED"),
    );
    await assert.rejects(
      storage.createRow(actor, t.id, { row_id: newId() }),
      code("VALIDATION_FAILED"),
    );
    await assert.rejects(
      storage.updateRow(
        actor,
        t.id,
        inserted.id,
        { CODE: null },
        { expectedVersion: cleared.version },
      ),
      code("VALIDATION_FAILED"),
    );
  },
);

verificationCase(
  {
    id: "STORAGE-BYTES-01",
    gates: ["V1-13", "V1-17"],
    scope:
      "Exactly 65,536 canonical UTF-8 bytes accepted; +1 rejected on creates and patches; multibyte characters are distinct from row bytes",
  },
  async () => {
    const t = await table([text("VALUE", 65536)]);
    const overhead = rowBytes(t.fields, { VALUE: "" });
    const value = "x".repeat(65536 - overhead);
    assert.equal(rowBytes(t.fields, { VALUE: value }), 65536);
    const inserted = await storage.createRow(actor, t.id, { VALUE: value });
    await assert.rejects(
      storage.createRow(actor, t.id, { VALUE: value + "x" }),
      code("ROW_SIZE_LIMIT"),
    );
    await assert.rejects(
      storage.updateRow(
        actor,
        t.id,
        inserted.id,
        { VALUE: value + "x" },
        { expectedVersion: inserted.version },
      ),
      code("ROW_SIZE_LIMIT"),
    );
    const multibyte = "😀".repeat(Math.floor((65536 - overhead) / 4));
    await storage.createRow(actor, t.id, { VALUE: multibyte });
    assert.ok(
      multibyte.length < 65536 &&
        rowBytes(t.fields, { VALUE: multibyte }) <= 65536,
    );
    assert.equal(
      (await storage.getRow(actor, t.id, inserted.id)).values.VALUE,
      value,
    );
  },
);

verificationCase(
  {
    id: "STORAGE-AUDIT-01",
    gates: ["V1-15", "V1-17", "V1-20"],
    scope:
      "Canonical JSON no-op retains revision/history; changed cells and deletion record exact old/new values, actor, request and mutation under atomic trigger",
  },
  async () => {
    const t = await table([text(), { name: "JSON", type: "json" }]);
    const inserted = await storage.createRow(
      actor,
      t.id,
      { CODE: "a", JSON: { b: 2, a: 1 } },
      { context: { source: "rest", requestId: "audit-fixture-request" } },
    );
    const noOp = await storage.updateRow(
      actor,
      t.id,
      inserted.id,
      { CODE: "a", JSON: { a: 1.0, b: 2 } },
      { expectedVersion: "1" },
    );
    assert.equal(noOp.version, "1");
    const changed = await storage.updateRow(
      actor,
      t.id,
      inserted.id,
      { CODE: "b", JSON: null },
      {
        expectedVersion: "1",
        context: { source: "mcp", requestId: "audit-change-request" },
      },
    );
    assert.equal(changed.version, "2");
    const history = await storage.cellHistory(
      actor,
      t.id,
      inserted.id,
      t.fields[0]!.id,
    );
    assert.equal(history.data.length, 2);
    const event = history.data[1]!;
    assert.equal(event.old_value, "a");
    assert.equal(event.new_value, "b");
    assert.equal(event.old_version, "1");
    assert.equal(event.new_version, "2");
    assert.equal((event.actor as Actor).id, actor.id);
    assert.equal(
      (event.context as { requestId: string }).requestId,
      "audit-change-request",
    );
    assert.equal(event.mutation_id, changed.mutationId);
    await storage.deleteRow(actor, t.id, inserted.id, {
      expectedVersion: changed.version,
    });
    await assert.rejects(
      storage.getRow(actor, t.id, inserted.id),
      code("RESOURCE_NOT_FOUND"),
    );
    const deleted = await storage.cellHistory(
      actor,
      t.id,
      inserted.id,
      t.fields[0]!.id,
    );
    assert.equal(deleted.data.length, 0);
    assert.equal((await storage.getTable(actor, t.id)).rowCount, 0);
  },
);

verificationCase(
  {
    id: "STORAGE-CONCURRENCY-01",
    gates: ["V1-17", "V1-20"],
    scope:
      "Concurrent same-version writers allow one commit; stale revision and invalid atomic batch leave values/count/history unchanged; idempotent create replays one row",
  },
  async () => {
    const t = await table([text()]);
    const requestKey = key();
    const [created, replay] = await Promise.all([
      storage.createRow(
        actor,
        t.id,
        { CODE: "first" },
        { idempotencyKey: requestKey },
      ),
      storage.createRow(
        actor,
        t.id,
        { CODE: "first" },
        { idempotencyKey: requestKey },
      ),
    ]);
    assert.equal(created.id, replay.id);
    assert.equal(created.mutationId, replay.mutationId);
    await assert.rejects(
      storage.createRow(
        actor,
        t.id,
        { CODE: "different" },
        { idempotencyKey: requestKey },
      ),
      code("IDEMPOTENCY_CONFLICT"),
    );
    const writes = await Promise.allSettled(
      ["writer-a", "writer-b"].map((CODE) =>
        storage.updateRow(
          actor,
          t.id,
          created.id,
          { CODE },
          { expectedVersion: "1", idempotencyKey: key() },
        ),
      ),
    );
    assert.equal(
      writes.filter((write) => write.status === "fulfilled").length,
      1,
    );
    assert.equal(
      writes.filter(
        (write) =>
          write.status === "rejected" &&
          code("ROW_VERSION_CONFLICT")(write.reason),
      ).length,
      1,
    );
    const current = await storage.getRow(actor, t.id, created.id);
    assert.equal(current.version, "2");
    const historyBefore = (
      await storage.cellHistory(actor, t.id, created.id, t.fields[0]!.id)
    ).data.length;
    await assert.rejects(
      storage.mutateRows(actor, t.id, {
        idempotencyKey: key(),
        operations: [
          {
            kind: "update",
            rowId: created.id,
            expectedVersion: current.version,
            values: { CODE: "batch-start" },
          },
          { kind: "create", values: { CODE: "x".repeat(41) } },
        ],
      }),
      code("VALIDATION_FAILED"),
    );
    assert.deepEqual(await storage.getRow(actor, t.id, created.id), current);
    assert.equal((await storage.getTable(actor, t.id)).rowCount, 1);
    assert.equal(
      (await storage.cellHistory(actor, t.id, created.id, t.fields[0]!.id)).data
        .length,
      historyBefore,
    );
  },
);

verificationCase(
  {
    id: "STORAGE-UNIQUE-01",
    gates: ["V1-18"],
    scope:
      "Native composite scalar uniqueness handles case, whitespace/null semantics, concurrent duplicate writes, deletion release and duplicate-rule activation rollback",
  },
  async () => {
    const t = await table([text("A", 10), text("B", 10)]);
    await storage.createRow(actor, t.id, { A: "same", B: "same" });
    const duplicate = await storage.createRow(actor, t.id, {
      A: "same",
      B: "same",
    });
    await assert.rejects(
      storage.createUniqueRule(actor, t.id, {
        fieldIds: t.fields.map((field) => field.id),
        expectedSchemaVersion: 1,
        idempotencyKey: key(),
      }),
      code("UNIQUE_CONFLICT"),
    );
    assert.equal((await storage.listUniqueRules(actor, t.id)).length, 0);
    await storage.deleteRow(actor, t.id, duplicate.id, {
      expectedVersion: duplicate.version,
    });
    const rule = await storage.createUniqueRule(actor, t.id, {
      fieldIds: t.fields.map((field) => field.id),
      expectedSchemaVersion: 1,
      idempotencyKey: key(),
    });
    assert.equal(rule.strategy, "native");
    assert.equal(rule.state, "active");
    await storage.createRow(actor, t.id, { A: "Same", B: "same" });
    await storage.createRow(actor, t.id, { A: "same ", B: "same" });
    await storage.createRow(actor, t.id, { A: null, B: "same" });
    await storage.createRow(actor, t.id, { A: null, B: "same" });
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        storage.createRow(actor, t.id, { A: "race", B: "same" }),
      ),
    );
    const success = attempts.find((result) => result.status === "fulfilled");
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      attempts.filter(
        (result) =>
          result.status === "rejected" &&
          code("UNIQUE_CONFLICT")(result.reason),
      ).length,
      4,
    );
    assert.ok(success?.status === "fulfilled");
    await storage.deleteRow(actor, t.id, success.value.id, {
      expectedVersion: success.value.version,
    });
    await storage.createRow(actor, t.id, { A: "race", B: "same" });
  },
);

verificationCase(
  {
    id: "STORAGE-UNIQUE-02",
    gates: ["V1-18"],
    scope:
      "Wide composite registry checks exact tuples concurrently, atomically releases updates/deletes and rejects JSON uniqueness; forced digest collision remains a separate required case",
  },
  async () => {
    const t = await table([
      text("A", 20000),
      text("B", 20000),
      { name: "JSON", type: "json" },
    ]);
    const rule = await storage.createUniqueRule(actor, t.id, {
      fieldIds: [t.fields[0]!.id, t.fields[1]!.id],
      expectedSchemaVersion: 1,
      idempotencyKey: key(),
    });
    assert.equal(rule.strategy, "registry");
    const values = { A: "a".repeat(10000), B: "b".repeat(10000) };
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => storage.createRow(actor, t.id, values)),
    );
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      attempts.filter(
        (result) =>
          result.status === "rejected" &&
          code("UNIQUE_CONFLICT")(result.reason),
      ).length,
      5,
    );
    const success = attempts.find((result) => result.status === "fulfilled");
    assert.ok(success?.status === "fulfilled");
    const changed = await storage.updateRow(
      actor,
      t.id,
      success.value.id,
      { B: "c".repeat(10000) },
      { expectedVersion: "1" },
    );
    await storage.createRow(actor, t.id, values);
    await storage.deleteRow(actor, t.id, changed.id, {
      expectedVersion: changed.version,
    });
    const entries = await pools.owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rootset_control.unique_entries WHERE rule_id=$1",
      [rule.id],
    );
    assert.equal(entries.rows[0]?.count, "1");
    await assert.rejects(
      storage.createUniqueRule(actor, t.id, {
        fieldIds: [t.fields[2]!.id],
        expectedSchemaVersion: 2,
        idempotencyKey: key(),
      }),
      code("VALIDATION_FAILED"),
    );
  },
);

verificationCase(
  {
    id: "STORAGE-SCHEMA-01",
    gates: ["V1-12", "V1-19", "V1-20", "V1-21"],
    scope:
      "Schema versions reject stale writers; rename/reorder retain field identity; invalid populated bounds roll back; deleted field history is removed",
  },
  async () => {
    const t = await table([
      text(),
      { name: "COUNT", type: "integer", min: 0, max: 10 },
    ]);
    const inserted = await storage.createRow(actor, t.id, {
      CODE: "retained",
      COUNT: 9,
    });
    const renamed = await storage.updateField(actor, t.id, t.fields[0]!.id, {
      name: "RENAMED_CODE",
      expectedSchemaVersion: 1,
      idempotencyKey: key(),
    });
    assert.equal(renamed.fields[0]?.id, t.fields[0]?.id);
    assert.equal(renamed.fields[0]?.name, "RENAMED_CODE");
    const renamedRow = await storage.getRow(actor, t.id, inserted.id);
    assert.equal(renamedRow.values.RENAMED_CODE, "retained");
    assert.equal(renamedRow.values.CODE, undefined);
    await assert.rejects(
      storage.createField(actor, t.id, {
        ...text("NEW"),
        expectedSchemaVersion: 1,
      }),
      code("SCHEMA_VERSION_CONFLICT"),
    );
    await assert.rejects(
      storage.updateField(actor, t.id, t.fields[1]!.id, {
        max: 5,
        expectedSchemaVersion: 2,
      }),
      code("VALIDATION_FAILED"),
    );
    assert.equal((await storage.getTable(actor, t.id)).schemaVersion, 2);
    const removed = await storage.deleteField(actor, t.id, t.fields[0]!.id, {
      expectedSchemaVersion: 2,
      idempotencyKey: key(),
    });
    assert.equal(removed.fields.length, 1);
    await assert.rejects(
      storage.cellHistory(actor, t.id, inserted.id, t.fields[0]!.id),
      code("RESOURCE_NOT_FOUND"),
    );
    assert.equal(
      (await storage.queryHistory(actor, t.id, { fieldId: t.fields[0]!.id }))
        .data.length,
      0,
    );
    const recreated = await storage.createField(actor, t.id, {
      ...text(),
      expectedSchemaVersion: 3,
      idempotencyKey: key(),
    });
    assert.notEqual(
      recreated.fields.find((field) => field.name === "CODE")?.id,
      t.fields[0]?.id,
    );
  },
);

verificationCase(
  {
    id: "STORAGE-RLS-01",
    gates: ["V1-20", "V1-38"],
    scope:
      "Single-organisation storage rejects mismatched org context and direct unaudited SQL; transaction-local org settings do not leak to pooled requests",
  },
  async () => {
    const t = await table([text()]);
    const inserted = await storage.createRow(actor, t.id, { CODE: "isolated" });
    const path = `"${t.schemaName}"."${t.physicalName}"`;
    const column = `"${fieldColumn(t.fields[0]!)}"`;
    assert.equal((await pools.app.query(`SELECT * FROM ${path}`)).rowCount, 1);
    assert.equal(
      (
        await withOrg(pools.app, otherOrgId, (client) =>
          client.query(`SELECT * FROM ${path}`),
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      withOrg(pools.app, orgId, (client) =>
        client.query(
          `UPDATE ${path} SET ${column}='unaudited' WHERE row_id=$1`,
          [inserted.id],
        ),
      ),
    );
    await assert.rejects(
      storage.getRow({ ...actor, orgId: otherOrgId }, t.id, inserted.id),
      code("RESOURCE_NOT_FOUND"),
    );
    const setting = await pools.app.query<{ org: string | null }>(
      "SELECT nullif(current_setting('rootset.org_id',true),'') AS org",
    );
    assert.equal(setting.rows[0]?.org, null);
    assert.equal(
      (await storage.getRow(actor, t.id, inserted.id)).values.CODE,
      "isolated",
    );
  },
);

verificationCase(
  {
    id: "STORAGE-PAGING-01",
    gates: ["V1-22"],
    scope:
      "Typed filtering and stable tied sorting/projected cursors visit unchanged rows once; tampered/query/actor/schema cursors and invalid limits reject",
  },
  async () => {
    const t = await table([text("GROUP"), { name: "COUNT", type: "integer" }]);
    await storage.mutateRows(actor, t.id, {
      idempotencyKey: key(),
      operations: Array.from({ length: 15 }, (_, i) => ({
        kind: "create" as const,
        values: { GROUP: i % 2 ? "odd" : "even", COUNT: i },
      })),
    });
    const query = {
      select: ["COUNT"],
      where: { field: "COUNT", op: "gte" as const, value: 0 },
      orderBy: [{ field: "GROUP", direction: "asc" as const }],
      limit: 3,
    };
    let page = await storage.queryRows(actor, t.id, query);
    const firstCursor = page.page.nextCursor;
    assert.ok(firstCursor);
    const found: string[] = [];
    for (;;) {
      found.push(...page.data.map((row) => row.id));
      assert.ok(
        page.data.every((row) => Object.keys(row.values).join(",") === "COUNT"),
      );
      if (!page.page.hasMore) break;
      page = await storage.queryRows(actor, t.id, {
        ...query,
        cursor: page.page.nextCursor,
      });
    }
    assert.equal(found.length, 15);
    assert.equal(new Set(found).size, 15);
    assert.equal(page.page.stopReason, "end");
    await assert.rejects(
      storage.queryRows(actor, t.id, {
        ...query,
        cursor:
          firstCursor.slice(0, -1) + (firstCursor.endsWith("A") ? "B" : "A"),
      }),
      code("CURSOR_INVALID"),
    );
    await assert.rejects(
      storage.queryRows(actor, t.id, {
        ...query,
        where: { field: "COUNT", op: "gt", value: 0 },
        cursor: firstCursor,
      }),
      code("CURSOR_INVALID"),
    );
    await assert.rejects(
      storage.queryRows({ ...actor, id: `different:${newId()}` }, t.id, {
        ...query,
        cursor: firstCursor,
      }),
      code("CURSOR_INVALID"),
    );
    assert.equal(
      (await storage.queryRows(actor, t.id)).page.requestedLimit,
      5000,
    );
    assert.equal(
      (await storage.queryRows(actor, t.id, {}, { surface: "mcp" })).page
        .requestedLimit,
      200,
    );
    for (const limit of [0, -1, 25001])
      await assert.rejects(
        storage.queryRows(actor, t.id, { limit }),
        code("VALIDATION_FAILED"),
      );
    await storage.createField(actor, t.id, {
      ...text("NEW"),
      expectedSchemaVersion: 1,
    });
    await assert.rejects(
      storage.queryRows(actor, t.id, { ...query, cursor: firstCursor }),
      code("CURSOR_INVALID"),
    );
  },
);

verificationCase(
  {
    id: "STORAGE-BYTEPAGE-01",
    gates: ["V1-15", "V1-22"],
    scope:
      "Small encoded response budget cuts on complete rows and cursor resumes without boundary loss or exceeding actual JSON envelope size",
  },
  async () => {
    const t = await table([text("VALUE", 2000)]);
    await storage.mutateRows(actor, t.id, {
      idempotencyKey: key(),
      operations: Array.from({ length: 12 }, (_, i) => ({
        kind: "create" as const,
        values: { VALUE: `${i}:` + "x".repeat(1000) },
      })),
    });
    let cursor: string | null = null;
    const found: string[] = [];
    for (;;) {
      const page = await storage.queryRows(
        actor,
        t.id,
        { limit: 12, cursor },
        { byteLimit: 4500 },
      );
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4500);
      found.push(...page.data.map((row) => row.id));
      if (!page.page.hasMore) break;
      assert.equal(page.page.stopReason, "byte_limit");
      assert.ok(page.page.nextCursor && page.data.length > 0);
      cursor = page.page.nextCursor;
    }
    assert.equal(found.length, 12);
    assert.equal(new Set(found).size, 12);
  },
);

verificationCase(
  {
    id: "STORAGE-SCHEMA-BYTES-02",
    gates: ["V1-17", "V1-19"],
    scope:
      "Adding a nullable field to a full-size populated row rejects before metadata/DDL activation; existing schema and values remain readable",
  },
  async () => {
    const t = await table([text("VALUE", 65536)]);
    const value = "x".repeat(65536 - rowBytes(t.fields, { VALUE: "" }));
    const inserted = await storage.createRow(actor, t.id, { VALUE: value });
    await assert.rejects(
      storage.createField(actor, t.id, {
        ...text("NEW"),
        expectedSchemaVersion: 1,
        idempotencyKey: key(),
      }),
      code("ROW_SIZE_LIMIT"),
    );
    const current = await storage.getTable(actor, t.id);
    assert.equal(current.schemaVersion, 1);
    assert.equal(current.fields.length, 1);
    assert.equal(
      (await storage.getRow(actor, t.id, inserted.id)).values.VALUE,
      value,
    );
  },
);

verificationCase(
  {
    id: "STORAGE-CONVERSION-01",
    gates: ["V1-19", "V1-20", "V1-21"],
    scope:
      "Populated explicit conversion publishes one physical generation with row IDs/revisions/history retained, and an identical retry replays instead of converting twice",
  },
  async () => {
    const t = await table([{ name: "VALUE", type: "integer" }]);
    const row = await storage.createRow(actor, t.id, { VALUE: 42 });
    const input = {
      type: "text" as const,
      charLimit: 100,
      conversion: { strategy: "stringify" as const },
      expectedSchemaVersion: 1,
      idempotencyKey: key(),
    };
    const changed = await storage.updateField(
      actor,
      t.id,
      t.fields[0]!.id,
      input,
    );
    assert.equal(changed.generation, 2);
    assert.equal(changed.schemaVersion, 2);
    assert.equal(changed.state, "active");
    const converted = await storage.getRow(actor, t.id, row.id);
    assert.equal(converted.values.VALUE, "42");
    assert.equal(converted.version, "2");
    const history = await storage.cellHistory(
      actor,
      t.id,
      row.id,
      t.fields[0]!.id,
    );
    assert.equal(history.data.length, 2);
    assert.equal(history.data.at(-1)?.old_value, 42);
    assert.equal(history.data.at(-1)?.new_value, "42");
    const replayed = await storage.updateField(
      actor,
      t.id,
      t.fields[0]!.id,
      input,
    );
    assert.equal(replayed.physicalName, changed.physicalName);
    assert.equal(replayed.generation, 2);
    assert.equal(replayed.schemaVersion, 2);
    assert.equal(
      (await storage.cellHistory(actor, t.id, row.id, t.fields[0]!.id)).data
        .length,
      2,
    );
  },
);

verificationCase(
  {
    id: "STORAGE-CONVERSION-02",
    gates: ["V1-19", "V1-20"],
    scope:
      "Invalid populated conversion preserves original generation/schema/row/history and reconciles failed staging without exposing partial converted values",
  },
  async () => {
    const t = await table([text("VALUE")]);
    const inserted = await storage.createRow(actor, t.id, {
      VALUE: "not-a-number",
    });
    await assert.rejects(
      storage.updateField(actor, t.id, t.fields[0]!.id, {
        type: "integer",
        conversion: { strategy: "parse" },
        expectedSchemaVersion: 1,
        idempotencyKey: key(),
      }),
      code("VALIDATION_FAILED"),
    );
    const current = await storage.getTable(actor, t.id);
    assert.equal(current.generation, 1);
    assert.equal(current.schemaVersion, 1);
    assert.equal(current.state, "active");
    assert.equal(
      (await storage.getRow(actor, t.id, inserted.id)).values.VALUE,
      "not-a-number",
    );
    assert.equal(
      (await storage.cellHistory(actor, t.id, inserted.id, t.fields[0]!.id))
        .data.length,
      1,
    );
    await storage.reconcileSchemaOperations(actor);
    assert.equal(
      (await storage.getTable(actor, t.id)).physicalName,
      t.physicalName,
    );
  },
);

verificationCase(
  {
    id: "STORAGE-INDEX-01",
    gates: ["V1-21", "V1-23"],
    scope:
      "Real concurrent trigram index build publishes active only with valid PostgreSQL catalogue entry; removal marks metadata and physical index absent",
  },
  async () => {
    const t = await table([text("VALUE", 300)]);
    await storage.mutateRows(actor, t.id, {
      operations: Array.from({ length: 20 }, (_, index) => ({
        kind: "create" as const,
        values: { VALUE: `Airline ${index}` },
      })),
      idempotencyKey: key(),
    });
    const index = await storage.createIndex(actor, t.id, {
      fieldId: t.fields[0]!.id,
      kind: "trigram",
      expectedSchemaVersion: 1,
      idempotencyKey: key(),
    });
    assert.equal(index.state, "active");
    const actual = await pools.owner.query<{ indisvalid: boolean }>(
      "SELECT indisvalid FROM pg_index WHERE indexrelid=$1::regclass",
      [`"${t.schemaName}"."${index.physicalName}"`],
    );
    assert.equal(actual.rows[0]?.indisvalid, true);
    await storage.deleteIndex(actor, t.id, index.id, {
      expectedSchemaVersion: 2,
      idempotencyKey: key(),
    });
    assert.equal(
      (
        await pools.owner.query<{ physical: string | null }>(
          "SELECT to_regclass($1)::text AS physical",
          [`"${t.schemaName}"."${index.physicalName}"`],
        )
      ).rows[0]?.physical,
      null,
    );
  },
);
