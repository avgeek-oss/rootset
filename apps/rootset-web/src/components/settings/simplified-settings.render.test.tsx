import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrganisationSettings } from "./accounts";
import type { SettingsPanelProps } from "./types";

const props: SettingsPanelProps = {
  orgId: "01J00000000000000000000000",
  section: "organisation",
  onClose() {},
};
vi.mock("./api", () => ({
  organisationPath: (id: string) => `/orgs/${id}`,
  useResource: () => ({
    data: { name: "Example team" },
    error: null,
    reload() {},
  }),
  write: vi.fn(),
}));

describe("simplified account settings", () => {
  it("offers just the organisation name with an associated input", () => {
    const html = renderToStaticMarkup(
      createElement(OrganisationSettings, props),
    );
    expect(html).toContain("Team name");
    expect(html).toContain('maxLength="255"');
    expect(html).toMatch(/<label[^>]+for=/);
    expect([...html.matchAll(/<input\b/g)]).toHaveLength(1);
    for (const removed of [
      "Description",
      "quota",
      "Transfer ownership",
      "Delete organisation",
    ])
      expect(html).not.toContain(removed);
  });
});
