import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, migrate, withOrg, type Pool } from "@rootset/database";
import {
  newId,
  RootsetError,
  type BulkRowsInput,
  type Actor,
} from "@rootset/contracts";
import { TableStorage } from "./index.js";

const configured = Boolean(process.env.ROOTSET_TEST_DATABASE_URL);
const isolatedName = `rootset_bulk_${newId().toLowerCase()}`;
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
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Bulk row tests')",
    [actor.orgId],
  );
  storage = new TableStorage({
    pool,
    ddlPool: pool,
    cursorSecret: "auto-increment-tests-secret-over-thirty-two-bytes",
  });
  databaseId = (await storage.createDatabase(actor, { name: "Bulk records" }))
    .id;
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

async function snapshot(tableId: string) {
  const records = await storage.queryRows(actor, tableId, { limit: 200 });
  const state = await withOrg(pool, actor.orgId, async (c) => {
    const counts: Record<string, unknown> = {};
    for (const name of [
      "mutations",
      "cell_changes",
      "unique_entries",
      "row_comments",
      "resource_history",
    ])
      counts[name] = (
        await c.query(
          `SELECT count(*)::text AS count FROM rootset_control.${name} ${name === "unique_entries" ? "WHERE rule_id IN (SELECT id FROM rootset_control.unique_rules WHERE org_id=$1)" : "WHERE org_id=$1"}`,
          [actor.orgId],
        )
      ).rows[0]!.count;
    counts.counters = (
      await c.query(
        "SELECT field_id,next_value::text FROM rootset_control.integer_counters WHERE org_id=$1 ORDER BY field_id",
        [actor.orgId],
      )
    ).rows;
    return counts;
  });
  return {
    rows: records.data,
    table: await storage.getTable(actor, tableId),
    state,
  };
}
function selection(rows: { id: string; version: string }[]) {
  return rows.map((row) => ({ rowId: row.id, expectedVersion: row.version }));
}
test(
  "bulk previews roll back rows, generated IDs, history, comments and receipts; apply returns identifiers",
  { skip: !configured },
  async () => {
    let table = await storage.createTable(actor, databaseId, {
      name: "Generated",
      fields: [
        {
          name: "RECORD_ID",
          type: "integer",
          autoIncrement: true,
          required: true,
        },
        { name: "NAME", type: "text", required: true, charLimit: 80 },
        { name: "COUNT", type: "integer", default: 0 },
        { name: "ENABLED", type: "boolean", default: false },
        { name: "PAYLOAD", type: "json" },
      ],
    });
    await storage.createUniqueRule(actor, table.id, {
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: table.schemaVersion,
    });
    table = await storage.getTable(actor, table.id);
    const rows = (
      await storage.mutateRows(actor, table.id, {
        operations: [
          {
            kind: "create",
            values: { NAME: "one", PAYLOAD: { note: "", number: 0 } },
          },
          {
            kind: "create",
            values: { NAME: "two", COUNT: null, ENABLED: true },
          },
        ],
      })
    ).rows;
    await withOrg(pool, actor.orgId, (c) =>
      c.query(
        "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_name_snapshot,actor,body) VALUES($1,$2,$3,$4,'Tester',$5,'Retained comment')",
        [newId(), actor.orgId, table.id, rows[0]!.id, JSON.stringify(actor)],
      ),
    );
    const before = await snapshot(table.id);
    const input: BulkRowsInput = {
      expectedSchemaVersion: table.schemaVersion,
      rows: selection(rows),
      action: { type: "duplicate" },
    };
    const preview = await storage.previewBulkRows(actor, table.id, input);
    assert.equal(preview.valid, 2);
    assert.deepEqual(preview.issues, []);
    assert.deepEqual(
      preview.sample.map((row) => row.after!.RECORD_ID),
      [3, 4],
    );
    assert.equal(preview.sample[0]!.after!.ENABLED, false);
    assert.equal(preview.sample[1]!.after!.COUNT, null);
    assert.deepEqual(await snapshot(table.id), before);
    await assert.rejects(
      storage.previewBulkRows(actor, table.id, {
        ...input,
        action: { type: "set", values: { NAME: null } },
      }),
      { code: "VALIDATION_FAILED" },
    );
    await assert.rejects(
      storage.previewBulkRows(actor, table.id, {
        ...input,
        expectedSchemaVersion: table.schemaVersion + 1,
      }),
      { code: "SCHEMA_VERSION_CONFLICT" },
    );
    assert.deepEqual(await snapshot(table.id), before);
    const set: BulkRowsInput = {
      ...input,
      action: { type: "set", values: { COUNT: 0, ENABLED: false, NAME: "" } },
    };
    assert.equal(
      (await storage.previewBulkRows(actor, table.id, set)).valid,
      2,
    );
    assert.deepEqual(await snapshot(table.id), before);
    assert.equal(
      (
        await storage.previewBulkRows(actor, table.id, {
          ...input,
          action: { type: "delete" },
        })
      ).valid,
      2,
    );
    assert.deepEqual(await snapshot(table.id), before);
    await assert.rejects(
      storage.previewBulkRows(actor, table.id, input, {
        signal: AbortSignal.abort(),
      }),
      { code: "REQUEST_TIMEOUT" },
    );
    await assert.rejects(
      storage.previewBulkRows(actor, table.id, input, {
        context: {
          beforePublish: async () => {
            throw new RootsetError(
              "ACCESS_DENIED",
              "Current access changed",
              403,
            );
          },
        },
      }),
      { code: "ACCESS_DENIED" },
    );
    assert.deepEqual(await snapshot(table.id), before);
    const duplicated = await withOrg(pool, actor.orgId, (c) =>
      storage.bulkRows(actor, table.id, input, {}, c),
    );
    assert.equal(duplicated.affected, 2);
    assert.equal(duplicated.createdIds.length, 2);
    const all = (
      await storage.queryRows(actor, table.id, {
        orderBy: [{ field: "RECORD_ID", direction: "asc" }],
      })
    ).data;
    assert.deepEqual(
      all.map((row) => row.values.RECORD_ID),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      all.slice(2).map((row) => row.values.NAME),
      ["one", "two"],
    );
    assert.equal(
      (
        await withOrg(pool, actor.orgId, (c) =>
          c.query(
            "SELECT count(*)::int AS count FROM rootset_control.row_comments WHERE org_id=$1 AND row_id=ANY($2::varchar[])",
            [actor.orgId, duplicated.createdIds],
          ),
        )
      ).rows[0]!.count,
      0,
    );
    const afterDuplicate = await snapshot(table.id);
    await assert.rejects(
      withOrg(pool, actor.orgId, (c) =>
        storage.bulkRows(
          actor,
          table.id,
          set,
          {
            context: {
              beforePublish: async () => {
                throw new RootsetError("ACCESS_DENIED", "Access changed", 403);
              },
            },
          },
          c,
        ),
      ),
      { code: "ACCESS_DENIED" },
    );
    assert.deepEqual(await snapshot(table.id), afterDuplicate);
    await withOrg(pool, actor.orgId, (c) =>
      storage.bulkRows(actor, table.id, set, {}, c),
    );
    const edited = (
      await storage.queryRows(actor, table.id, {
        where: { field: "RECORD_ID", op: "lte", value: 2 },
      })
    ).data;
    assert.ok(
      edited.every(
        (row) =>
          row.values.NAME === "" &&
          row.values.COUNT === 0 &&
          row.values.ENABLED === false,
      ),
    );
    const stale = await storage.previewBulkRows(actor, table.id, input);
    assert.equal(stale.valid, 0);
    assert.deepEqual(
      stale.issues.map((issue) => issue.code),
      ["ROW_VERSION_CONFLICT", "ROW_VERSION_CONFLICT"],
    );
    const beforeDelete = await snapshot(table.id);
    await assert.rejects(
      withOrg(pool, actor.orgId, (c) =>
        storage.bulkRows(
          actor,
          table.id,
          { ...input, action: { type: "delete" } },
          {},
          c,
        ),
      ),
      { code: "ROW_VERSION_CONFLICT" },
    );
    assert.deepEqual(await snapshot(table.id), beforeDelete);
    const deleted = await withOrg(pool, actor.orgId, (c) =>
      storage.bulkRows(
        actor,
        table.id,
        {
          ...input,
          rows: selection(edited),
          action: { type: "delete" },
        },
        {},
        c,
      ),
    );
    assert.equal(deleted.affected, 2);
    assert.deepEqual(deleted.createdIds, []);
    const remaining = await snapshot(table.id);
    assert.deepEqual(
      new Set(remaining.rows.map((row) => row.id)),
      new Set(duplicated.createdIds),
    );
    assert.equal(remaining.table.rowCount, 2);
    assert.equal(remaining.state.row_comments, "0");
  },
);

