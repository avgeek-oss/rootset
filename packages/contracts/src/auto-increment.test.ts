import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FieldDefinitionSchema,
  FieldInputSchema,
  validateValues,
} from "./values.js";
import { newId } from "./models.js";

const field = {
  id: newId(),
  name: "RECORD_ID",
  type: "integer" as const,
  required: true,
  autoIncrement: true,
};

test("auto-increment is an integer generator and cannot have a constant default", () => {
  assert.equal(FieldDefinitionSchema.safeParse(field).success, true);
  for (const type of ["text", "float", "boolean", "json"])
    assert.equal(
      FieldDefinitionSchema.safeParse({ ...field, type }).success,
      false,
    );
  for (const value of [null, 1, "1"])
    assert.equal(
      FieldDefinitionSchema.safeParse({ ...field, default: value }).success,
      false,
    );
  assert.equal(
    FieldInputSchema.safeParse({
      name: field.name,
      type: "integer",
      required: true,
    }).success,
    true,
  );
  assert.equal(
    FieldDefinitionSchema.safeParse({
      ...field,
      autoIncrement: false,
      default: 1,
    }).success,
    true,
  );
});

test("create validation leaves only omitted generated values for server allocation", () => {
  assert.equal(Object.hasOwn(validateValues([field], {}), field.name), false);
  assert.deepEqual(
    { ...validateValues([field], { [field.id]: 42 }) },
    { RECORD_ID: 42 },
  );
  assert.throws(() => validateValues([field], { RECORD_ID: null }), /required/);
  assert.deepEqual(
    { ...validateValues([{ ...field, required: false }], { RECORD_ID: null }) },
    { RECORD_ID: null },
  );
  assert.throws(
    () => validateValues([{ ...field, autoIncrement: false }], {}),
    /required/,
  );
  assert.deepEqual({ ...validateValues([field], {}, "patch") }, {});
});
