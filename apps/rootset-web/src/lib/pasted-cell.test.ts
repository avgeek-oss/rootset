import { describe, expect, it } from "vitest";
import { type FieldDefinition } from "@rootset/contracts";
import { parsePastedCell } from "./pasted-cell";

const field: FieldDefinition = {
  id: "01M3YTS99KPQXTMVWRN1V91562",
  apiKey: "INTEGER",
  label: "Integer",
  type: "integer",
  order: 0,
};

describe("integer clipboard precision", () => {
  it.each([
    "9007199254740990.5",
    "1.00000000000000001",
    "-1.00000000000000001",
    "9007199254740992",
    "1.2e0",
    "1e-400",
  ])("refuses %s rather than rounding away its spelling", (value) => {
    expect(() => parsePastedCell(field, value)).toThrow("whole number");
  });
  it.each([
    ["9007199254740991", 9007199254740991],
    ["-9007199254740991", -9007199254740991],
    ["12.0", 12],
    ["1.2e1", 12],
    ["1e2", 100],
    ["-0", 0],
    ["0.000e-400", 0],
  ])("retains exact integral spelling %s", (value, expected) => {
    expect(parsePastedCell(field, value)).toBe(expected);
  });
  it("still enforces configured bounds and explicit empty/null semantics", () => {
    expect(() => parsePastedCell({ ...field, max: 11 }, "1.2e1")).toThrow();
    expect(parsePastedCell(field, "")).toBeNull();
    expect(() => parsePastedCell(field, "", true)).toThrow();
    expect(
      parsePastedCell({ ...field, type: "text", charLimit: 64 }, "", true),
    ).toBe("");
  });
});

describe("clipboard null stays distinct from empty text", () => {
  it.each([
    "text",
    "integer",
    "float",
    "boolean",
    "date",
    "time",
    "date-time",
    "json",
  ] as const)(
    "validates actual unquoted null for %s even when required",
    (type) => {
      expect(parsePastedCell({ ...field, type }, "", false)).toBeNull();
      expect(() =>
        parsePastedCell({ ...field, type, required: true }, "", false),
      ).toThrow();
    },
  );
  it("preserves quoted empty text in a required text field", () => {
    expect(
      parsePastedCell({ ...field, type: "text", required: true }, "", true),
    ).toBe("");
  });
});
