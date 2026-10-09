import type { FieldDefinition, JsonValue } from "@rootset/contracts";

export interface FieldCase {
  name: string;
  field?: "TEST" | "BOUNDED";
  value?: JsonValue;
  raw?: string;
  canonical?: JsonValue;
  reject?: boolean;
  parseError?: boolean;
}
export interface FieldCases {
  type: FieldDefinition["type"];
  baseline: JsonValue;
  canonical: JsonValue;
  default: JsonValue;
  defaultCanonical: JsonValue;
  requiredDefault: JsonValue;
  requiredDefaultCanonical: JsonValue;
  options?: { charLimit: number };
  bounded?: {
    min: number | string;
    max: number | string;
    default: JsonValue;
    canonical: JsonValue;
  };
  cases: FieldCase[];
}
const good = (
  name: string,
  value: JsonValue,
  canonical = value,
  field: FieldCase["field"] = "TEST",
): FieldCase => ({ name, value, canonical, field });
const bad = (
  name: string,
  value: JsonValue,
  field: FieldCase["field"] = "TEST",
): FieldCase => ({ name, value, reject: true, field });
const lexical = (name: string, raw: string, parseError = false): FieldCase => ({
  name,
  raw,
  reject: true,
  parseError,
});
function nested(depth: number): JsonValue {
  let value: JsonValue = null;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

export const fieldCases: FieldCases[] = [
  ...(["uri", "url", "image"] as const).map((type): FieldCases => ({
    type,
    baseline: "not an address",
    canonical: "not an address",
    default: "relative/path",
    defaultCanonical: "relative/path",
    requiredDefault: "custom:identifier",
    requiredDefaultCanonical: "custom:identifier",
    cases: [
      good("arbitrary-text", "still not an address"),
      good("relative-path", "../relative/path"),
      good("opaque-uri", "custom:opaque identifier"),
      good("empty-string", ""),
      good("no-text-character-limit", "x".repeat(5000)),
      bad("number-is-not-a-string", 42),
    ],
  })),
  {
    type: "text",
    baseline: "Root",
    canonical: "Root",
    default: "Seed",
    defaultCanonical: "Seed",
    requiredDefault: "Seed",
    requiredDefaultCanonical: "Seed",
    options: { charLimit: 4 },
    cases: [
      good("unicode-four-code-points", "🚀A😀B"),
      good("combining-marks-count-as-code-points", "e\u0301AB"),
      good("empty-string", ""),
      bad("five-code-points", "🚀A😀BC"),
      bad("number-is-not-text", 1),
      lexical("nul-rejected", '"bad\\u0000"', true),
      lexical("unpaired-surrogate-rejected", '"\\ud800"', true),
    ],
  },
  {
    type: "integer",
    baseline: 0,
    canonical: 0,
    default: 1,
    defaultCanonical: 1,
    requiredDefault: 2,
    requiredDefaultCanonical: 2,
    bounded: { min: -2, max: 2, default: 0, canonical: 0 },
    cases: [
      good("maximum-safe-integer", 9007199254740991),
      good("minimum-safe-integer", -9007199254740991),
      { name: "negative-zero-canonical", raw: "-0", canonical: 0 },
      good("inclusive-minimum", -2, -2, "BOUNDED"),
      good("inclusive-maximum", 2, 2, "BOUNDED"),
      bad("fraction-rejected", 1.1),
      bad("string-rejected", "1"),
      lexical("unsafe-integral-lexeme", "9007199254740993"),
      lexical("fraction-rounded-to-safe-integer", "9007199254740990.5"),
      bad("below-minimum", -3, "BOUNDED"),
      bad("above-maximum", 3, "BOUNDED"),
    ],
  },
  {
    type: "float",
    baseline: 0.5,
    canonical: 0.5,
    default: 1.25,
    defaultCanonical: 1.25,
    requiredDefault: -0.5,
    requiredDefaultCanonical: -0.5,
    bounded: { min: -1.5, max: 1.5, default: 0, canonical: 0 },
    cases: [
      good("finite-one-e23", 1e23),
      good("small-finite-number", 1e-100),
      { name: "negative-zero-canonical", raw: "-0", canonical: 0 },
      good("inclusive-minimum", -1.5, -1.5, "BOUNDED"),
      good("inclusive-maximum", 1.5, 1.5, "BOUNDED"),
      bad("string-rejected", "1.5"),
      bad("boolean-rejected", true),
      lexical("non-finite-overflow", "1e309", true),
      bad("below-minimum", -1.5001, "BOUNDED"),
      bad("above-maximum", 1.5001, "BOUNDED"),
    ],
  },
  {
    type: "boolean",
    baseline: false,
    canonical: false,
    default: true,
    defaultCanonical: true,
    requiredDefault: false,
    requiredDefaultCanonical: false,
    cases: [
      good("true", true),
      good("false", false),
      bad("zero-rejected", 0),
      bad("one-rejected", 1),
      bad("string-rejected", "true"),
      bad("array-rejected", []),
    ],
  },
  {
    type: "date",
    baseline: "2024-02-29",
    canonical: "2024-02-29",
    default: "2000-02-29",
    defaultCanonical: "2000-02-29",
    requiredDefault: "2024-01-01",
    requiredDefaultCanonical: "2024-01-01",
    bounded: {
      min: "2024-01-01",
      max: "2024-12-31",
      default: "2024-06-30",
      canonical: "2024-06-30",
    },
    cases: [
      good("gregorian-400-year-leap", "2000-02-29"),
      good("year-one", "0001-01-01"),
      good("year-9999", "9999-12-31"),
      good("inclusive-minimum", "2024-01-01", "2024-01-01", "BOUNDED"),
      good("inclusive-maximum", "2024-12-31", "2024-12-31", "BOUNDED"),
      bad("century-not-leap", "1900-02-29"),
      bad("ordinary-year-not-leap", "2023-02-29"),
      bad("invalid-month-day", "2024-04-31"),
      bad("year-zero", "0000-01-01"),
      bad("date-time-is-not-date", "2024-01-01T00:00:00Z"),
      bad("epoch-is-not-date", 0),
      bad("below-minimum", "2023-12-31", "BOUNDED"),
      bad("above-maximum", "2025-01-01", "BOUNDED"),
    ],
  },
  {
    type: "time",
    baseline: "12:00:00Z",
    canonical: "12:00:00.000Z",
    default: "00:00:00Z",
    defaultCanonical: "00:00:00.000Z",
    requiredDefault: "23:59:59.999Z",
    requiredDefaultCanonical: "23:59:59.999Z",
    cases: [
      good("start-of-day", "00:00:00Z", "00:00:00.000Z"),
      good("end-of-day", "23:59:59.999Z"),
      good("one-fraction-digit", "12:00:00.1Z", "12:00:00.100Z"),
      good("two-fraction-digits", "12:00:00.12Z", "12:00:00.120Z"),
      good("three-fraction-digits", "12:00:00.123Z"),
      bad("hour-24", "24:00:00Z"),
      bad("leap-second", "23:59:60Z"),
      bad("offset-even-zero", "12:00:00+00:00"),
      bad("missing-z", "12:00:00"),
      bad("four-fraction-digits", "12:00:00.1234Z"),
      bad("lowercase-z", "12:00:00z"),
    ],
  },
  {
    type: "date-time",
    baseline: "2024-02-29T12:00:00Z",
    canonical: "2024-02-29T12:00:00.000Z",
    default: "0001-01-01T00:00:00Z",
    defaultCanonical: "0001-01-01T00:00:00.000Z",
    requiredDefault: "2024-12-31T23:59:59.999Z",
    requiredDefaultCanonical: "2024-12-31T23:59:59.999Z",
    bounded: {
      min: "2024-02-29T00:00:00.100Z",
      max: "2024-02-29T00:00:00.200Z",
      default: "2024-02-29T00:00:00.150Z",
      canonical: "2024-02-29T00:00:00.150Z",
    },
    cases: [
      good(
        "gregorian-400-year-leap",
        "2000-02-29T00:00:00Z",
        "2000-02-29T00:00:00.000Z",
      ),
      good("year-one", "0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"),
      good("year-9999", "9999-12-31T23:59:59.999Z"),
      good(
        "one-fraction-digit",
        "2024-02-29T12:00:00.1Z",
        "2024-02-29T12:00:00.100Z",
      ),
      good(
        "two-fraction-digits",
        "2024-02-29T12:00:00.12Z",
        "2024-02-29T12:00:00.120Z",
      ),
      good("three-fraction-digits", "2024-02-29T12:00:00.123Z"),
      good(
        "inclusive-minimum",
        "2024-02-29T00:00:00.1Z",
        "2024-02-29T00:00:00.100Z",
        "BOUNDED",
      ),
      good(
        "inclusive-maximum",
        "2024-02-29T00:00:00.2Z",
        "2024-02-29T00:00:00.200Z",
        "BOUNDED",
      ),
      bad("century-not-leap", "1900-02-29T00:00:00Z"),
      bad("ordinary-year-not-leap", "2023-02-29T00:00:00Z"),
      bad("year-zero", "0000-01-01T00:00:00Z"),
      bad("space-instead-of-t", "2024-02-29 12:00:00Z"),
      bad("offset-even-zero", "2024-02-29T12:00:00+00:00"),
      bad("missing-z", "2024-02-29T12:00:00"),
      bad("leap-second", "2024-02-29T23:59:60Z"),
      bad("four-fraction-digits", "2024-02-29T12:00:00.1234Z"),
      bad("below-minimum", "2024-02-29T00:00:00.099Z", "BOUNDED"),
      bad("above-maximum", "2024-02-29T00:00:00.201Z", "BOUNDED"),
    ],
  },
  {
    type: "json",
    baseline: { a: 1, b: 2 },
    canonical: { a: 1, b: 2 },
    default: { a: [0, null] },
    defaultCanonical: { a: [0, null] },
    requiredDefault: ["seed"],
    requiredDefaultCanonical: ["seed"],
    cases: [
      good("object-key-order-is-canonical", { b: 2, a: 1 }, { a: 1, b: 2 }),
      good(
        "prototype-like-keys-are-own-json-data",
        JSON.parse(
          '{"__proto__":{"marker":"preserved"},"constructor":{"prototype":{"marker":"ordinary"}},"a":1}',
        ) as JsonValue,
      ),
      good("array-preserves-order", [2, 1, null]),
      good("boolean-scalar", false),
      good("string-scalar", "001"),
      good("maximum-safe-integer", { n: 9007199254740991 }),
      good("depth-32", nested(32)),
      bad("depth-33", nested(33)),
      lexical("nested-unsafe-integral-lexeme", '{"n":9007199254740993}'),
      lexical("nested-one-e23-not-safe-json-integer", '{"n":1e23}'),
      lexical("nested-nul-rejected", '{"s":"bad\\u0000"}', true),
    ],
  },
];
