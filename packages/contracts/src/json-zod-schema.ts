import { z } from "zod";
import { limits, RootsetError, type JsonValue } from "./models";

export type JsonZodRule =
  | { kind: "string"; min?: number; max?: number }
  | { kind: "number"; integer?: boolean; min?: number; max?: number }
  | { kind: "boolean" | "null" }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "object"; properties: Record<string, JsonZodRule>; strict: boolean }
  | { kind: "array"; item: JsonZodRule; min?: number; max?: number }
  | { kind: "record"; value: JsonZodRule }
  | { kind: "union"; options: JsonZodRule[] }
  | { kind: "optional"; inner: JsonZodRule };

type Argument =
  | JsonZodRule
  | Argument[]
  | Record<string, JsonZodRule>
  | string
  | number
  | boolean
  | null;
const cache = new Map<string, { rule: JsonZodRule; schema: z.ZodType }>();

function invalid(message: string): never {
  throw new RootsetError(
    "VALIDATION_FAILED",
    `Invalid Zod schema: ${message}`,
    422,
  );
}

/** Parse a small expression grammar. User text is never executed as JavaScript. */
class Parser {
  private position = 0;
  private nodes = 0;
  constructor(private readonly source: string) {}

  private space() {
    while (this.position < this.source.length) {
      if (this.source[this.position]!.trim() === "") {
        this.position++;
        continue;
      }
      if (this.source.startsWith("//", this.position)) {
        this.position += 2;
        while (
          this.position < this.source.length &&
          !"\n\r\u2028\u2029".includes(this.source[this.position]!)
        )
          this.position++;
        continue;
      }
      if (this.source.startsWith("/*", this.position)) {
        const end = this.source.indexOf("*/", this.position + 2);
        if (end === -1)
          invalid(`Unclosed block comment at character ${this.position + 1}`);
        this.position = end + 2;
        continue;
      }
      return;
    }
  }
  private take(token: string): boolean {
    this.space();
    if (!this.source.startsWith(token, this.position)) return false;
    this.position += token.length;
    return true;
  }
  private expect(token: string) {
    if (!this.take(token))
      invalid(`Expected ${token} at character ${this.position + 1}`);
  }
  private name(): string {
    this.space();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.position));
    if (!match) invalid(`Expected a name at character ${this.position + 1}`);
    this.position += match[0].length;
    return match[0];
  }
  private string(): string {
    this.space();
    const quote = this.source[this.position++];
    let result = "";
    while (this.position < this.source.length) {
      const char = this.source[this.position++];
      if (char === quote) {
        if (/[\u0000\uD800-\uDFFF]/u.test(result))
          invalid("Strings must contain valid Unicode and no U+0000");
        return result;
      }
      if (char === "\n" || char === "\r")
        invalid("String literals cannot contain unescaped newlines");
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escape = this.source[this.position++];
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "\\": "\\",
        '"': '"',
        "'": "'",
        "/": "/",
      };
      if (escape && Object.hasOwn(escapes, escape)) result += escapes[escape];
      else if (escape === "u") {
        const hex = this.source.slice(this.position, this.position + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex))
          invalid("Expected four hexadecimal digits after \\u");
        result += String.fromCharCode(parseInt(hex, 16));
        this.position += 4;
      } else invalid("Unsupported string escape");
    }
    return invalid("Unclosed string literal");
  }
  private list(close: string, depth: number): Argument[] {
    const values: Argument[] = [];
    if (this.take(close)) return values;
    do {
      values.push(this.argument(depth + 1));
      if (values.length > 100) invalid("Lists support at most 100 entries");
      if (this.take(close)) return values;
      this.expect(",");
    } while (!this.take(close));
    return values;
  }
  private argument(depth: number): Argument {
    if (depth > 32 || ++this.nodes > 256)
      invalid("Schema exceeds 32 levels or 256 nodes");
    this.space();
    const char = this.source[this.position];
    if (char === '"' || char === "'") return this.string();
    if (this.take("[")) return this.list("]", depth);
    if (this.take("{")) {
      const entries: [string, JsonZodRule][] = [];
      if (this.take("}")) return Object.fromEntries(entries);
      do {
        this.space();
        const key =
          this.source[this.position] === '"' ||
          this.source[this.position] === "'"
            ? this.string()
            : this.name();
        if (entries.some(([name]) => name === key))
          invalid(`Duplicate property ${key}`);
        this.expect(":");
        entries.push([key, this.rule(this.argument(depth + 1))]);
        if (this.take("}")) return Object.fromEntries(entries);
        this.expect(",");
      } while (!this.take("}"));
      return Object.fromEntries(entries);
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.position),
    );
    if (number) {
      this.position += number[0].length;
      const value = Number(number[0]);
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      )
        invalid(
          "Numbers must be finite and integral numbers must be safe integers",
        );
      return value;
    }
    const name = this.name();
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null") return null;
    if (name !== "z") invalid("Use one Zod expression starting with z");
    this.expect(".");
    const factory = this.name();
    this.expect("(");
    let rule = this.factory(factory, this.list(")", depth));
    while (this.take(".")) {
      if (++this.nodes > 256) invalid("Schema exceeds 256 nodes");
      const method = this.name();
      this.expect("(");
      rule = this.method(rule, method, this.list(")", depth));
    }
    return rule;
  }
  private rule(value: Argument | undefined): JsonZodRule {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.kind !== "string"
    )
      invalid("Expected a Zod schema");
    // Only schema factories produce a string kind; shape values are schema nodes.
    return value as JsonZodRule;
  }
  private factory(name: string, args: Argument[]): JsonZodRule {
    const first = args[0];
    if (
      ["string", "number", "int", "boolean", "null"].includes(name) &&
      args.length === 0
    ) {
      if (name === "int") return { kind: "number", integer: true };
      return { kind: name as "string" | "number" | "boolean" | "null" };
    }
    if (
      name === "literal" &&
      args.length === 1 &&
      (first === null || ["string", "number", "boolean"].includes(typeof first))
    )
      return {
        kind: "literal",
        value: first as string | number | boolean | null,
      };
    if (
      name === "enum" &&
      args.length === 1 &&
      Array.isArray(first) &&
      first.length &&
      first.every((value) => typeof value === "string")
    )
      return {
        kind: "union",
        options: first.map((value) => ({
          kind: "literal",
          value: value as string,
        })),
      };
    if (name === "array" && args.length === 1)
      return { kind: "array", item: this.rule(first) };
    if (
      name === "union" &&
      args.length === 1 &&
      Array.isArray(first) &&
      first.length >= 2
    )
      return { kind: "union", options: first.map((value) => this.rule(value)) };
    if (
      ["object", "strictObject", "looseObject"].includes(name) &&
      args.length === 1 &&
      first &&
      typeof first === "object" &&
      !Array.isArray(first)
    ) {
      for (const value of Object.values(first)) this.rule(value);
      return {
        kind: "object",
        properties: first as Record<string, JsonZodRule>,
        strict: name === "strictObject",
      };
    }
    if (
      name === "record" &&
      args.length === 2 &&
      this.rule(first).kind === "string" &&
      Object.keys(this.rule(first)).length === 1
    )
      return { kind: "record", value: this.rule(args[1]) };
    return invalid(
      `Unsupported z.${name}() or arguments. Use supported JSON types and validators`,
    );
  }
  private method(
    rule: JsonZodRule,
    name: string,
    args: Argument[],
  ): JsonZodRule {
    if (!args.length) {
      if (name === "optional") return { kind: "optional", inner: rule };
      if (name === "nullable")
        return { kind: "union", options: [rule, { kind: "null" }] };
      if (name === "nullish")
        return {
          kind: "optional",
          inner: { kind: "union", options: [rule, { kind: "null" }] },
        };
      if (name === "array") return { kind: "array", item: rule };
      if (
        (name === "strict" || name === "passthrough" || name === "loose") &&
        rule.kind === "object"
      )
        return { ...rule, strict: name === "strict" };
      if (name === "int" && rule.kind === "number")
        return { ...rule, integer: true };
      if (name === "nonnegative" && rule.kind === "number")
        return { ...rule, min: Math.max(rule.min ?? -Infinity, 0) };
      if (name === "nonpositive" && rule.kind === "number")
        return { ...rule, max: Math.min(rule.max ?? Infinity, 0) };
    }
    if (name === "or" && args.length === 1)
      return { kind: "union", options: [rule, this.rule(args[0])] };
    if (
      ["min", "max", "gte", "lte", "length"].includes(name) &&
      args.length === 1 &&
      typeof args[0] === "number" &&
      (rule.kind === "string" ||
        rule.kind === "number" ||
        rule.kind === "array")
    ) {
      const bound = args[0];
      if (rule.kind !== "number" && (!Number.isSafeInteger(bound) || bound < 0))
        invalid("Lengths must be nonnegative safe integers");
      if (rule.kind !== "number" && ["gte", "lte"].includes(name))
        invalid("gte/lte require a number schema");
      if (rule.kind === "number" && name === "length")
        invalid("length requires a string or array schema");
      const next = { ...rule };
      if (["min", "gte", "length"].includes(name))
        next.min = Math.max(next.min ?? -Infinity, bound);
      if (["max", "lte", "length"].includes(name))
        next.max = Math.min(next.max ?? Infinity, bound);
      if (
        next.min !== undefined &&
        next.max !== undefined &&
        next.min > next.max
      )
        invalid("Maximum must be at least minimum");
      return next;
    }
    return invalid(
      `Unsupported .${name}() for ${rule.kind}. Transforms, coercion and custom functions are unavailable`,
    );
  }
  parse(): JsonZodRule {
    const rule = this.rule(this.argument(0));
    this.take(";");
    this.space();
    if (this.position !== this.source.length)
      invalid(`Unexpected input at character ${this.position + 1}`);
    return rule;
  }
}

