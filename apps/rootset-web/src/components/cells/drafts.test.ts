import { describe, expect, it } from "vitest";
import { type FieldDefinition, type JsonValue } from "@rootset/contracts";
import {
  createCellDraft,
  formatCellValue,
  jsonCellPreview,
  parseCellDraft,
  validateCellDraft,
} from "./drafts";

const field = (
  type: FieldDefinition["type"],
  configuration: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id: "01J00000000000000000000000",
  apiKey: "VALUE",
  label: "Value",
  type,
  ...configuration,
});
const draft = (text: string, isNull = false) => ({ text, isNull });

describe("typed editor validation parity", () => {
  it("distinguishes null, empty text, zero and false", () => {
    expect(parseCellDraft(field("text"), draft(""))).toBe("");
    expect(parseCellDraft(field("text"), draft("", true))).toBeNull();
    expect(parseCellDraft(field("integer"), draft("0"))).toBe(0);
    expect(parseCellDraft(field("boolean"), draft("false"))).toBe(false);
    expect(
      validateCellDraft(field("text", { required: true }), draft("", true)),
    ).toMatch(/required/);
  });

  it("counts Unicode scalar values and keeps whitespace", () => {
    expect(parseCellDraft(field("text", { charLimit: 3 }), draft(" 😀 "))).toBe(
      " 😀 ",
    );
    expect(() =>
      parseCellDraft(field("text", { charLimit: 2 }), draft(" 😀 ")),
    ).toThrow(/character limit/);
    expect(() => parseCellDraft(field("text"), draft("\u0000"))).toThrow(
      /Unicode/,
    );
    expect(() => parseCellDraft(field("text"), draft("\ud800"))).toThrow(
      /Unicode/,
    );
    expect(parseCellDraft(field("text"), draft("line one\nline two"))).toBe(
      "line one\nline two",
    );
  });

  it("accepts safe integers and inclusive bounds", () => {
    expect(parseCellDraft(field("integer"), draft("-9007199254740991"))).toBe(
      Number.MIN_SAFE_INTEGER,
    );
    expect(parseCellDraft(field("integer"), draft("9007199254740991"))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(
      parseCellDraft(field("integer", { min: -1, max: 1 }), draft("-1")),
    ).toBe(-1);
    expect(
      parseCellDraft(field("integer", { min: -1, max: 1 }), draft("1")),
    ).toBe(1);
    expect(() =>
      parseCellDraft(field("integer", { max: 1 }), draft("2")),
    ).toThrow(/maximum/);
    for (const value of [
      "9007199254740992",
      "1.5",
      "0x10",
      "",
      "NaN",
      "Infinity",
      "true",
    ]) {
      expect(() => parseCellDraft(field("integer"), draft(value))).toThrow();
    }
  });

  it("allows finite decimal and exponent floats while rejecting coercions", () => {
    expect(parseCellDraft(field("float"), draft(".125"))).toBe(0.125);
    expect(parseCellDraft(field("float"), draft("1.2e-3"))).toBe(0.0012);
    expect(
      parseCellDraft(field("float", { min: -1.25, max: 1.25 }), draft("1.25")),
    ).toBe(1.25);
    for (const value of [
      "NaN",
      "Infinity",
      "1e999",
      "0x10",
      "",
      "true",
      "--1",
    ]) {
      expect(() => parseCellDraft(field("float"), draft(value))).toThrow();
    }
  });

  it("does not coerce boolean strings beyond explicit editor choices", () => {
    expect(parseCellDraft(field("boolean"), draft("true"))).toBe(true);
    expect(parseCellDraft(field("boolean"), draft("false"))).toBe(false);
    expect(() => parseCellDraft(field("boolean"), draft("1"))).toThrow();
  });

  it("validates date-only calendar bounds without conversion", () => {
    expect(
      parseCellDraft(
        field("date", { min: "2024-02-29", max: "2024-02-29" }),
        draft("2024-02-29"),
        "America/New_York",
      ),
    ).toBe("2024-02-29");
    expect(() => parseCellDraft(field("date"), draft("2023-02-29"))).toThrow();
    expect(() =>
      parseCellDraft(field("date", { min: "2024-01-01" }), draft("2023-12-31")),
    ).toThrow(/minimum/);
  });

  it("validates date-time bounds after conversion to UTC", () => {
    const definition = field("date-time", {
      min: "2026-10-02T12:30:00.000Z",
      max: "2026-10-02T12:30:00.000Z",
    });
    expect(
      parseCellDraft(definition, draft("2026-10-02T18:00"), "Asia/Kolkata"),
    ).toBe("2026-10-02T12:30:00.000Z");
    expect(() =>
      parseCellDraft(definition, draft("2026-10-02T17:59"), "Asia/Kolkata"),
    ).toThrow(/minimum/);
  });

  it("uses the shared strict JSON decoder and canonicalisation", () => {
    expect(
      parseCellDraft(field("json"), draft('{"b":null,"a":[true,0,"x"]}')),
    ).toEqual({ a: [true, 0, "x"], b: null });
    expect(parseCellDraft(field("json"), draft("null"))).toBeNull();
    expect(parseCellDraft(field("json"), draft("false"))).toBe(false);
    expect(parseCellDraft(field("json"), draft('""'))).toBe("");
    for (const value of [
      '{"a":1,"a":2}',
      "{",
      "NaN",
      "1e999",
      "9007199254740993",
      '"\\u0000"',
      '"\\ud800"',
    ]) {
      expect(() => parseCellDraft(field("json"), draft(value))).toThrow();
    }
    expect(() =>
      parseCellDraft(
        field("json"),
        draft(`${"[".repeat(33)}0${"]".repeat(33)}`),
      ),
    ).toThrow();
    expect(() =>
      parseCellDraft(field("json", { required: true }), draft("null")),
    ).toThrow(/required/);
  });
});

describe("draft initialisation and bounded display", () => {
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
    "keeps nullable %s cells null until explicitly populated",
    (type) => {
      expect(createCellDraft(field(type), null).isNull).toBe(true);
    },
  );

  it("retains the original explicit DST occurrence when opening an existing instant", () => {
    const definition = field("date-time");
    const original = "2026-11-01T06:30:00.000Z";
    const initial = createCellDraft(definition, original, "America/New_York");
    expect(initial.text).toBe("2026-11-01T01:30:00.000");
    expect(parseCellDraft(definition, initial, "America/New_York")).toBe(
      original,
    );
  });

  it("keeps UTC time labels and date-only display under every timezone", () => {
    expect(
      formatCellValue(field("time"), "12:00:00.000Z", "Asia/Kolkata"),
    ).toBe("12:00:00.000 UTC");
    expect(formatCellValue(field("date"), "2026-10-02", "Pacific/Apia")).toBe(
      "2026-10-02",
    );
    expect(formatCellValue(field("boolean"), false)).toBe("False");
    expect(formatCellValue(field("integer"), 0)).toBe("0");
    expect(formatCellValue(field("text"), null)).toBe("—");
  });

  it("applies date and clock presentation without shifting date/time-only values", () => {
    const preferences = {
      dateFormat: "DD/MM/YYYY",
      timeFormat: "12h",
    } as const;
    expect(
      formatCellValue(
        field("date"),
        "2026-10-02",
        "America/New_York",
        "en-GB",
        preferences,
      ),
    ).toBe("02/10/2026");
    expect(
      formatCellValue(
        field("time"),
        "18:30:01.250Z",
        "Asia/Kolkata",
        "en-US",
        preferences,
      ),
    ).toBe("06:30:01.250 PM UTC");
    expect(
      formatCellValue(
        field("date-time"),
        "2026-10-02T13:00:01.250Z",
        "Asia/Kolkata",
        "en-US",
        preferences,
      ),
    ).toBe("02/10/2026 06:30:01.250 PM");
    expect(
      formatCellValue(field("date-time"), "0001-01-01T00:00:00.000Z", {
        timeZone: "America/New_York",
        locale: "en-US",
        dateFormat: "YYYY-MM-DD",
        timeFormat: "24h",
      }),
    ).toBe("0001-12-31 BCE 19:03:58.000");
    expect(
      formatCellValue(field("date-time"), "2026-10-02T13:00:01.250Z", {
        timeZone: "Asia/Kolkata",
        locale: "en-US",
        ...preferences,
      }),
    ).toBe("02/10/2026 06:30:01.250 PM");
  });

  it("bounds large JSON previews and does not traverse hidden branches", () => {
    const value: Record<string, JsonValue> = {
      first: "x".repeat(60_000),
      second: [],
    };
    Object.defineProperty(value, "hidden", {
      enumerable: true,
      get() {
        throw new Error("Hidden branch should not be read");
      },
    });
    const preview = jsonCellPreview(value);
    expect(preview.length).toBeLessThanOrEqual(160);
    expect(preview).toContain("…");
    expect(
      jsonCellPreview(
        Array.from({ length: 10_000 }, () => true),
        50,
      ).length,
    ).toBeLessThanOrEqual(50);
  });
});
