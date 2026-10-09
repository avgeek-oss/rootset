import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { type FieldDefinition } from "@rootset/contracts";
import { CellEditor } from "./CellEditor";

const definition: FieldDefinition = {
  id: "01J00000000000000000000000",
  name: "VALUE",
  type: "text",
};

describe("cell editor save boundaries", () => {
  it("requires review even when the conflicting committed value is empty text", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: definition,
        value: "draft",
        onCommit: () => true,
        onCancel() {},
        conflict: "",
      }),
    );
    expect(html).toContain("The row changed before this value was saved.");
    expect(html).toContain("(empty text)");
    expect(html).toContain("draft");
  });

  it("retains an initial keyboard draft separately from a populated server value", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: definition,
        value: "server value",
        initialInput: "k",
        onCommit: () => true,
        onCancel() {},
      }),
    );
    expect(html).toMatch(/<textarea\b[^>]*>k<\/textarea>/);
    expect(html).not.toContain("server value");
  });

  it("disables the input and announces a pending save without adding controls", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: definition,
        value: "draft",
        onCommit: () => true,
        onCancel() {},
        pending: true,
      }),
    );
    expect(html).not.toContain("<button");
    expect(html).toMatch(/<textarea\b[^>]*disabled/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Saving this value");
  });

  it("keeps a boundary UTC instant editable in the preferred timezone", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: { ...definition, type: "date-time" },
        value: "0001-01-01T00:00:00.000Z",
        timeZone: "America/New_York",
        onCommit: () => true,
        onCancel() {},
      }),
    );
    expect(html).toMatch(
      /<input\b[^>]*type="text"[^>]*value="0000-12-31T19:03:58.000"/,
    );
    expect(html).toContain("local year 0000 represents 0001 BCE");
  });
});
