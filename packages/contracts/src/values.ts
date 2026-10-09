import { z } from "zod";
import { canonicalize } from "json-canonicalize";
import type { NumberLexeme } from "./decoder";
import {
  FieldNameSchema,
  assertFieldNames,
  IdSchema,
  JsonValueSchema,
  RootsetError,
  limits,
  type FieldDefinition,
  type JsonValue,
} from "./models";

const encoder = new TextEncoder();
function invalid(message: string, details?: JsonValue): never {
  throw new RootsetError("VALIDATION_FAILED", message, 422, details);
}
export function validUnicode(value: string): boolean {
  if (value.includes("\u0000")) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function canonicalJson(
  value: unknown,
  options: { maxDepth?: number; safeIntegers?: boolean } = {},
): string {
  const active = new Set<object>();
  function visit(input: unknown, depth: number): void {
    if (input === null || typeof input === "boolean") return;
    if (typeof input === "string") {
      if (!validUnicode(input))
        invalid("JSON strings must contain valid Unicode and no U+0000");
      return;
    }
    if (typeof input === "number") {
      if (
        !Number.isFinite(input) ||
        (options.safeIntegers &&
          Number.isInteger(input) &&
          !Number.isSafeInteger(input))
      )
        invalid(
          "JSON numbers must be finite and integral values must be safe integers",
        );
      return;
    }
    if (typeof input !== "object") invalid("Expected a JSON value");
    if (depth >= (options.maxDepth ?? limits.jsonDepth))
      invalid(
        `JSON nesting exceeds ${options.maxDepth ?? limits.jsonDepth} levels`,
      );
    if (active.has(input)) invalid("JSON must not contain cycles");
    active.add(input);
    if (Array.isArray(input)) {
      if (
        Object.keys(input).length !== input.length ||
        Object.getOwnPropertySymbols(input).length > 0
      )
        invalid("JSON arrays must be dense and cannot have extra properties");
      for (let index = 0; index < input.length; index++)
        if (!Object.hasOwn(input, index))
          invalid("JSON arrays must contain every indexed member");
      for (const item of input) visit(item, depth + 1);
    } else {
      if (
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null
      )
        invalid("JSON objects must be plain records");
      if (Object.getOwnPropertySymbols(input).length)
        invalid("JSON objects cannot have symbol keys");
      const record = input as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!validUnicode(key))
          invalid("JSON keys must contain valid Unicode and no U+0000");
        visit(record[key], depth + 1);
      }
    }
    active.delete(input);
  }
  visit(value, 0);
  return canonicalize(value);
}
export function canonicalValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value, { safeIntegers: true })) as JsonValue;
}
export function encodedBytes(value: unknown): number {
  return encoder.encode(canonicalJson(value)).byteLength;
}

export function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1)
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  );
}
export const DateSchema = z
  .string()
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/)
  .refine(validDate, "Expected valid YYYY-MM-DD, years 0001-9999")
  .meta({ format: "date", examples: ["2024-01-01"] });
export function parseUtcTime(value: unknown): string {
  if (typeof value !== "string") invalid("Expected a UTC time string");
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[3]) > 59
  )
    invalid(
      "Expected UTC HH:mm:ss[.SSS]Z; offsets and leap seconds are unsupported",
    );
  return `${match[1]}:${match[2]}:${match[3]}.${(match[4] ?? "").padEnd(3, "0")}Z`;
}
export function parseUtcDateTime(value: unknown): string {
  if (typeof value !== "string") invalid("Expected a UTC date-time string");
  const match = /^(\d{4}-\d{2}-\d{2})T(.+)$/.exec(value);
  if (!match || !validDate(match[1]!))
    invalid("Expected a valid UTC YYYY-MM-DDTHH:mm:ss[.SSS]Z");
  return `${match[1]}T${parseUtcTime(match[2])}`;
}
export const TimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/)
  .meta({
    description:
      "UTC time-of-day with mandatory Z; canonical output has three fractional digits.",
    examples: ["12:30:00.000Z"],
  })
  .transform((value, context) => {
    try {
      return parseUtcTime(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid UTC time",
      });
      return z.NEVER;
    }
  });
export const DateTimeSchema = z
  .string()
  .regex(
    /^(?!0000)\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/,
  )
  .meta({
    format: "date-time",
    description:
      "UTC instant with mandatory Z and at most three fractional digits.",
    examples: ["2024-01-01T12:30:00.000Z"],
  })
  .transform((value, context) => {
    try {
      return parseUtcDateTime(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid UTC date-time",
      });
      return z.NEVER;
    }
  });

