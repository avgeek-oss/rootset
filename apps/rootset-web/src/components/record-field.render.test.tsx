import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "react-aria-components";
import { describe, expect, it } from "vitest";
import type { FieldDefinition, JsonValue } from "@rootset/contracts";
import { createRecordDraft } from "../lib/record-draft";
import { RecordField } from "./record-field";

const definition: FieldDefinition = {
  id: "01J00000000000000000000000",
  name: "VALUE",
  type: "text",
};
function render(field: FieldDefinition, readOnly = false) {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      locale: "en-GB",
      children: createElement(RecordField, {
        field,
        draft: createRecordDraft([field])[field.id]!,
        creating: true,
        timeZone: "UTC",
        hourCycle: 24,
        invalid: false,
        disabled: false,
        readOnly,
        onChange() {},
      }),
    }),
  );
}

describe("full-record field controls", () => {
  it.each([
    ["text", "text"],
    ["integer", 0],
    ["float", 0.5],
    ["boolean", false],
    ["date", "2026-10-17"],
    ["time", "12:30:00.000Z"],
    ["date-time", "2026-10-17T12:30:00.000Z"],
    ["json", { count: 0 }],
    ["uri", "urn:rootset:test"],
    ["url", "https://rootset.io"],
    ["image", "https://rootset.io/image.png"],
  ] as [FieldDefinition["type"], JsonValue][])(
    "renders the %s control with an associated label",
    (type, value) => {
      const html = render({
        ...definition,
        type,
        default: value,
        required: true,
      });
      const labelId = html.match(/<label\b[^>]*id="([^"]+)"/)?.[1];
      const labelFor = html.match(/<label\b[^>]*for="([^"]+)"/)?.[1];
      expect(labelId || labelFor).toBeTruthy();
      expect(html).toContain("VALUE");
      if (labelFor) expect(html).toContain(`id="${labelFor}"`);
      else expect(html).toMatch(new RegExp(`aria-labelledby="[^"]*${labelId}`));
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(
        (match) => match[1],
      );
      expect(new Set(ids).size).toEqual(ids.length);
      expect(html).not.toContain('role="alert"');
      expect(html).toContain("Default for new records");
    },
  );

  it("uses multiline controls for JSON and existing long text", () => {
    expect(render({ ...definition, type: "json" })).toMatch(
      /<textarea\b[^>]*rows="6"/,
    );
    expect(render({ ...definition, default: "x".repeat(81) })).toMatch(
      /<textarea\b[^>]*rows="3"/,
    );
    expect(render({ ...definition, default: "short" })).not.toContain(
      "<textarea",
    );
  });

  it("keeps automatic IDs distinct from a manually entered zero", () => {
    const html = render({
      ...definition,
      type: "integer",
      required: true,
      autoIncrement: true,
    });
    expect(html).toContain('placeholder="Auto-increment"');
    expect(html).toContain("Generated automatically");
    expect(html).toMatch(/<input\b[^>]*readOnly/);
  });

  it("does not expose mutation menus in read-only records or empty menus on required numbers", () => {
    expect(render(definition, true)).not.toContain("Options for VALUE");
    expect(
      render({ ...definition, type: "integer", required: true }),
    ).not.toContain("Options for VALUE");
    expect(render({ ...definition, type: "boolean" })).not.toContain(
      "Options for VALUE",
    );
  });

  it("offers an unselected prompt for required choices without a default", () => {
    const html = render({
      ...definition,
      required: true,
      allowedValues: ["Active", "Paused"],
    });
    expect(html).toContain("Choose a value");
    expect(html).not.toContain("choice:-1");
    expect(html).not.toContain('value="null"');
  });
});
