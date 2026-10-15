import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentMarkdown } from "./comment-markdown";

const render = (children: string) =>
  renderToStaticMarkup(createElement(CommentMarkdown, { children }));

describe("comment Markdown", () => {
  it("formats research notes with lists, emphasis, inline code, and source links", () => {
    const html = render(
      "- **Identity:** Example aircraft\n- *Specifications:* [Reference](https://example.com/specifications)\n- Unknown values remain `NULL`.",
    );
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("<strong>Identity:</strong>");
    expect(html).toContain("<em>Specifications:</em>");
    expect(html).toContain("<code>NULL</code>");
    expect(html).toContain(
      'href="https://example.com/specifications" target="_blank" rel="noopener noreferrer">Reference</a>',
    );
  });

  it("keeps plain comment line breaks and renders GitHub-style tables and task lists", () => {
    const html = render(
      "First line\nSecond line\n\n> Review needed\n\n- [x] Checked\n- [ ] Pending\n\n| Field | Value |\n| --- | --- |\n| Status | ~~Draft~~ |\n\n```sql\nSELECT '<example>';\n```",
    );
    expect(html).toContain("First line<br/>\nSecond line");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain(
      'role="region" aria-label="Comment table" tabindex="0"><table>',
    );
    expect(html).toContain("<th>Field</th>");
    expect(html).toContain("<del>Draft</del>");
    expect(html).toContain('class="language-sql"');
    expect(html).toContain("&lt;example&gt;");
  });

  it("ignores raw HTML and blocks executable link and image URLs", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[Unsafe](javascript:alert%281%29)\n\n![Unsafe image](javascript:alert%281%29)\n\n[Data URL](data:text/html,example)',
    );
    for (const unsafe of [
      "<script",
      "onerror",
      "javascript:",
      "data:text/html",
    ])
      expect(html).not.toContain(unsafe);
    expect(html).toContain("Unsafe</a>");
  });

  it("renders image attachments lazily without sending the comment page as a referrer", () => {
    const html = render(
      "![Aircraft drawing](https://example.com/aircraft.png)",
    );
    expect(html).toContain('src="https://example.com/aircraft.png"');
    expect(html).toContain('alt="Aircraft drawing"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });
});
