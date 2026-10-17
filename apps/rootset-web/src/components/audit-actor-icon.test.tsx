import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuditActorIcon } from "./audit-actor-icon";

describe("audit actor presentation", () => {
  it.each(["operator", "system", "automation"])(
    "uses an icon without loading an avatar for %s activity",
    (kind) => {
      const html = renderToStaticMarkup(
        createElement(AuditActorIcon, {
          kind,
          name: "Rootset worker",
          avatarUrl: "https://www.gravatar.com/avatar/automation",
        }),
      );
      expect(html).toContain("<svg");
      expect(html).toContain('width="16"');
      expect(html).toContain('height="16"');
      expect(html).not.toContain("<img");
      expect(html).not.toContain("gravatar.com");
      expect(html).not.toContain("avatar__fallback");
    },
  );
  it("keeps the shared avatar for a user", () => {
    const html = renderToStaticMarkup(
      createElement(AuditActorIcon, {
        kind: "session",
        name: "Local fixture",
        avatarUrl: "https://www.gravatar.com/avatar/user",
      }),
    );
    expect(html).toContain("avatar__fallback");
    expect(html).toContain("LF");
  });
});
