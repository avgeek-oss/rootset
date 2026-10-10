import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseDangerZone, DatabaseSettings } from "./database";
import type { SettingsPanelProps } from "./types";

const fixture = vi.hoisted(() => ({ loading: false }));
vi.mock("./api", () => ({
  databasePath: () => "/orgs/org/databases/database",
  useResource: () => ({
    data: fixture.loading
      ? null
      : { name: "Example database", state: "active" },
    loading: fixture.loading,
    reload() {},
  }),
  useMutation: () => ({ busy: false, run: vi.fn() }),
  confirmIdentity: vi.fn(),
  write: vi.fn(),
}));
const props: SettingsPanelProps = {
  orgId: "org",
  databaseId: "database",
  section: "database",
  onClose() {},
};
beforeEach(() => {
  fixture.loading = false;
});

describe("database settings pages", () => {
  it("keeps deletion out of General", () => {
    const html = renderToStaticMarkup(createElement(DatabaseSettings, props));
    expect(html).toContain("Database name");
    expect(html).toContain("Description");
    expect(html).not.toContain("Delete database");
  });
  it("gives deletion its own page with consequences and identity confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(DatabaseDangerZone, {
        ...props,
        section: "database-danger-zone",
      }),
    );
    expect(html).toContain("Delete database");
    expect(html).toContain("all its tables");
    expect(html).toContain("confirm your identity");
    expect(html).toContain("undo or restore");
    expect(html).not.toContain("<input");
  });
  it.each([DatabaseSettings, DatabaseDangerZone])(
    "leaves unloaded content empty without exposing a premature form or delete button",
    (component) => {
      fixture.loading = true;
      const html = renderToStaticMarkup(createElement(component, props));
      expect(html).toBe("");
    },
  );
});
