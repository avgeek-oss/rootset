import assert from "node:assert/strict";
import test from "node:test";
import {
  newId,
  validateUniqueRuleCondition,
  UniqueRuleConditionSchema,
  assertQueryLexemes,
  type FieldDefinition,
} from "./index";

const fields: FieldDefinition[] = [
  { id: newId(), name: "status", type: "text" },
  { id: newId(), name: "count", type: "integer", min: 10 },
  { id: newId(), name: "at", type: "date-time" },
  { id: newId(), name: "json", type: "json" },
];
test("unique conditions share typed filter values but persist only stable IDs", () => {
  assert.equal(validateUniqueRuleCondition(undefined, fields), undefined);
  assert.deepEqual(
    validateUniqueRuleCondition(
      { field: fields[0]!.id.toLowerCase(), op: "eq", value: " active " },
      fields,
    ),
    { field: fields[0]!.id, op: "eq", value: " active " },
  );
  assert.deepEqual(
    validateUniqueRuleCondition(
      { field: fields[1]!.id, op: "ne", value: 1 },
      fields,
    ),
    { field: fields[1]!.id, op: "ne", value: 1 },
  );
  assert.deepEqual(
    validateUniqueRuleCondition(
      { field: fields[2]!.id, op: "eq", value: "2026-01-01T00:00:00Z" },
      fields,
    ),
    { field: fields[2]!.id, op: "eq", value: "2026-01-01T00:00:00.000Z" },
  );
  for (const op of ["isNull", "isNotNull"])
    assert.deepEqual(
      validateUniqueRuleCondition({ field: fields[0]!.id, op }, fields),
      { field: fields[0]!.id, op },
    );
});
test("unique conditions reject unsupported shape, fields, types and numeric loss", () => {
  const base = { field: fields[0]!.id, op: "eq", value: "active" };
  for (const input of [
    null,
    { and: [base] },
    { ...base, field: "status" },
    { ...base, field: newId() },
    { ...base, op: "contains" },
    { ...base, path: ["key"] },
    { ...base, value: null },
    { ...base, value: [] },
    { ...base, value: {} },
    { ...base, op: "isNull" },
    { ...base, field: fields[3]!.id },
    { ...base, field: fields[1]!.id, value: 1.5 },
    { ...base, field: fields[1]!.id, value: "1" },
  ])
    assert.throws(() => validateUniqueRuleCondition(input, fields), {
      code: "VALIDATION_FAILED",
    });
  assert.equal(
    UniqueRuleConditionSchema.safeParse({ ...base, value: Infinity }).success,
    false,
  );
  assert.throws(
    () =>
      assertQueryLexemes(
        fields,
        { where: { field: fields[1]!.id, op: "eq", value: 1 } },
        [
          {
            path: ["where", "value"],
            lexeme: "1.00000000000000001",
            pointer: "/where/value",
            value: 1,
            integer: false,
            safeInteger: false,
          },
        ],
        [],
      ),
    { code: "VALIDATION_FAILED" },
  );
});
