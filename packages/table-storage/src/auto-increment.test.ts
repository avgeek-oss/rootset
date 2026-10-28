import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, migrate, type Pool } from "@rootset/database";
import { newId, type Actor } from "@rootset/contracts";
import { TableStorage } from "./index.js";

const configured = Boolean(process.env.ROOTSET_TEST_DATABASE_URL);
const isolatedName = `rootset_auto_${newId().toLowerCase()}`;
const actor: Actor = {
  id: newId(),
  orgId: newId(),
  kind: "operator",
  role: "admin",
  scopes: ["viewer", "member", "admin"],
};
let admin: Pool, pool: Pool, storage: TableStorage, databaseId: string;
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
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Integer generator tests')",
    [actor.orgId],
  );
  storage = new TableStorage({
    pool,
    ddlPool: pool,
    cursorSecret: "auto-increment-tests-secret-over-thirty-two-bytes",
  });
  databaseId = (await storage.createDatabase(actor, { name: "Generators" })).id;
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

test(
  "concurrent and mixed batch writes allocate above all explicit IDs, including imports",
  { skip: !configured },
  async () => {
    let table = await storage.createTable(actor, databaseId, {
      name: "Concurrent",
      fields: [
        {
          name: "RECORD_ID",
          type: "integer",
          required: true,
          autoIncrement: true,
        },
      ],
    });
    await storage.createUniqueRule(actor, table.id, {
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: table.schemaVersion,
    });
    table = await storage.getTable(actor, table.id);
    const rows = await Promise.all(
      Array.from({ length: 20 }, () => storage.createRow(actor, table.id, {})),
    );
    assert.deepEqual(
      rows
        .map((row) => row.values.RECORD_ID)
        .sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const batch = await storage.mutateRows(actor, table.id, {
      operations: [
        { kind: "create", values: {} },
        { kind: "create", values: { [table.fields[0]!.id]: 100 } },
        { kind: "create", values: { RECORD_ID: 80 } },
        { kind: "create", values: {} },
      ],
    });
    assert.deepEqual(
      batch.rows.map((row) => row.values.RECORD_ID),
      [101, 100, 80, 102],
    );
    const imported = await storage.mutateRows(actor, table.id, {
      context: { source: "import" },
      operations: [
        { kind: "create", values: {} },
        { kind: "create", values: { RECORD_ID: 500 } },
      ],
    });
    assert.equal(imported.rows.length, 0);
    const result = await storage.queryRows(actor, table.id, {
      where: { field: "RECORD_ID", op: "gte", value: 500 },
    });
    assert.deepEqual(
      result.data.map((row) => row.values.RECORD_ID).sort(),
      [500, 501],
    );
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      502,
    );
  },
);

test(
  "enabling on a populated integer field preserves IDs, versions, and unique rules",
  { skip: !configured },
  async () => {
    let table = await storage.createTable(actor, databaseId, {
      name: "Existing IDs",
      fields: [{ name: "RECORD_ID", type: "integer", required: true }],
    });
    const existing = await Promise.all(
      [8, 42].map((RECORD_ID) =>
        storage.createRow(actor, table.id, { RECORD_ID }),
      ),
    );
    await storage.createUniqueRule(actor, table.id, {
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: table.schemaVersion,
    });
    table = await storage.getTable(actor, table.id);
    const changed = await storage.updateField(
      actor,
      table.id,
      table.fields[0]!.id,
      { autoIncrement: true, expectedSchemaVersion: table.schemaVersion },
    );
    assert.equal(changed.fields[0]!.id, table.fields[0]!.id);
    for (const row of existing) {
      const actual = await storage.getRow(actor, table.id, row.id);
      assert.deepEqual(actual.values, row.values);
      assert.equal(actual.id, row.id);
      assert.equal(actual.version, row.version);
    }
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      43,
    );
    await assert.rejects(
      storage.createRow(actor, table.id, { RECORD_ID: 42 }),
      { code: "UNIQUE_CONFLICT" },
    );
  },
);