const common = {
  id: IdSchema,
  name: FieldNameSchema,
  required: z.boolean().optional(),
  default: JsonValueSchema.optional(),
  order: z.number().int().nonnegative().max(199).optional(),
};
const rawFields = z.discriminatedUnion("type", [
  z.strictObject({
    ...common,
    type: z.literal("text"),
    charLimit: z.number().int().positive().max(limits.rowBytes).optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("integer"),
    min: z.number().int().safe().optional(),
    max: z.number().int().safe().optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("float"),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.strictObject({ ...common, type: z.literal("uri") }),
  z.strictObject({ ...common, type: z.literal("url") }),
  z.strictObject({ ...common, type: z.literal("image") }),
  z.strictObject({ ...common, type: z.literal("boolean") }),
  z.strictObject({
    ...common,
    type: z.literal("date"),
    min: DateSchema.optional(),
    max: DateSchema.optional(),
  }),
  z.strictObject({ ...common, type: z.literal("time") }),
  z.strictObject({
    ...common,
    type: z.literal("date-time"),
    min: DateTimeSchema.optional(),
    max: DateTimeSchema.optional(),
  }),
  z.strictObject({ ...common, type: z.literal("json") }),
]);
export const FieldDefinitionSchema = rawFields.superRefine((field, context) => {
  if (
    "min" in field &&
    "max" in field &&
    field.min !== undefined &&
    field.max !== undefined &&
    field.min > field.max
  )
    context.addIssue({
      code: "custom",
      path: ["max"],
      message: "Maximum must be at least minimum",
    });
  if (Object.hasOwn(field, "default")) {
    try {
      validateCell(field, field.default);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: error instanceof Error ? error.message : "Invalid default",
      });
    }
  }
});
export const FieldInputSchema = z
  .union(
    rawFields.options.map((schema) =>
      (schema as z.ZodObject).omit({ id: true }),
    ),
  )
  .superRefine((field, context) => {
    const parsed = FieldDefinitionSchema.safeParse({
      ...(field as object),
      id: "00000000000000000000000000",
    });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
  });

