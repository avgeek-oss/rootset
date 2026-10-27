import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExportViewQuerySchema,
  normalizeExportViewQuery,
  getOperation,
  type FieldDefinition,
} from "./index";
const id = "01J00000000000000000000001";
const fields: FieldDefinition[] = [
  { id, name: "COUNT", type: "integer" },
  { id: "01J00000000000000000000002", name: "NAME", type: "text" },
];
test("current-view exports capture a bounded projection without page cursors or limits", () => {
  const base = {
    orgId: id,
    workspaceId: id,
    databaseId: id,
    tableId: id,
    expectedSchemaVersion: 1,
    format: "csv",
    query: { select: [id] },
  };
  assert.doesNotThrow(() => getOperation("exportView").inputSchema.parse(base));
  for (const query of [
    { select: [] },
    { select: [id, id] },
    { select: [id], limit: 50 },
    { select: [id], cursor: null },
    {
      select: [id],
      where: {
        and: Array.from({ length: 101 }, () => ({
          field: id,
          op: "eq",
          value: 0,
        })),
      },
    },
    {
      select: [id],
      where: { field: "NAME", op: "eq", value: "x".repeat(65_536) },
    },
  ])
    assert.throws(() => ExportViewQuerySchema.parse(query));
  assert.equal(
    getOperation("exportRows").inputSchema.safeParse({
      orgId: id,
      workspaceId: id,
      databaseId: id,
      tableId: id,
      format: "csv",
      query: base.query,
    }).success,
    false,
  );
});
test("export projections and predicates use stable IDs and reject aliases or deleted fields", () => {
  const query = normalizeExportViewQuery(
    {
      select: ["NAME", "COUNT"],
      where: { field: "COUNT", op: "eq", value: 0 },
      orderBy: [{ field: "NAME", direction: "desc" }],
    },
    fields,
  );
  assert.deepEqual(query, {
    select: [fields[1]!.id, id],
    where: { field: id, op: "eq", value: 0 },
    orderBy: [{ field: fields[1]!.id, direction: "desc" }],
  });
  assert.deepEqual(
    normalizeExportViewQuery(
      query,
      fields.map((f) => ({ ...f, name: `NEW_${f.name}` })),
    ),
    query,
  );
  for (const input of [
    { select: [id, "COUNT"] },
    { select: ["deleted"] },
    { select: [id], where: { field: id, op: "contains", value: "0" } },
  ])
    assert.throws(() => normalizeExportViewQuery(input, fields));
});
