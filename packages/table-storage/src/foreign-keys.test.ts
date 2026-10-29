import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPool, migrate, type Pool } from "@rootset/database";
import { newId, type Actor } from "@rootset/contracts";
import { TableStorage, type TableRecord } from "./index.js";

const configured = Boolean(process.env.ROOTSET_TEST_DATABASE_URL);
const isolatedName = `rootset_fk_${newId().toLowerCase()}`;
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
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Foreign key tests')",
    [actor.orgId],
  );
  storage = new TableStorage({
    pool,
    ddlPool: pool,
    cursorSecret: "foreign-key-tests-secret-over-thirty-two-bytes",
  });
  databaseId = (await storage.createDatabase(actor, { name: "Links" })).id;
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
async function pair(type: "integer" | "text" = "integer") {
  let target = await storage.createTable(actor, databaseId, {
    name: "Parents",
    fields: [{ name: "CODE", type }],
  });
  const unique = await storage.createUniqueRule(actor, target.id, {
    fieldIds: [target.fields[0]!.id],
    expectedSchemaVersion: target.schemaVersion,
  });
  target = await storage.getTable(actor, target.id);
  const source = await storage.createTable(actor, databaseId, {
    name: "Children",
    fields: [{ name: "PARENT", type }],
  });
  return { source, target, unique };
}
function link(
  source: TableRecord,
  target: TableRecord,
  ruleId: string,
  idempotencyKey?: string,
) {
  return storage.createForeignKey(actor, source.id, {
    fieldIds: [source.fields[0]!.id],
    referencedTableId: target.id,
    referencedRuleId: ruleId,
    expectedSchemaVersion: source.schemaVersion,
    expectedReferencedSchemaVersion: target.schemaVersion,
    idempotencyKey,
  });
}

