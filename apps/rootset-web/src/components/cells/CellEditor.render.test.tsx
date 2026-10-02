import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { type FieldDefinition } from "@rootset/contracts";
import { CellEditor } from "./CellEditor";

const definition: FieldDefinition = {
  id: "01J00000000000000000000000",
  apiKey: "VALUE",
  label: "Value",
  type: "text",
};

describe("cell editor save boundaries", () => {
  it("requires review even when the conflicting committed value is empty text", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: definition,
        value: "draft",
        onCommit() {},
        onCancel() {},
        conflict: "",
      }),
    );
    const submitButton = html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0];
    expect(submitButton).toContain("disabled");
    expect(html).toContain("(empty text)");
    expect(html).toContain("draft");
  });

  it("retains an initial keyboard draft separately from a populated server value", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: definition,
        value: "server value",
        initialInput: "k",
        onCommit() {},
        onCancel() {},
      }),
    );
    expect(html).toMatch(/<textarea\b[^>]*>k<\/textarea>/);
    expect(html).not.toContain("server value");
  });

  it("disables duplicate submits and cancellation while a save is pending", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: definition,
        value: "draft",
        onCommit() {},
        onCancel() {},
        pending: true,
      }),
    );
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.includes("disabled"))).toBe(true);
    expect(html).toContain("Saving this value");
  });

  it("keeps a boundary UTC instant editable in the preferred timezone", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: { ...definition, type: "date-time" },
        value: "0001-01-01T00:00:00.000Z",
        timeZone: "America/New_York",
        onCommit() {},
        onCancel() {},
      }),
    );
    expect(html).toMatch(
      /<input\b[^>]*type="text"[^>]*value="0000-12-31T19:03:58.000"/,
    );
    expect(html).toContain("local year 0000 represents 0001 BCE");
  });
});