export function validateCell(
  field: FieldDefinition,
  value: unknown,
): JsonValue {
  if (value === null) {
    if (field.required)
      invalid(`Field ${field.name} is required`, {
        fieldId: field.id,
        field: field.name,
      });
    return null;
  }
  let result: JsonValue;
  switch (field.type) {
    case "text":
      if (typeof value !== "string" || !validUnicode(value))
        invalid(`Field ${field.name} requires valid Unicode text`);
      if ([...value].length > (field.charLimit ?? limits.textCharLimit))
        invalid(`Field ${field.name} exceeds its character limit`);
      result = value;
      break;
    case "uri":
    case "url":
    case "image":
      if (typeof value !== "string" || !validUnicode(value))
        invalid(`Field ${field.name} requires valid Unicode text`);
      result = value;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        invalid(`Field ${field.name} requires a safe integer`);
      result = value === 0 ? 0 : value;
      break;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value))
        invalid(`Field ${field.name} requires a finite number`);
      result = value === 0 ? 0 : value;
      break;
    case "boolean":
      if (typeof value !== "boolean")
        invalid(`Field ${field.name} requires a boolean`);
      result = value;
      break;
    case "date":
      if (typeof value !== "string" || !validDate(value))
        invalid(`Field ${field.name} requires a valid calendar date`);
      result = value;
      break;
    case "time":
      result = parseUtcTime(value);
      break;
    case "date-time":
      result = parseUtcDateTime(value);
      break;
    case "json":
      return canonicalValue(value);
    default:
      return invalid("Unsupported field type");
  }
  if (
    (typeof result === "number" || typeof result === "string") &&
    (field.type === "integer" ||
      field.type === "float" ||
      field.type === "date" ||
      field.type === "date-time")
  ) {
    if (
      field.min !== undefined &&
      typeof field.min === typeof result &&
      result <
        (field.type === "date-time" ? parseUtcDateTime(field.min) : field.min)
    )
      invalid(`Field ${field.name} is below minimum`);
    if (
      field.max !== undefined &&
      typeof field.max === typeof result &&
      result >
        (field.type === "date-time" ? parseUtcDateTime(field.max) : field.max)
    )
      invalid(`Field ${field.name} is above maximum`);
  }
  return result;
}
export function validateValues(
  fields: readonly FieldDefinition[],
  input: unknown,
  mode: "create" | "patch" = "create",
): Record<string, JsonValue> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    invalid("Values must be a plain object");
  assertFieldNames(fields);
  const source = input as Record<string, unknown>;
  const lookup = new Map(
    fields.flatMap(
      (field) =>
        [
          [field.name, field],
          [field.id, field],
        ] as const,
    ),
  );
  const result: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [key, value] of Object.entries(source)) {
    const field =
      lookup.get(key) ??
      lookup.get(IdSchema.safeParse(key).success ? key.toUpperCase() : key);
    if (!field) invalid(`Unknown field ${key}`, { field: key });
    if (Object.hasOwn(result, field.name))
      invalid(`Field ${field.name} was supplied more than once`);
    try {
      result[field.name] = validateCell(field, value);
    } catch (error) {
      if (error instanceof RootsetError)
        throw new RootsetError(error.code, error.message, error.status, {
          fieldId: field.id,
          field: field.name,
        });
      throw error;
    }
  }
  if (mode === "create")
    for (const field of fields)
      if (!Object.hasOwn(result, field.name))
        result[field.name] = validateCell(
          field,
          Object.hasOwn(field, "default") ? field.default : null,
        );
  return result;
}
export function rowBytes(
  fields: readonly FieldDefinition[],
  values: Record<string, JsonValue>,
): number {
  const stable: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const field of fields)
    stable[field.id] = Object.hasOwn(values, field.name)
      ? values[field.name]!
      : Object.hasOwn(values, field.id)
        ? values[field.id]!
        : null;
  return encoder.encode(
    canonicalJson(stable, { maxDepth: limits.jsonDepth + 1 }),
  ).byteLength;
}
export function assertRowBytes(
  fields: readonly FieldDefinition[],
  values: Record<string, JsonValue>,
): number {
  const bytes = rowBytes(fields, values);
  if (bytes > limits.rowBytes)
    throw new RootsetError(
      "ROW_SIZE_LIMIT",
      `Canonical user values exceed ${limits.rowBytes} bytes`,
      422,
      { bytes, maximum: limits.rowBytes },
    );
  return bytes;
}
export function assertValueLexemes(
  fields: readonly FieldDefinition[],
  lexemes: readonly NumberLexeme[],
  valuesPath: readonly (string | number)[] = ["values"],
): void {
  const lookup = new Map(
    fields.flatMap(
      (field) =>
        [
          [field.id, field],
          [field.name, field],
        ] as const,
    ),
  );
  for (const information of lexemes) {
    if (
      information.path.length <= valuesPath.length ||
      !valuesPath.every(
        (segment, index) => String(segment) === String(information.path[index]),
      )
    )
      continue;
    const key = String(information.path[valuesPath.length]);
    const field =
      lookup.get(key) ??
      lookup.get(IdSchema.safeParse(key).success ? key.toUpperCase() : key);
    if (!field) continue;
    if (
      field.type === "integer" &&
      (!information.integer || !information.safeInteger)
    )
      invalid(`Field ${field.name} requires a lossless safe integer`, {
        fieldId: field.id,
        field: field.name,
      });
    if (
      field.type === "json" &&
      information.integer &&
      !information.safeInteger
    )
      invalid(`JSON field ${field.name} contains an unsafe integral number`, {
        fieldId: field.id,
        field: field.name,
      });
  }
}
export function assertFieldDefinitionLexemes(
  field: Pick<FieldDefinition, "type" | "name"> & { id?: string },
  lexemes: readonly NumberLexeme[],
  fieldPath: readonly (string | number)[],
): void {
  for (const information of lexemes) {
    if (
      information.path.length <= fieldPath.length ||
      !fieldPath.every(
        (segment, index) => String(segment) === String(information.path[index]),
      )
    )
      continue;
    const property = String(information.path[fieldPath.length]);
    if (
      field.type === "integer" &&
      ["default", "min", "max"].includes(property) &&
      (!information.integer || !information.safeInteger)
    )
      invalid(
        `Integer field ${field.name} requires lossless integral defaults and bounds`,
        { field: field.name, ...(field.id ? { fieldId: field.id } : {}) },
      );
    if (
      field.type === "json" &&
      property === "default" &&
      information.integer &&
      !information.safeInteger
    )
      invalid(
        `JSON field ${field.name} default contains an unsafe integral number`,
        { field: field.name, ...(field.id ? { fieldId: field.id } : {}) },
      );
  }
}
