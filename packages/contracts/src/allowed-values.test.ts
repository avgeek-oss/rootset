import assert from "node:assert/strict";
import test from "node:test";
import {
  FieldDefinitionSchema,
  FieldInputSchema,
  validateCell,
  validateValues,
  validateQuery,
  newId,
  type FieldDefinition,
} from "./index";

const field: FieldDefinition = {
  id: newId(),
  name: "status",
  type: "text",
  charLimit: 32,
  allowedValues: ["active", "ceased", "NULL", " Active "],
};
test("text choices match exactly and preserve optional null, required and defaults", () => {
  const checked = FieldDefinitionSchema.parse(field);
  for (const choice of field.allowedValues!)
    assert.equal(validateCell(checked, choice), choice);
  assert.equal(validateCell(checked, null), null);
  for (const value of ["", "Active", " active", "active ", "null", 1, false])
    assert.throws(() => validateCell(checked, value), {
      code: "VALIDATION_FAILED",
    });
  assert.throws(() => validateCell({ ...field, required: true }, null), {
    code: "VALIDATION_FAILED",
  });
  assert.equal(
    validateValues([{ ...field, required: true, default: "active" }], {})
      .status,
    "active",
  );
  assert.equal(
    FieldDefinitionSchema.safeParse({ ...field, default: "unknown" }).success,
    false,
  );
  assert.equal(
    FieldInputSchema.safeParse({
      name: "status",
      type: "text",
      allowedValues: ["active"],
      default: "ceased",
    }).success,
    false,
  );
  assert.equal(
    validateCell({ ...field, allowedValues: null }, "anything"),
    "anything",
  );
  // Query conditions can intentionally select an empty subset; populated-cell
  // restrictions do not constrain the query language.
  assert.equal(
    (
      validateQuery(
        { where: { field: field.id, op: "eq", value: "unknown" } },
        [field],
      ).where as { value: string }
    ).value,
    "unknown",
  );
});
test("choice definitions are bounded, nonempty, distinct and text-only", () => {
  for (const allowedValues of [
    [],
    [""],
    ["active", "active"],
    Array.from({ length: 101 }, (_, i) => String(i)),
    ["bad\u0000"],
    ["\ud800"],
    ["x".repeat(33)],
    Array.from({ length: 100 }, (_, i) => `${i}${"x".repeat(4094)}`),
  ])
    assert.equal(
      FieldDefinitionSchema.safeParse({ ...field, allowedValues }).success,
      false,
    );
  assert.equal(
    FieldDefinitionSchema.safeParse({
      ...field,
      allowedValues: ["Active", "active", " active", " "],
    }).success,
    true,
  );
  assert.equal(
    FieldDefinitionSchema.safeParse({
      ...field,
      charLimit: 1,
      allowedValues: ["🌿"],
    }).success,
    true,
  );
  for (const type of [
    "uri",
    "url",
    "image",
    "integer",
    "float",
    "boolean",
    "date",
    "time",
    "date-time",
    "json",
  ])
    assert.equal(
      FieldDefinitionSchema.safeParse({ ...field, type }).success,
      false,
    );
  assert.equal(
    FieldDefinitionSchema.safeParse({ ...field, allowedValues: null }).success,
    true,
  );
});
