import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageCell } from "./ImageCell";
import { CellEditor } from "./CellEditor";

describe("image cells", () => {
  it("renders the stored URL as a lazy thumbnail without an image proxy", () => {
    const html = renderToStaticMarkup(
      createElement(ImageCell, {
        src: "https://example.org/photo.png",
        name: "PHOTO",
      }),
    );
    expect(html).toContain('src="https://example.org/photo.png"');
    expect(html).toContain('alt="PHOTO image"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain("/_next/image");
  });

  it("does not request an image for an empty string", () => {
    const html = renderToStaticMarkup(
      createElement(ImageCell, { src: "", name: "PHOTO" }),
    );
    expect(html).toContain("—");
    expect(html).not.toContain("<img");
  });

  it("edits the complete stored value as plain text", () => {
    const html = renderToStaticMarkup(
      createElement(CellEditor, {
        field: {
          id: "01J00000000000000000000000",
          name: "PHOTO",
          type: "image",
        },
        value: "not an image URL",
        onCommit: () => true,
        onCancel() {},
      }),
    );
    expect(html).toMatch(/<textarea\b[^>]*>not an image URL<\/textarea>/);
    expect(html).not.toContain('type="url"');
  });
});
