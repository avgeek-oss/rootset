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
  it("does not reserve space for inline errors or conflict controls", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: definition,
        value: "saved",
        onCommit: () => false,
        onCancel() {},
      }),
    );
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("inline-cell-error");
    expect(html).not.toContain("Your draft is kept");
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

  it.each([
    ["time", "12:34:56.789Z", "time", "12:34"],
    [
      "date-time",
      "2026-10-09T12:34:56.789Z",
      "datetime-local",
      "2026-10-09T12:34",
    ],
  ] as const)(
    "limits %s controls to minutes",
    (type, value, inputType, displayed) => {
      const html = renderToStaticMarkup(
        createElement(CellEditor, {
          field: { ...definition, type },
          value,
          onCommit: () => true,
          onCancel() {},
        }),
      );
      expect(html).toContain(`type="${inputType}"`);
      expect(html).toContain('step="60"');
      expect(html).toContain(`value="${displayed}"`);
    },
  );

  it("expands JSON in the cell and exposes format, save and cancel actions", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: { ...definition, type: "json" },
        value: { sample: true, count: 2 },
        onCommit: () => true,
        onCancel() {},
      }),
    );
    expect(html).toContain("inline-cell-form--json");
    expect(html).toContain('rows="8"');
    expect(html).toContain("Format");
    expect(html).toContain("Cancel");
    expect(html).toContain("Save");
    expect(html).toContain("Enter adds a line");
    expect(html).toContain("\n  &quot;sample&quot;: true");
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
      /<input\b[^>]*type="text"[^>]*value="0000-12-31T19:03"/,
    );
    expect(html).toContain("local year 0000 represents 0001 BCE");
  });
});

describe("constrained text editor", () => {
  const choices = {
    ...definition,
    allowedValues: ["active", "ceased", "NULL"],
  };
  function render(required: boolean, value: string | null) {
    return renderToStaticMarkup(
      createElement(CellEditor, {
        field: { ...choices, required },
        value,
        initialInput: "x",
        onCommit: () => true,
        onCancel() {},
      }),
    );
  }
  it("uses a labelled native dropdown and encodes choices separately from null", () => {
    const html = render(false, null);
    expect(html).toMatch(/<select[^>]+aria-label="VALUE"/);
    expect(html).toContain('<option value="null" selected="">NULL</option>');
    expect(html).toContain(
      '<option value="choice:2">&quot;NULL&quot;</option>',
    );
    expect(html).not.toContain("textarea");
    expect(html).toContain("Tab saves and moves");
  });
  it("omits null for required fields and preserves the committed selection", () => {
    const html = render(true, "ceased");
    expect(html).not.toContain('value="null"');
    expect(html).toContain(
      '<option value="choice:1" selected="">ceased</option>',
    );
  });
});
