import { describe, expect, it } from "vitest";
import {
  dataHref,
  resourceBreadcrumbs,
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
    expect(resolveSettingsSection("database-activity")).toBeNull();
    expect(resolveSettingsSection("table-activity")).toBeNull();
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
      settingsNavigationGroups("database", "viewer").flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ).toEqual(["database-exports"]);
    expect(
      settingsNavigationGroups("table", "member").flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ).toEqual([
      "table",
      "fields",
      "rules",
      "foreign-keys",
      "imports",
      "exports",
    ]);
    expect(settingsNavigationGroups("account", "unknown")).toEqual([]);
  });
  it("includes only identifiers belonging to the settings scope", () => {
    const context = { databaseId: "db", tableId: "table" };
    expect(settingsHref("profile", context)).toBe("/settings/profile");
    expect(settingsHref("organisation", context)).toBe(
      "/team-settings/general",
    );
    expect(settingsHref("members", context)).toBe("/team-settings/members");
    expect(settingsHref("team-api-keys", context)).toBe(
      "/team-settings/api-keys",
    );
    expect(settingsNavigationGroups("team", "viewer")).toEqual([]);
    expect(settingsHref("fields", context)).toBe(
      "/databases/db/tables/table/settings/fields",
    );
    expect(SECTION_LABELS.exports).toBe("Export Requests");
    expect(resolveSettingsSection("export-requests")).toBe("exports");
    expect(settingsHref("exports", context)).toBe(
      "/databases/db/tables/table/settings/export-requests",
    );
    expect(settingsHref("imports", context)).toBe(
      "/databases/db/tables/table/settings/import-requests",
    );
    expect(resolveSettingsSection("import-requests")).toBe("imports");
    expect(
      resourceRoute("/databases/db/tables/table/settings/import-requests")
        .section,
    ).toBe("imports");
    expect(settingsHref("database-exports", context)).toBe(
      "/databases/db/settings/export-requests",
    );
    expect(dataHref("db", "table")).toBe("/databases/db/tables/table");
  });
  it("round trips resource pages and separates destructive settings", () => {
    for (const section of [
      "database",
      "database-danger-zone",
      "backup-schedule",
      "backup-history",
      "restore-requests",
      "database-exports",
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
        settingsScope(section) === "database" ? null : "table",
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
    const danger = settingsNavigationGroups("table", "admin", {
      databaseId: "db",
      tableId: "table",
    }).at(-1);
    expect(danger?.title).toBe("Danger Zone");
    expect(danger?.items.map((item) => item.label)).toEqual(["Delete Table"]);
  });
  it("keeps database settings separate from table and account settings", () => {
    const groups = settingsNavigationGroups("database", "admin", {
      databaseId: "db",
      tableId: "table",
    });
    expect(groups.map((group) => group.title)).toEqual([
      "Data",
      "Backup & Restore",
      "Settings",
      "Danger Zone",
    ]);
    expect(
      groups.flatMap((group) => group.items.map((item) => item.label)),
    ).toEqual([
      "Export Requests",
      "Backup Schedule",
      "Backup Attempts",
      "Restore Attempts",
      "General",
      "Delete Database",
    ]);
    const danger = groups
      .flatMap((group) => group.items)
      .find((item) => item.id === "database-danger-zone");
    expect(danger?.destructive).toBe(true);
    expect(danger?.href).toBe("/databases/db/settings/danger-zone");
    for (const item of groups.flatMap((group) => group.items))
      expect(item.href).not.toContain("tableId");
  });
});

describe("resource breadcrumbs", () => {
  const context = {
    databaseId: "db",
    databaseName: "Products",
    tableId: "table",
    tableName: "Stock",
  };
  it("keeps collection links when opening a table or its settings", () => {
    expect(resourceBreadcrumbs(context)).toEqual([
      { label: "Rootset", href: "/" },
      { label: "Databases", href: "/" },
      { label: "Products", href: "/databases/db" },
      { label: "Tables", href: "/databases/db" },
      { label: "Stock" },
    ]);
    expect(resourceBreadcrumbs({ ...context, section: "fields" })).toEqual([
      { label: "Rootset", href: "/" },
      { label: "Databases", href: "/" },
      { label: "Products", href: "/databases/db" },
      { label: "Tables", href: "/databases/db" },
      { label: "Stock", href: "/databases/db/tables/table" },
      { label: "Fields" },
    ]);
  });
  it("keeps database settings free of stale table and account context", () => {
    expect(
      resourceBreadcrumbs({ ...context, section: "database" }).map(
        (item) => item.label,
      ),
    ).toEqual(["Rootset", "Databases", "Products", "General"]);
    expect(resourceBreadcrumbs({ ...context, section: "profile" })).toEqual([
      { label: "Account Settings", href: "/settings/profile" },
      { label: "Profile" },
    ]);
    expect(resourceBreadcrumbs({})).toEqual([
      { label: "Rootset", href: "/" },
      { label: "Databases" },
    ]);
    expect(
      resourceBreadcrumbs({ databaseId: "db", databaseName: "Products" }).map(
        (item) => item.label,
      ),
    ).toEqual(["Rootset", "Databases", "Products", "Tables"]);
  });
});