test(
  "deleting, lowering IDs, or disabling and re-enabling generation never resets the counter",
  { skip: !configured },
  async () => {
    let table = await storage.createTable(actor, databaseId, {
      name: "Durable IDs",
      fields: [{ name: "RECORD_ID", type: "integer", autoIncrement: true }],
    });
    const high = await storage.createRow(actor, table.id, { RECORD_ID: 100 });
    await storage.deleteRow(actor, table.id, high.id, {
      expectedVersion: high.version,
    });
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      101,
    );
    table = await storage.updateField(actor, table.id, table.fields[0]!.id, {
      autoIncrement: false,
      expectedSchemaVersion: table.schemaVersion,
    });
    const explicit = await storage.createRow(actor, table.id, {
      RECORD_ID: 200,
    });
    const lower = await storage.updateRow(
      actor,
      table.id,
      explicit.id,
      { RECORD_ID: 2 },
      { expectedVersion: explicit.version },
    );
    await storage.deleteRow(actor, table.id, lower.id, {
      expectedVersion: lower.version,
    });
    table = await storage.updateField(actor, table.id, table.fields[0]!.id, {
      autoIncrement: true,
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      201,
    );
    table = await storage.updateField(actor, table.id, table.fields[0]!.id, {
      type: "text",
      conversion: { strategy: "stringify" },
      expectedSchemaVersion: table.schemaVersion,
    });
    table = await storage.updateField(actor, table.id, table.fields[0]!.id, {
      type: "integer",
      autoIncrement: true,
      conversion: { strategy: "parse" },
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      202,
    );
  },
);

test(
  "configured bounds and safe integer exhaustion fail atomically, while replays consume nothing",
  { skip: !configured },
  async () => {
    let table = await storage.createTable(actor, databaseId, {
      name: "Bounded",
      fields: [
        {
          name: "RECORD_ID",
          type: "integer",
          required: true,
          autoIncrement: true,
          min: 0,
          max: 2,
        },
      ],
    });

    const first = await storage.createRow(
      actor,
      table.id,
      {},
      { idempotencyKey: "generator-replay" },
    );
    assert.equal(first.values.RECORD_ID, 0);
    assert.deepEqual(
      await storage.createRow(
        actor,
        table.id,
        {},
        { idempotencyKey: "generator-replay" },
      ),
      first,
    );
    await assert.rejects(
      storage.mutateRows(actor, table.id, {
        operations: Array.from({ length: 3 }, () => ({
          kind: "create" as const,
          values: {},
        })),
      }),
      { code: "AUTO_INCREMENT_EXHAUSTED" },
    );
    assert.equal((await storage.getTable(actor, table.id)).rowCount, 1);
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      1,
    );
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      2,
    );
    await assert.rejects(storage.createRow(actor, table.id, {}), {
      code: "AUTO_INCREMENT_EXHAUSTED",
    });
    table = await storage.updateField(actor, table.id, table.fields[0]!.id, {
      max: 3,
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      3,
    );
    const edge = await storage.createTable(actor, databaseId, {
      name: "Safe boundary",
      fields: [
        {
          name: "RECORD_ID",
          type: "integer",
          autoIncrement: true,
          min: Number.MAX_SAFE_INTEGER,
        },
      ],
    });
    assert.equal(
      (await storage.createRow(actor, edge.id, {})).values.RECORD_ID,
      Number.MAX_SAFE_INTEGER,
    );
    await assert.rejects(storage.createRow(actor, edge.id, {}), {
      code: "AUTO_INCREMENT_EXHAUSTED",
    });
  },
);

test(
  "required fields need supplied values or generation, and existing nulls require explicit backfill",
  { skip: !configured },
  async () => {
    let table = await storage.createTable(actor, databaseId, {
      name: "Required",
      fields: [{ name: "RECORD_ID", type: "integer", default: 7 }],
    });
    const existing = await storage.createRow(actor, table.id, {
      RECORD_ID: null,
    });
    await assert.rejects(
      storage.updateField(actor, table.id, table.fields[0]!.id, {
        autoIncrement: true,
        expectedSchemaVersion: table.schemaVersion,
      }),
      { code: "VALIDATION_FAILED" },
    );
    table = await storage.updateField(actor, table.id, table.fields[0]!.id, {
      autoIncrement: true,
      clearDefault: true,
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(Object.hasOwn(table.fields[0]!, "default"), false);
    assert.equal(
      (await storage.getRow(actor, table.id, existing.id)).values.RECORD_ID,
      null,
    );
    const preview = await storage.previewSchemaChange(actor, table.id, {
      expectedSchemaVersion: table.schemaVersion,
      change: {
        kind: "update_field",
        fieldId: table.fields[0]!.id,
        changes: { required: true },
      },
    });
    assert.equal(preview.valid, false);
    assert.equal(preview.conflicts[0]?.rowId, existing.id);
    await assert.rejects(
      storage.updateField(actor, table.id, table.fields[0]!.id, {
        required: true,
        expectedSchemaVersion: table.schemaVersion,
      }),
      { code: "VALIDATION_FAILED" },
    );
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      1,
    );
    const supplied = await storage.createTable(actor, databaseId, {
      name: "Supplied IDs",
      fields: [{ name: "RECORD_ID", type: "integer", required: true }],
    });
    assert.equal(
      (await storage.createRow(actor, supplied.id, { RECORD_ID: 9 })).values
        .RECORD_ID,
      9,
    );
    await assert.rejects(storage.createRow(actor, supplied.id, {}), {
      code: "VALIDATION_FAILED",
    });
  },
);

test(
  "new generated fields preserve old cells and require an explicit backfill before Required",
  { skip: !configured },
  async () => {
    let table = await storage.createTable(actor, databaseId, {
      name: "New generator column",
    });
    const old = await storage.createRow(actor, table.id, {});
    await assert.rejects(
      storage.createField(actor, table.id, {
        name: "RECORD_ID",
        type: "integer",
        required: true,
        autoIncrement: true,
        expectedSchemaVersion: table.schemaVersion,
      }),
      { code: "VALIDATION_FAILED" },
    );
    table = await storage.createField(actor, table.id, {
      name: "RECORD_ID",
      type: "integer",
      autoIncrement: true,
      min: 10,
      expectedSchemaVersion: table.schemaVersion,
    });
    const unchanged = await storage.getRow(actor, table.id, old.id);
    assert.equal(unchanged.values.RECORD_ID, null);
    assert.equal(unchanged.version, old.version);
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      10,
    );
    await storage.updateRow(
      actor,
      table.id,
      old.id,
      { RECORD_ID: 11 },
      { expectedVersion: old.version },
    );
    table = await storage.updateField(actor, table.id, table.fields[0]!.id, {
      required: true,
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage.createRow(actor, table.id, {})).values.RECORD_ID,
      12,
    );
  },
);
