import { describe, expect, it } from "vitest";
import {
  dataHref,
  resourceRoute,
  settingsGroups,
  settingsHref,
  settingsScope,
  settingsNavigationGroups,
} from "./navigation";
import { SECTION_LABELS, resolveSettingsSection } from "./types";

describe("context settings navigation", () => {
  it("matches the account groups and resolves existing bookmarks", () => {
    expect(settingsGroups.account).toEqual([
      { title: "Account", sections: ["profile", "preferences"] },
      {
        title: "Security",
        sections: ["email-password", "passkeys", "sessions"],
      },
      { title: "API & MCP", sections: ["api-keys", "mcp-connections", "mcp"] },
    ]);
    expect(resolveSettingsSection("security")).toBe("passkeys");
    expect(resolveSettingsSection("keys")).toBe("api-keys");
    expect(resolveSettingsSection("connections")).toBe("mcp-connections");
    expect(resolveSettingsSection("missing")).toBeNull();
  });
  it("gives every section one settings context", () => {
    const sections = Object.values(settingsGroups).flatMap((groups) =>
      groups.flatMap((group) => group.sections),
    );
    expect(new Set(sections).size).toBe(sections.length);
    expect([...sections].sort()).toEqual(Object.keys(SECTION_LABELS).sort());
  });
  it.each([
    "profile",
    "organisation",
    "database",
    "database-danger-zone",
    "fields",
  ] as const)("isolates the context containing %s", (section) => {
    const scope = settingsScope(section);
    const items = settingsNavigationGroups(scope, "admin", {
      databaseId: "db",
      tableId: "table",
    }).flatMap((group) => group.items);
    expect(items.map((item) => item.id)).toEqual(
      settingsGroups[scope].flatMap((group) => group.sections),
    );
    if (scope === "account" || scope === "team")
      for (const item of items) expect(item.href).not.toContain("databaseId");
  });
  it("keeps exports available to viewers while hiding management", () => {
    expect(
      settingsNavigationGroups("table", "viewer").flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ).toEqual(["exports"]);
    expect(
      settingsNavigationGroups("table", "member").flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ).toEqual(["exports"]);
    expect(settingsNavigationGroups("account", "unknown")).toEqual([]);
  });
  it("includes only identifiers belonging to the settings scope", () => {
    const context = { databaseId: "db", tableId: "table" };
    expect(settingsHref("profile", context)).toBe("/settings/profile");
    expect(settingsHref("organisation", context)).toBe(
      "/team-settings/general",
    );
    expect(settingsHref("members", context)).toBe("/team-settings/members");
    expect(settingsHref("fields", context)).toBe(
      "/databases/db/tables/table/settings/fields",
    );
    expect(dataHref("db", "table")).toBe("/databases/db/tables/table");
  });
  it("round trips resource pages and separates destructive settings", () => {
    for (const section of [
      "database",
      "database-danger-zone",
      "table",
      "table-danger-zone",
      "fields",
      "exports",
    ] as const) {
      const route = resourceRoute(
        settingsHref(section, { databaseId: "db", tableId: "table" }),
      );
      expect(route.section).toBe(section);
      expect(route.databaseId).toBe("db");
      expect(route.tableId).toBe(
        section.startsWith("database") ? null : "table",
      );
    }
    expect(resourceRoute("/")).toEqual({
      databaseId: null,
      tableId: null,
      section: null,
    });
    expect(
      settingsNavigationGroups("table", "admin", {
        databaseId: "db",
        tableId: "table",
      })
        .flatMap((g) => g.items)
        .find((i) => i.id === "table-danger-zone")?.destructive,
    ).toBe(true);
  });
  it("keeps database settings separate from table and account settings", () => {
    const groups = settingsNavigationGroups("database", "admin", {
      databaseId: "db",
      tableId: "table",
    });
    expect(groups.map((group) => group.title)).toEqual(["Settings"]);
    expect(
      groups.flatMap((group) => group.items.map((item) => item.label)),
    ).toEqual(["General", "Danger Zone"]);
    const danger = groups
      .flatMap((group) => group.items)
      .find((item) => item.id === "database-danger-zone");
    expect(danger?.destructive).toBe(true);
    expect(danger?.href).toBe("/databases/db/settings/danger-zone");
    for (const item of groups.flatMap((group) => group.items))
      expect(item.href).not.toContain("tableId");
  });
});
