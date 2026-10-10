import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fieldDraft, parseFieldDraft } from "./field-draft";
import { FieldForm } from "./schema";

const text = { ...fieldDraft(), name: "AIRLINE_CODE" };

describe("field definition form", () => {
  it("converts selected date-time bounds to midnight UTC without a local timezone shift", () => {
    const parsed = parseFieldDraft({
      ...text,
      type: "date-time",
      min: "2026-02-28",
      max: "2026-03-01",
    });
    expect(parsed.input).toMatchObject({
      min: "2026-02-28T00:00:00.000Z",
      max: "2026-03-01T00:00:00.000Z",
    });
    expect(
      parseFieldDraft({ ...text, type: "date-time", min: "0001-01-01" }).input
        ?.min,
    ).toBe("0001-01-01T00:00:00.000Z");
    expect(
      parseFieldDraft({ ...text, type: "date-time", min: "2026-02-30" }).errors
        ?.min,
    ).toBeTruthy();
    expect(
      parseFieldDraft({
        ...text,
        type: "date-time",
        min: "2026-03-02",
        max: "2026-03-01",
      }).errors?.max,
    ).toBeTruthy();
    expect(
      parseFieldDraft({ ...text, type: "date-time" }).input,
    ).not.toHaveProperty("min");
    expect(
      parseFieldDraft({ ...text, type: "date", min: "2026-03-01" }).input?.min,
    ).toBe("2026-03-01");
  });

  it("prefills date pickers while preserving untouched existing non-midnight bounds", () => {
    const field = {
      id: "01J00000000000000000000000",
      name: "INSTANT",
      type: "date-time" as const,
      min: "2026-03-01T12:30:00.000Z",
      max: "2026-03-31T23:45:00.000Z",
    };
    const parsed = parseFieldDraft(fieldDraft(field));
    expect(parsed.input).toMatchObject({ min: field.min, max: field.max });
    const html = renderToStaticMarkup(
      createElement(FieldForm, {
        field,
        busy: false,
        submit: async () => {},
      }),
    );
    expect(html).toMatch(/type="date"[^>]*value="2026-03-01"/);
    expect(html).toMatch(/type="date"[^>]*value="2026-03-31"/);
    expect(html).toContain("Selected dates use midnight UTC.");
    expect(html).not.toContain("UTC instant, for example");
  });

  it.each(["A", "_", "Airline_Code", "A".repeat(64)])(
    "accepts one name %s for display and API values",
    (name) => {
      const parsed = parseFieldDraft({ ...text, name });
      expect(parsed.input).toMatchObject({ name, type: "text" });
      expect(parsed.input).not.toHaveProperty("label");
      expect(parsed.input).not.toHaveProperty("apiKey");
      expect(parsed.input).not.toHaveProperty("id");
    },
  );
  it.each([
    "",
    "CODE_1",
    "Airline Code",
    "CODE.NAME",
    "é",
    "A".repeat(65),
    "id",
    "VERSION",
    "__proto__",
  ])("colocates invalid name %s", (name) => {
    expect(parseFieldDraft({ ...text, name }).errors?.name).toBeTruthy();
  });
  it("puts bound, character limit and invalid defaults on their own controls", () => {
    expect(
      parseFieldDraft({ ...text, charLimit: "0" }).errors?.charLimit,
    ).toBeTruthy();
    expect(
      parseFieldDraft({ ...text, type: "integer", min: "10", max: "5" }).errors
        ?.max,
    ).toBeTruthy();
    expect(
      parseFieldDraft({ ...text, type: "integer", min: "1.5" }).errors?.min,
    ).toBeTruthy();
    expect(
      parseFieldDraft({
        ...text,
        type: "integer",
        defaultMode: "value",
        defaultValue: "",
      }).errors?.defaultValue,
    ).toBeTruthy();
    expect(
      parseFieldDraft({
        ...text,
        type: "integer",
        defaultMode: "value",
        defaultValue: "1.5",
      }).errors?.defaultValue,
    ).toBeTruthy();
    expect(
      parseFieldDraft({
        ...text,
        type: "json",
        defaultMode: "value",
        defaultValue: "{",
      }).errors?.defaultValue,
    ).toBe("Enter a valid JSON value.");
    expect(
      parseFieldDraft({ ...text, required: true, defaultMode: "null" }).errors
        ?.defaultMode,
    ).toBeTruthy();
  });
  it("keeps false, zero and empty text as literal defaults and starts optional fields at null", () => {
    expect(
      parseFieldDraft({
        ...text,
        type: "boolean",
        defaultMode: "value",
        defaultBoolean: false,
      }).input?.default,
    ).toBe(false);
    expect(
      parseFieldDraft({
        ...text,
        type: "integer",
        defaultMode: "value",
        defaultValue: "0",
      }).input?.default,
    ).toBe(0);
    expect(
      parseFieldDraft({ ...text, defaultMode: "value", defaultValue: "" }).input
        ?.default,
    ).toBe("");
    expect(
      parseFieldDraft({
        ...text,
        type: "json",
        defaultMode: "value",
        defaultValue: "null",
      }).input?.default,
    ).toBeNull();
    expect(fieldDraft().defaultMode).toBe("null");
    expect(parseFieldDraft(text).input?.default).toBeNull();
  });
  it("requires a valid literal default when a required field is configured in the UI", () => {
    expect(
      fieldDraft({
        id: "01J00000000000000000000000",
        name: "COUNT",
        type: "integer",
        required: true,
      }).defaultMode,
    ).toBe("value");
    expect(
      parseFieldDraft({
        ...text,
        required: true,
        defaultMode: "value",
        defaultValue: "",
      }).errors?.defaultValue,
    ).toBeTruthy();
    expect(
      parseFieldDraft({
        ...text,
        required: true,
        type: "integer",
        defaultMode: "value",
        defaultValue: "0",
      }).input?.default,
    ).toBe(0);
    expect(
      parseFieldDraft({
        ...text,
        required: true,
        type: "boolean",
        defaultMode: "value",
        defaultBoolean: false,
      }).input?.default,
    ).toBe(false);
  });
  it("renders one editable associated name control and preserves constraints while pending", () => {
    const html = renderToStaticMarkup(
      createElement(FieldForm, {
        field: { id: "01J00000000000000000000000", name: "CODE", type: "text" },
        busy: true,
        submit: async () => {},
      }),
    );
    expect(html).toContain('pattern="[A-Za-z_]+"');
    expect(html).toContain('maxLength="64"');
    expect(html).toContain('value="CODE"');
    expect(html).not.toContain("readonly");
    expect(html).not.toContain(">API key<");
    expect(html).not.toContain(">Label<");
    expect(html).toContain("Maximum characters");
    expect(html).not.toContain("Nullable");
    expect(html).not.toContain("No explicit default");
    expect(html).toContain('noValidate=""');
    expect(html).toMatch(/<label[^>]+for=/);
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });
});