test(
  "bulk preview collects native/registry unique and foreign-key conflicts and never applies a valid prefix",
  { skip: !configured },
  async () => {
    let parent = await storage.createTable(actor, databaseId, {
      name: "Parents",
      fields: [
        { name: "CODE", type: "text", charLimit: 4096 },
        { name: "EDITION", type: "integer" },
      ],
    });
    const unique = await storage.createUniqueRule(actor, parent.id, {
      fieldIds: parent.fields.map((field) => field.id),
      expectedSchemaVersion: parent.schemaVersion,
    });
    assert.equal(unique.strategy, "registry");
    parent = await storage.getTable(actor, parent.id);
    const parents = (
      await storage.mutateRows(actor, parent.id, {
        operations: [
          { kind: "create", values: { CODE: "one", EDITION: 0 } },
          { kind: "create", values: { CODE: "two", EDITION: 0 } },
        ],
      })
    ).rows;
    let child = await storage.createTable(actor, databaseId, {
      name: "Children",
      fields: [
        { name: "CODE", type: "text", charLimit: 4096 },
        { name: "EDITION", type: "integer" },
      ],
    });
    await storage.createForeignKey(actor, child.id, {
      fieldIds: child.fields.map((field) => field.id),
      referencedTableId: parent.id,
      referencedRuleId: unique.id,
      expectedSchemaVersion: child.schemaVersion,
      expectedReferencedSchemaVersion: parent.schemaVersion,
    });
    child = await storage.getTable(actor, child.id);
    const children = (
      await storage.mutateRows(actor, child.id, {
        operations: [
          { kind: "create", values: { CODE: "one", EDITION: 0 } },
          { kind: "create", values: { CODE: "two", EDITION: 0 } },
        ],
      })
    ).rows;
    const input: BulkRowsInput = {
      expectedSchemaVersion: parent.schemaVersion,
      rows: selection(parents),
      action: { type: "set", values: { CODE: "new" } },
    };
    const parentBefore = await snapshot(parent.id);
    const blocked = await storage.previewBulkRows(actor, parent.id, input);
    assert.equal(blocked.valid, 0);
    assert.ok(
      blocked.issues.every((issue) => issue.code === "FOREIGN_KEY_CONFLICT"),
    );
    assert.equal(
      (
        await storage.previewBulkRows(actor, parent.id, {
          ...input,
          action: { type: "delete" },
        })
      ).issues.length,
      2,
    );
    assert.deepEqual(await snapshot(parent.id), parentBefore);
    const childInput: BulkRowsInput = {
      expectedSchemaVersion: child.schemaVersion,
      rows: selection(children),
      action: { type: "set", values: { CODE: "missing", EDITION: 0 } },
    };
    const childBefore = await snapshot(child.id);
    assert.equal(
      (await storage.previewBulkRows(actor, child.id, childInput)).issues
        .length,
      2,
    );
    assert.deepEqual(await snapshot(child.id), childBefore);
    assert.equal(
      (
        await storage.previewBulkRows(actor, child.id, {
          ...childInput,
          action: { type: "set", values: { CODE: null } },
        })
      ).valid,
      2,
    );
    assert.deepEqual(await snapshot(child.id), childBefore);
    let independent = await storage.createTable(actor, databaseId, {
      name: "Unique",
      fields: [{ name: "CODE", type: "text", charLimit: 4096 }],
    });
    await storage.createUniqueRule(actor, independent.id, {
      fieldIds: [independent.fields[0]!.id],
      expectedSchemaVersion: independent.schemaVersion,
    });
    independent = await storage.getTable(actor, independent.id);
    const rows = (
      await storage.mutateRows(actor, independent.id, {
        operations: [
          { kind: "create", values: { CODE: "a" } },
          { kind: "create", values: { CODE: "b" } },
        ],
      })
    ).rows;
    const conflict: BulkRowsInput = {
      expectedSchemaVersion: independent.schemaVersion,
      rows: selection(rows),
      action: { type: "set", values: { CODE: "same" } },
    };
    const initial = await snapshot(independent.id);
    const preview = await storage.previewBulkRows(
      actor,
      independent.id,
      conflict,
    );
    assert.equal(preview.valid, 1);
    assert.equal(preview.issues[0]!.index, 1);
    assert.equal(preview.issues[0]!.code, "UNIQUE_CONFLICT");
    assert.deepEqual(await snapshot(independent.id), initial);
    await assert.rejects(
      withOrg(pool, actor.orgId, (c) =>
        storage.bulkRows(actor, independent.id, conflict, {}, c),
      ),
      { code: "UNIQUE_CONFLICT" },
    );
    assert.deepEqual(await snapshot(independent.id), initial);
  },
);
