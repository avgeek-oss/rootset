import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FieldDefinitionSchema,
  FieldInputSchema,
  FieldChangesSchema,
  RootsetError,
  assertAllowedValuesBudget,
  compileJsonZodSchema,
  validateCell,
  validateQuery,
  type FieldDefinition,
} from "./index";

const source =
  'z.object({ name: z.string().min(1), tags: z.array(z.string()).max(2).optional(), status: z.enum(["active", "archived"]), count: z.number().int().min(0).nullable() })';
const field: FieldDefinition = {
  id: "00000000000000000000000001",
  name: "DATA",
  type: "json",
  zodSchema: source,
};
const value = {
  name: "Rootset",
  status: "active",
  count: 0,
  extra: { keep: true },
};

test("JSON field Zod constraints validate original values, nested paths, defaults and null cells", () => {
  assert.equal(
    FieldInputSchema.safeParse({
      name: "DATA",
      type: "json",
      zodSchema: source,
      default: value,
    }).success,
    true,
  );
  assert.deepEqual(validateCell(field, value), value);
  assert.deepEqual(validateCell(field, { ...value, count: null, tags: [] }), {
    ...value,
    count: null,
    tags: [],
  });
  for (const invalid of [
    { ...value, name: "" },
    { ...value, status: "new" },
    { ...value, count: 1.5 },
    { ...value, tags: ["a", 1] },
    { ...value, tags: ["a", "b", "c"] },
    {},
  ])
    assert.throws(() => validateCell(field, invalid), {
      code: "VALIDATION_FAILED",
    });
  assert.throws(
    () => validateCell(field, { ...value, tags: [1] }),
    (error: unknown) => {
      assert.ok(error instanceof RootsetError);
      assert.equal(error.message.includes("tags.0"), true);
      assert.equal(JSON.stringify(error.details).includes('"fieldId"'), true);
      return true;
    },
  );
  assert.equal(validateCell(field, null), null);
  assert.throws(() => validateCell({ ...field, required: true }, null));
  assert.equal(
    FieldDefinitionSchema.safeParse({ ...field, default: {} }).success,
    false,
  );
  assert.deepEqual(validateCell({ ...field, zodSchema: null }, {}), {});
  assert.equal(FieldChangesSchema.safeParse({ zodSchema: null }).success, true);
  assert.equal(
    FieldInputSchema.safeParse({
      name: "TEXT",
      type: "text",
      zodSchema: source,
    }).success,
    false,
  );
});

test("supported Zod expressions keep JSON typing, object modes and Unicode lengths", () => {
  for (const [schema, valid, invalid] of [
    [
      "z.strictObject({ name: z.string() })",
      { name: "a" },
      { name: "a", extra: 1 },
    ],
    ["z.object({ name: z.string() }).strict()", { name: "a" }, {}],
    ["z.record(z.string(), z.boolean())", { a: true, b: false }, { a: 0 }],
    ["z.union([z.string(), z.number().min(2)])", 2, 1],
    ["z.literal(false).or(z.literal(null))", false, "false"],
    ["z.enum(['one',])", "one", "two"],
    ["z.string().length(1)", "😀", "ab"],
    ["z.int().nonnegative().max(5)", 0, "0"],
    ["z.array(z.string()).length(1)", ["a"], []],
    [
      "z.object({ optional: z.number().nullish() }); // comment",
      {},
      { optional: "1" },
    ],
  ] as const) {
    assert.equal(
      compileJsonZodSchema(schema).schema.safeParse(valid).success,
      true,
      schema,
    );
    assert.equal(
      compileJsonZodSchema(schema).schema.safeParse(invalid).success,
      false,
      schema,
    );
  }
  const keys = JSON.parse(
    '{"__proto__":{"keep":true},"constructor":1,"prototype":false}',
  );
  assert.deepEqual(
    validateCell({ ...field, zodSchema: "z.object({})" }, keys),
    keys,
  );
});

test("schemas reject executable syntax, unsupported Zod features and excessive work before validation", () => {
  for (const schema of [
    "",
    " ",
    "process.exit()",
    "z.constructor('return process')()",
    "z['string']()",
    "z.string; globalThis.pwned = true",
    "(() => z.string())()",
    "z.string().refine(() => true)",
    "z.string().transform(String)",
    "z.coerce.number()",
    "z.lazy(() => z.string())",
    "z.string().default('x')",
    "z.string().regex(/a+/)",
    "z.string().email()",
    "z.object({ get name() { return z.string() } })",
    "z.object({ ...anything })",
    "z.object({ name: z.string(), name: z.number() })",
    "z.number().min(10).max(0)",
    "z.string().length(-1)",
    "z.string().min(1.5)",
    "z.number().length(3)",
    "z.string().gte(1)",
    "z.enum([])",
    "z.union([z.string()])",
    "z.record(z.string().min(1), z.string())",
    "z.literal('\\u0000')",
    "z.literal('\\ud800')",
    "z.string()" + ".optional()".repeat(33),
    "z.string()" + " ".repeat(16384),
  ])
    assert.throws(
      () => compileJsonZodSchema(schema),
      { code: "VALIDATION_FAILED" },
      schema,
    );
  assert.equal(compileJsonZodSchema(source), compileJsonZodSchema(source));
});

test(
  "schema comments handle every line ending and long unterminated blocks",
  { timeout: 2000 },
  () => {
    for (const ending of ["\n", "\r", "\r\n", "\u2028", "\u2029"])
      assert.equal(
        compileJsonZodSchema(
          `// schema${ending}z.string() // trailing`,
        ).schema.safeParse("ok").success,
        true,
      );
    const repeated = " /*".repeat(5000);
    const commented = compileJsonZodSchema(
      `/*${repeated}*/ z.string() /* trailing */`,
    );
    assert.equal(commented.schema.safeParse("ok").success, true);
    assert.equal(commented.schema.safeParse(1).success, false);
    for (const source of [
      `/*${repeated}`,
      `z.string() /*${repeated}`,
      "z.object({ /* unfinished",
    ])
      assert.throws(() => compileJsonZodSchema(source), {
        code: "VALIDATION_FAILED",
        message: /Unclosed block comment/,
      });
    assert.equal(
      compileJsonZodSchema(
        "z.object(/* shape */ { name: /* value */ z.string() })",
      ).schema.safeParse({ name: "Rootset" }).success,
      true,
    );
  },
);

test("schema constraints share the bounded table metadata budget and do not constrain query operands", () => {
  const wide = `${" ".repeat(16000)}z.string()`;
  assert.throws(
    () =>
      assertAllowedValuesBudget(
        Array.from({ length: 40 }, (_, index) => ({
          ...field,
          name: `FIELD_${index}`,
          zodSchema: wide,
        })),
      ),
    /512 KiB/,
  );
  assert.doesNotThrow(() =>
    validateQuery(
      {
        where: {
          field: "DATA",
          op: "jsonContains",
          value: { status: "active" },
        },
      },
      [field],
    ),
  );
});
