import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SavedViewDefinitionSchema,
  normalizeSavedViewDefinition,
  resolveSavedViewDefinition,
} from "./views";
import { assertQueryLexemes } from "./query";
import { parseStrictJson, type NumberLexeme } from "./decoder";
import type { FieldDefinition } from "./models";
const fields: FieldDefinition[] = [
  {
    id: "01J00000000000000000000001",
    name: "NAME",
    type: "text",
    charLimit: 80,
  },
  { id: "01J00000000000000000000002", name: "COUNT", type: "integer" },
  { id: "01J00000000000000000000003", name: "ENABLED", type: "boolean" },
];
const layout = {
  columnOrder: fields.map((field) => field.id),
  hiddenColumns: [fields[1]!.id],
  columnWidths: { [fields[0]!.id]: 220 },
  frozenColumns: 1,
};
test("saved views retain nested typed predicates with stable IDs across field renames", () => {
  const definition = normalizeSavedViewDefinition(
    {
      ...layout,
      query: {
        where: {
          and: [
            { field: "COUNT", op: "eq", value: 0 },
            {
              or: [
                { field: "ENABLED", op: "eq", value: false },
                { field: "NAME", op: "isNull" },
              ],
            },
          ],
        },
        orderBy: [{ field: "NAME", direction: "asc" }],
      },
    },
    fields,
  );
  const renamed = fields.map((field) => ({
    ...field,
    name: field.name + "_RENAMED",
  }));
  const resolved = resolveSavedViewDefinition(definition, renamed);
  assert.deepEqual(resolved.validationErrors, []);
  assert.deepEqual(resolved.definition, definition);
  assert.equal(definition.query.orderBy?.[0]?.field, fields[0]!.id);
  assert.ok(JSON.stringify(definition.query.where).includes('"value":false'));
});
test("schema evolution prunes only layout IDs, appends new fields, and never drops a missing filter", () => {
  const original = normalizeSavedViewDefinition(
    { ...layout, query: { where: { field: "COUNT", op: "eq", value: 0 } } },
    fields,
  );
  const next = [
    fields[0]!,
    fields[2]!,
    {
      id: "01J00000000000000000000004",
      name: "NEW_FIELD",
      type: "text" as const,
    },
  ];
  const resolved = resolveSavedViewDefinition(original, next);
  assert.equal(resolved.validationErrors.length, 1);
  assert.deepEqual(resolved.definition.query, original.query);
  assert.deepEqual(resolved.definition.hiddenColumns, []);
  assert.deepEqual(
    resolved.definition.columnOrder,
    next.map((field) => field.id),
  );
});
test("saved layouts reject duplicate/unknown fields and query runtime parameters", () => {
  assert.throws(() =>
    normalizeSavedViewDefinition(
      { ...layout, columnOrder: [fields[0]!.id, fields[0]!.id], query: {} },
      fields,
    ),
  );
  assert.throws(() =>
    normalizeSavedViewDefinition(
      { ...layout, hiddenColumns: ["01J00000000000000000000009"], query: {} },
      fields,
    ),
  );
  for (const query of [{ limit: 50 }, { cursor: "next" }, { select: ["NAME"] }])
    assert.equal(
      SavedViewDefinitionSchema.safeParse({ ...layout, query }).success,
      false,
    );
  assert.equal(
    SavedViewDefinitionSchema.safeParse({
      ...layout,
      query: { where: { field: "NAME", op: "eq", value: "a".repeat(65_536) } },
    }).success,
    false,
  );
});

test("saved view predicates retain numeric source validation under the definition envelope", () => {
  const lexemes: NumberLexeme[] = [];
  const input = JSON.stringify({
    ...layout,
    query: { where: { field: "COUNT", op: "eq", value: "raw-number" } },
  }).replace('"raw-number"', "9007199254740991.1");
  const parsed = parseStrictJson(`{"definition":${input}}`, {
    safeIntegers: false,
    onNumber: (value) => lexemes.push(value),
  }) as { definition: unknown };
  const definition = SavedViewDefinitionSchema.parse(parsed.definition);
  assert.throws(
    () =>
      assertQueryLexemes(fields, definition.query, lexemes, [
        "definition",
        "query",
      ]),
    /integer/,
  );
  let where: unknown = { field: "NAME", op: "eq", value: "test" };
  for (let index = 0; index < 100; index++) where = { and: [where] };
  assert.throws(
    () => SavedViewDefinitionSchema.parse({ ...layout, query: { where } }),
    /depth\/node budget/,
  );
});