test(
  "foreign keys validate existing rows atomically and replay the committed identity",
  { skip: !configured },
  async () => {
    const { source, target, unique } = await pair();
    const invalid = await storage.createRow(actor, source.id, { PARENT: 7 });
    await assert.rejects(link(source, target, unique.id), {
      code: "FOREIGN_KEY_CONFLICT",
    });
    assert.deepEqual(await storage.listForeignKeys(actor, source.id), []);
    assert.equal(
      (await storage.getTable(actor, source.id)).schemaVersion,
      source.schemaVersion,
    );
    await storage.createRow(actor, target.id, { CODE: 7 });
    const rule = await link(source, target, unique.id, "create-link");
    assert.deepEqual(
      await link(source, target, unique.id, "create-link"),
      rule,
    );
    assert.equal((await storage.listForeignKeys(actor, source.id)).length, 1);
    assert.equal(
      (await storage.getRow(actor, source.id, invalid.id)).version,
      invalid.version,
    );
    await assert.rejects(
      link(await storage.getTable(actor, source.id), target, unique.id),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
  },
);

test(
  "writes, imports and batches enforce references; NULLs are allowed and target updates/deletes are restricted",
  { skip: !configured },
  async () => {
    const { source, target, unique } = await pair();
    const parent = await storage.createRow(actor, target.id, { CODE: 42 });
    const rule = await link(source, target, unique.id);
    await storage.createRow(actor, source.id, { PARENT: null });
    const child = await storage.createRow(actor, source.id, { PARENT: 42 });
    await assert.rejects(storage.createRow(actor, source.id, { PARENT: 404 }), {
      code: "FOREIGN_KEY_CONFLICT",
    });
    await assert.rejects(
      storage.mutateRows(actor, source.id, {
        context: { source: "import" },
        operations: [
          { kind: "create", values: { PARENT: 42 } },
          { kind: "create", values: { PARENT: 404 } },
        ],
      }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    assert.equal((await storage.getTable(actor, source.id)).rowCount, 2);
    await assert.rejects(
      storage.updateRow(
        actor,
        target.id,
        parent.id,
        { CODE: 43 },
        { expectedVersion: parent.version },
      ),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    await assert.rejects(
      storage.deleteRow(actor, target.id, parent.id, {
        expectedVersion: parent.version,
      }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    await storage.updateRow(
      actor,
      source.id,
      child.id,
      { PARENT: null },
      { expectedVersion: child.version },
    );
    await storage.deleteRow(actor, target.id, parent.id, {
      expectedVersion: parent.version,
    });
    await storage.deleteForeignKey(actor, source.id, rule.id, {
      expectedSchemaVersion: (await storage.getTable(actor, source.id))
        .schemaVersion,
    });
    await storage.createRow(actor, source.id, { PARENT: 404 });
  },
);

test(
  "wide text keys and composite mappings preserve exact values and skip partial NULL tuples",
  { skip: !configured },
  async () => {
    const { source, target, unique } = await pair("text");
    assert.equal(unique.strategy, "registry");
    const value = "a".repeat(2000);
    await storage.createRow(actor, target.id, { CODE: value });
    await link(source, target, unique.id);
    await storage.createRow(actor, source.id, { PARENT: value });
    await assert.rejects(
      storage.createRow(actor, source.id, { PARENT: value.toUpperCase() }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    let composite = await storage.createTable(actor, databaseId, {
      name: "Composite",
      fields: [
        { name: "CODE", type: "text" },
        { name: "REGION", type: "integer" },
      ],
    });
    const key = await storage.createUniqueRule(actor, composite.id, {
      fieldIds: composite.fields.map((f) => f.id),
      expectedSchemaVersion: composite.schemaVersion,
    });
    composite = await storage.getTable(actor, composite.id);
    const child = await storage.createTable(actor, databaseId, {
      name: "Composite child",
      fields: [
        { name: "REGION", type: "integer" },
        { name: "CODE", type: "text" },
      ],
    });
    await storage.createRow(actor, composite.id, { CODE: "exact ", REGION: 3 });
    await storage.createForeignKey(actor, child.id, {
      fieldIds: [child.fields[1]!.id, child.fields[0]!.id],
      referencedTableId: composite.id,
      referencedRuleId: key.id,
      expectedSchemaVersion: child.schemaVersion,
      expectedReferencedSchemaVersion: composite.schemaVersion,
    });
    await storage.createRow(actor, child.id, { CODE: "exact ", REGION: 3 });
    await storage.createRow(actor, child.id, { CODE: "missing", REGION: null });
    await assert.rejects(
      storage.createRow(actor, child.id, { CODE: "exact", REGION: 3 }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
  },
);

test(
  "schema changes cannot invalidate linked fields, target rules or tables",
  { skip: !configured },
  async () => {
    const { source, target, unique } = await pair();
    await link(source, target, unique.id);
    const options = { expectedSchemaVersion: target.schemaVersion };
    await assert.rejects(
      storage.deleteUniqueRule(actor, target.id, unique.id, options),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    await assert.rejects(storage.deleteTable(actor, target.id, options), {
      code: "FOREIGN_KEY_CONFLICT",
    });
    await assert.rejects(
      storage.deleteField(actor, target.id, target.fields[0]!.id, {
        ...options,
        removeDependencies: true,
      }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    await assert.rejects(
      storage.updateField(actor, target.id, target.fields[0]!.id, {
        ...options,
        type: "text",
        conversion: { strategy: "stringify" },
      }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    const renamed = await storage.updateField(
      actor,
      target.id,
      target.fields[0]!.id,
      { ...options, name: "RENAMED" },
    );
    await storage.createRow(actor, renamed.id, { RENAMED: 8 });
    await storage.createRow(actor, source.id, { PARENT: 8 });
  },
);

test(
  "cross-database, incompatible, conditional and stale targets are rejected",
  { skip: !configured },
  async () => {
    const { source, target, unique } = await pair();
    await assert.rejects(
      link(
        source,
        { ...target, schemaVersion: target.schemaVersion - 1 },
        unique.id,
      ),
      { code: "SCHEMA_VERSION_CONFLICT" },
    );
    const other = await storage.createDatabase(actor, { name: "Other" });
    const cross = await storage.createTable(actor, other.id, {
      name: "Other child",
      fields: [{ name: "PARENT", type: "integer" }],
    });
    await assert.rejects(link(cross, target, unique.id), {
      code: "VALIDATION_FAILED",
    });
    const text = await storage.createTable(actor, databaseId, {
      name: "Wrong type",
      fields: [{ name: "PARENT", type: "text" }],
    });
    await assert.rejects(link(text, target, unique.id), {
      code: "VALIDATION_FAILED",
    });
    const conditional = await storage.createUniqueRule(actor, target.id, {
      fieldIds: [target.fields[0]!.id],
      where: { field: target.fields[0]!.id, op: "isNotNull" },
      expectedSchemaVersion: target.schemaVersion,
    });
    await assert.rejects(
      link(source, await storage.getTable(actor, target.id), conditional.id),
      { code: "VALIDATION_FAILED" },
    );
  },
);

test(
  "self references, multiple dependants and unrelated field conversion preserve enforcement",
  { skip: !configured },
  async () => {
    let self = await storage.createTable(actor, databaseId, {
      name: "Self references",
      fields: [
        { name: "CODE", type: "integer" },
        { name: "PARENT", type: "integer" },
      ],
    });
    const unique = await storage.createUniqueRule(actor, self.id, {
      fieldIds: [self.fields[0]!.id],
      expectedSchemaVersion: self.schemaVersion,
    });
    self = await storage.getTable(actor, self.id);
    await storage.createForeignKey(actor, self.id, {
      fieldIds: [self.fields[1]!.id],
      referencedTableId: self.id,
      referencedRuleId: unique.id,
      expectedSchemaVersion: self.schemaVersion,
      expectedReferencedSchemaVersion: self.schemaVersion,
    });
    const row = await storage.createRow(actor, self.id, { CODE: 1, PARENT: 1 });
    await storage.deleteRow(actor, self.id, row.id, {
      expectedVersion: row.version,
    });
    const { source, target, unique: key } = await pair();
    const first = await link(source, target, key.id);
    let other = await storage.createTable(actor, databaseId, {
      name: "Another child",
      fields: [
        { name: "PARENT", type: "integer" },
        { name: "EXTRA", type: "integer" },
      ],
    });
    await link(other, target, key.id);
    const parent = await storage.createRow(actor, target.id, { CODE: 8 });
    await storage.createRow(actor, other.id, { PARENT: 8, EXTRA: 3 });
    other = await storage.getTable(actor, other.id);
    await storage.updateField(actor, other.id, other.fields[1]!.id, {
      type: "text",
      conversion: { strategy: "stringify" },
      expectedSchemaVersion: other.schemaVersion,
    });
    await assert.rejects(
      storage.createRow(actor, other.id, { PARENT: 9, EXTRA: "4" }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    await storage.deleteForeignKey(actor, source.id, first.id, {
      expectedSchemaVersion: (await storage.getTable(actor, source.id))
        .schemaVersion,
    });
    await assert.rejects(
      storage.deleteRow(actor, target.id, parent.id, {
        expectedVersion: parent.version,
      }),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    const forbidden = { ...actor, orgId: newId() };
    await assert.rejects(storage.listForeignKeys(forbidden, other.id), {
      code: "RESOURCE_NOT_FOUND",
    });
  },
);

test(
  "digest collisions still require the full referenced tuple",
  { skip: !configured },
  async () => {
    const original = (
      await pool.query<{ definition: string }>(
        "SELECT pg_get_functiondef('rootset_control.unique_digest(text)'::regprocedure) AS definition",
      )
    ).rows[0]!.definition;
    try {
      await pool.query(
        "CREATE OR REPLACE FUNCTION rootset_control.unique_digest(tuple_arg text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT 'collision' $$",
      );
      const { source, target, unique } = await pair("text");
      await storage.createRow(actor, target.id, { CODE: "first".repeat(300) });
      await storage.createRow(actor, target.id, { CODE: "second".repeat(300) });
      await link(source, target, unique.id);
      await storage.createRow(actor, source.id, {
        PARENT: "first".repeat(300),
      });
      await storage.createRow(actor, source.id, {
        PARENT: "second".repeat(300),
      });
      await assert.rejects(
        storage.createRow(actor, source.id, { PARENT: "missing".repeat(300) }),
        { code: "FOREIGN_KEY_CONFLICT" },
      );
    } finally {
      await pool.query(original);
    }
  },
);

test(
  "a concurrent parent delete and child insert cannot commit an orphan",
  { skip: !configured },
  async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { source, target, unique } = await pair();
      const parent = await storage.createRow(actor, target.id, { CODE: 1 });
      await link(source, target, unique.id);
      const results = await Promise.allSettled([
        storage.createRow(actor, source.id, { PARENT: 1 }),
        storage.deleteRow(actor, target.id, parent.id, {
          expectedVersion: parent.version,
        }),
      ]);
      assert.ok(results.some((result) => result.status === "rejected"));
      const children = await storage.queryRows(actor, source.id, {});
      const parents = await storage.queryRows(actor, target.id, {});
      assert.ok(children.data.length === 0 || parents.data.length === 1);
    }
  },
);

test(
  "reverse relationships use registry counts, typed composite keys and current source metadata",
  { skip: !configured },
  async () => {
    let parent = await storage.createTable(actor, databaseId, {
      name: "Reverse parents",
      fields: [
        { name: "CODE", type: "text", charLimit: 5000 },
        { name: "EDITION", type: "integer" },
        { name: "ACTIVE", type: "boolean" },
      ],
    });
    const unique = await storage.createUniqueRule(actor, parent.id, {
      fieldIds: parent.fields.map((field) => field.id),
      expectedSchemaVersion: parent.schemaVersion,
    });
    parent = await storage.getTable(actor, parent.id);
    const code = "001" + "x".repeat(4000);
    const first = await storage.createRow(actor, parent.id, {
      CODE: code,
      EDITION: 0,
      ACTIVE: false,
    });
    const empty = await storage.createRow(actor, parent.id, {
      CODE: null,
      EDITION: 0,
      ACTIVE: false,
    });
    const source = await storage.createTable(actor, databaseId, {
      name: "Reverse children",
      fields: [
        { name: "P_CODE", type: "text", charLimit: 5000 },
        { name: "P_EDITION", type: "integer" },
        { name: "P_ACTIVE", type: "boolean" },
      ],
    });
    const key = await storage.createForeignKey(actor, source.id, {
      fieldIds: source.fields.map((field) => field.id),
      referencedTableId: parent.id,
      referencedRuleId: unique.id,
      expectedSchemaVersion: source.schemaVersion,
      expectedReferencedSchemaVersion: parent.schemaVersion,
    });
    const child1 = await storage.createRow(actor, source.id, {
      P_CODE: code,
      P_EDITION: 0,
      P_ACTIVE: false,
    });
    const child2 = await storage.createRow(actor, source.id, {
      P_CODE: code,
      P_EDITION: 0,
      P_ACTIVE: false,
    });
    await storage.createRow(actor, source.id, {
      P_CODE: null,
      P_EDITION: 0,
      P_ACTIVE: false,
    });
    const page = await storage.rowRelationships(actor, parent.id, first.id, {
      afterId: null,
      limit: 21,
      expectedVersion: first.version,
    });
    assert.equal(page.rowVersion, first.version);
    assert.equal(page.data.length, 1);
    assert.deepEqual(page.data[0], {
      id: key.id,
      tableId: source.id,
      tableName: source.name,
      tableState: "active",
      fieldIds: source.fields.map((field) => field.id),
      fieldNames: ["P_CODE", "P_EDITION", "P_ACTIVE"],
      referencedFieldIds: parent.fields.map((field) => field.id),
      count: 2,
      hasKey: true,
    });
    const filter = await storage.relatedRowFilter(
      actor,
      source.id,
      key.id,
      first.id,
    );
    assert.deepEqual(
      filter.filter,
      source.fields.map((field, index) => ({
        fieldId: field.id,
        value: [code, 0, false][index],
      })),
    );
    const query = {
      where: {
        and: filter.filter.map((item) => ({
          field: item.fieldId,
          op: "eq" as const,
          value: item.value,
        })),
      },
    };
    assert.equal(
      (await storage.queryRows(actor, source.id, query)).data.length,
      2,
    );
    assert.equal(
      (
        await storage.rowRelationships(actor, parent.id, empty.id, {
          afterId: null,
          limit: 21,
        })
      ).data[0]!.hasKey,
      false,
    );
    assert.equal(
      (
        await storage.rowRelationships(actor, parent.id, empty.id, {
          afterId: null,
          limit: 21,
        })
      ).data[0]!.count,
      0,
    );
    await assert.rejects(
      storage.relatedRowFilter(actor, source.id, key.id, empty.id),
      { code: "FOREIGN_KEY_CONFLICT" },
    );
    await storage.updateRow(
      actor,
      source.id,
      child1.id,
      { P_CODE: null },
      { expectedVersion: child1.version },
    );
    assert.equal(
      (
        await storage.rowRelationships(actor, parent.id, first.id, {
          afterId: null,
          limit: 21,
        })
      ).data[0]!.count,
      1,
    );
    await storage.deleteRow(actor, source.id, child2.id, {
      expectedVersion: child2.version,
    });
    assert.equal(
      (
        await storage.rowRelationships(actor, parent.id, first.id, {
          afterId: null,
          limit: 21,
        })
      ).data[0]!.count,
      0,
    );
    const changed = await storage.updateRow(
      actor,
      parent.id,
      first.id,
      { EDITION: 1 },
      { expectedVersion: first.version },
    );
    await assert.rejects(
      storage.rowRelationships(actor, parent.id, first.id, {
        afterId: null,
        limit: 21,
        expectedVersion: first.version,
      }),
      { code: "ROW_VERSION_CONFLICT" },
    );
    assert.equal(
      (await storage.relatedRowFilter(actor, source.id, key.id, first.id))
        .filter[1]!.value,
      1,
    );
    assert.equal(
      (await storage.relatedRowFilter(actor, source.id, key.id, first.id))
        .referencedVersion,
      changed.version,
    );
    await assert.rejects(
      storage.rowRelationships(
        { ...actor, orgId: newId() },
        parent.id,
        first.id,
        { afterId: null, limit: 21 },
      ),
      { code: "RESOURCE_NOT_FOUND" },
    );
    await assert.rejects(
      storage.relatedRowFilter(actor, parent.id, key.id, first.id),
      { code: "RESOURCE_NOT_FOUND" },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      storage.rowRelationships(
        actor,
        parent.id,
        first.id,
        { afterId: null, limit: 21 },
        controller.signal,
      ),
    );
    await storage.deleteForeignKey(actor, source.id, key.id, {
      expectedSchemaVersion: (await storage.getTable(actor, source.id))
        .schemaVersion,
    });
    assert.deepEqual(
      (
        await storage.rowRelationships(actor, parent.id, first.id, {
          afterId: null,
          limit: 21,
        })
      ).data,
      [],
    );
    await assert.rejects(
      storage.relatedRowFilter(actor, source.id, key.id, first.id),
      { code: "RESOURCE_NOT_FOUND" },
    );
  },
);

test(
  "reverse registry pages distinguish multiple rules and self references",
  { skip: !configured },
  async () => {
    let parent = await storage.createTable(actor, databaseId, {
      name: "Reverse self",
      fields: [
        { name: "CODE", type: "integer" },
        { name: "PARENT", type: "integer" },
      ],
    });
    const unique = await storage.createUniqueRule(actor, parent.id, {
      fieldIds: [parent.fields[0]!.id],
      expectedSchemaVersion: parent.schemaVersion,
    });
    parent = await storage.getTable(actor, parent.id);
    const saved = await storage.createRow(actor, parent.id, {
      CODE: 0,
      PARENT: 0,
    });
    const self = await storage.createForeignKey(actor, parent.id, {
      fieldIds: [parent.fields[1]!.id],
      referencedTableId: parent.id,
      referencedRuleId: unique.id,
      expectedSchemaVersion: parent.schemaVersion,
      expectedReferencedSchemaVersion: parent.schemaVersion,
    });
    parent = await storage.getTable(actor, parent.id);
    const source = await storage.createTable(actor, databaseId, {
      name: "Two references",
      fields: [
        { name: "ONE", type: "integer" },
        { name: "TWO", type: "integer" },
      ],
    });
    await storage.createForeignKey(actor, source.id, {
      fieldIds: [source.fields[0]!.id],
      referencedTableId: parent.id,
      referencedRuleId: unique.id,
      expectedSchemaVersion: source.schemaVersion,
      expectedReferencedSchemaVersion: parent.schemaVersion,
    });
    await storage.createForeignKey(actor, source.id, {
      fieldIds: [source.fields[1]!.id],
      referencedTableId: parent.id,
      referencedRuleId: unique.id,
      expectedSchemaVersion: (await storage.getTable(actor, source.id))
        .schemaVersion,
      expectedReferencedSchemaVersion: parent.schemaVersion,
    });
    await storage.createRow(actor, source.id, { ONE: 0, TWO: 0 });
    await storage.createRow(actor, source.id, { ONE: 0, TWO: null });
    const all = await storage.rowRelationships(actor, parent.id, saved.id, {
      afterId: null,
      limit: 21,
    });
    assert.deepEqual(
      all.data.map((relation) => relation.count),
      [1, 2, 1],
    );
    assert.equal(all.data[0]!.id, self.id);
    const first = await storage.rowRelationships(actor, parent.id, saved.id, {
      afterId: null,
      limit: 2,
    });
    const next = await storage.rowRelationships(actor, parent.id, saved.id, {
      afterId: first.data[0]!.id,
      limit: 2,
    });
    assert.deepEqual(
      next.data.map((relation) => relation.id),
      all.data.slice(1).map((relation) => relation.id),
    );
    assert.equal(
      (await storage.relatedRowFilter(actor, parent.id, self.id, saved.id))
        .filter[0]!.value,
      0,
    );
  },
);
