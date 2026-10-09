import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fieldDraft, parseFieldDraft } from "./field-draft";
import { FieldForm } from "./schema";

const text = { ...fieldDraft(), name: "AIRLINE_CODE" };

describe("field definition form", () => {
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