function toZod(rule: JsonZodRule): z.ZodType {
  switch (rule.kind) {
    case "string": {
      let schema = z.string();
      if (rule.min !== undefined) schema = schema.min(rule.min);
      if (rule.max !== undefined) schema = schema.max(rule.max);
      return schema;
    }
    case "number": {
      let schema = rule.integer ? z.number().int() : z.number();
      if (rule.min !== undefined) schema = schema.min(rule.min);
      if (rule.max !== undefined) schema = schema.max(rule.max);
      return schema;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "literal":
      return z.literal(rule.value);
    case "array": {
      let schema = z.array(toZod(rule.item));
      if (rule.min !== undefined) schema = schema.min(rule.min);
      if (rule.max !== undefined) schema = schema.max(rule.max);
      return schema;
    }
    case "object": {
      const shape = Object.fromEntries(
        Object.entries(rule.properties).map(([key, child]) => [
          key,
          toZod(child),
        ]),
      );
      return rule.strict ? z.strictObject(shape) : z.looseObject(shape);
    }
    case "record":
      return z.record(z.string(), toZod(rule.value));
    case "union":
      return z.union(rule.options.map(toZod));
    case "optional":
      return toZod(rule.inner).optional();
  }
}

export function compileJsonZodSchema(source: string): {
  rule: JsonZodRule;
  schema: z.ZodType;
} {
  if (/[\u0000\uD800-\uDFFF]/u.test(source))
    invalid("Use valid Unicode and no U+0000");
  if (
    !source.trim() ||
    new TextEncoder().encode(source).length > limits.jsonZodSchemaBytes
  )
    invalid("Enter a schema of at most 16,384 UTF-8 bytes");
  const cached = cache.get(source);
  if (cached) return cached;
  const rule = new Parser(source).parse();
  const pending = [{ rule, depth: 1 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 32) invalid("Schema exceeds 32 nesting levels");
    if (
      "min" in current.rule &&
      "max" in current.rule &&
      current.rule.min !== undefined &&
      current.rule.max !== undefined &&
      current.rule.min > current.rule.max
    )
      invalid("Maximum must be at least minimum");
    const children =
      current.rule.kind === "object"
        ? Object.values(current.rule.properties)
        : current.rule.kind === "union"
          ? current.rule.options
          : current.rule.kind === "optional"
            ? [current.rule.inner]
            : current.rule.kind === "array"
              ? [current.rule.item]
              : current.rule.kind === "record"
                ? [current.rule.value]
                : [];
    for (const child of children)
      pending.push({ rule: child, depth: current.depth + 1 });
  }
  const compiled = { rule, schema: toZod(rule) };
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(source, compiled);
  return compiled;
}

export const JsonZodSchemaSource = z
  .string()
  .max(16_384)
  .superRefine((source, context) => {
    try {
      compileJsonZodSchema(source);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid Zod schema",
      });
    }
  })
  .meta({
    "x-rootset-max-utf8-bytes": limits.jsonZodSchemaBytes,
    description:
      "Optional validation-only Zod expression for JSON fields. Supports JSON types, object/strictObject, array, record, union, enum, literal, optional/nullable members, and min/max/length/int bounds. No executable JavaScript, transforms or coercion. At most 16,384 UTF-8 bytes, 256 nodes and 32 nesting levels. null removes the constraint.",
  });

export function validateJsonZodSchema(
  source: string,
  value: JsonValue,
  field: { id: string; name: string },
): void {
  const result = compileJsonZodSchema(source).schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    }));
    const first = issues[0]!;
    throw new RootsetError(
      "VALIDATION_FAILED",
      `Field ${field.name}${first.path.length ? ` at ${first.path.join(".")}` : ""}: ${first.message}`,
      422,
      { fieldId: field.id, field: field.name, issues },
    );
  }
}
