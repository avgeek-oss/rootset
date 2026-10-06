import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  dataHref,
  settingsGroups,
  settingsHref,
  settingsScope,
  SettingsNavigation,
  PageNavigation,
} from "./navigation";
import {
  SECTION_LABELS,
  resolveSettingsSection,
  type SettingsSection,
} from "./types";

describe("context settings navigation", () => {
  it("matches Towbar account groups and resolves existing bookmarks", () => {
    expect(settingsGroups.account).toEqual([
      { title: "Account", sections: ["profile", "preferences"] },
      { title: "Security", sections: ["email-password", "2fa", "sessions"] },
      { title: "API & MCP", sections: ["api-keys", "mcp"] },
    ]);
    expect(resolveSettingsSection("security")).toBe("2fa");
    expect(resolveSettingsSection("keys")).toBe("api-keys");
    expect(resolveSettingsSection("connections")).toBe("api-keys");
    expect(resolveSettingsSection("missing")).toBeNull();
  });

  it("gives every section one settings context", () => {
    const sections = Object.values(settingsGroups).flatMap((groups) =>
      groups.flatMap((group) => group.sections),
    );
    expect(new Set(sections).size).toBe(sections.length);
    expect([...sections].sort()).toEqual(Object.keys(SECTION_LABELS).sort());
  });

  it.each(["profile", "organisation", "database", "fields"] as const)(
    "shows just the context containing %s",
    (section) => {
      const html = renderToStaticMarkup(
        createElement(SettingsNavigation, {
          section,
          role: "admin",
          databaseId: "database-id",
          tableId: "table-id",
        }),
      );
      const scope = settingsScope(section);
      for (const candidate of Object.keys(
        SECTION_LABELS,
      ) as SettingsSection[]) {
        const href = settingsHref(candidate, {
          databaseId: "database-id",
          tableId: "table-id",
        }).replaceAll("&", "&amp;");
        if (settingsScope(candidate) === scope)
          expect(html).toContain(`href="${href}"`);
        else expect(html).not.toContain(`href="${href}"`);
      }
    },
  );

  it("keeps table exports available to viewers while hiding management and imports", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "exports",
        role: "viewer",
        databaseId: "db",
        tableId: "table",
      }),
    );
    expect(html).toContain("Export rows");
    for (const label of [
      "General",
      "Fields",
      "Unique rules",
      "Search indexes",
      "Import rows",
    ])
      expect(html).not.toContain(`>${label}<`);
  });

  it("includes only the resource identifiers belonging to each settings scope", () => {
    const context = { databaseId: "db", tableId: "table" };
    expect(settingsHref("profile", context)).toBe("/settings/profile");
    expect(settingsHref("backups", context)).toBe(
      "/settings/backups?databaseId=db",
    );
    expect(settingsHref("fields", context)).toBe(
      "/settings/fields?databaseId=db&tableId=table",
    );
    expect(settingsHref("organisation", context)).toBe(
      "/settings/organisation",
    );
    expect(settingsHref("profile", {})).toBe("/settings/profile");
    expect(dataHref("db", "table")).toBe("/?databaseId=db&tableId=table");
  });

  it.each(["profile", "preferences", "organisation", "members"] as const)(
    "isolates the %s sidebar even when an old URL contains database and table context",
    (section) => {
      const html = renderToStaticMarkup(
        createElement(PageNavigation, {
          section,
          role: "admin",
          databaseId: "db",
          tableId: "table",
        }),
      );
      expect(html).not.toContain("databaseId=");
      expect(html).not.toContain(">Tables<");
      expect(html).not.toContain(">Rows<");
      expect(html).not.toContain(">Backups<");
      expect(html).not.toContain("secondary-resource-heading");
    },
  );

  it("shows database Tables and Settings without embedding individual tables", () => {
    const html = renderToStaticMarkup(
      createElement(PageNavigation, {
        section: null,
        role: "admin",
        databaseId: "db",
        tableId: null,
      }),
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/?databaseId=db"');
    for (const label of [
      "Database",
      "Tables",
      "Settings",
      "General",
      "Backups",
    ])
      expect(html).toContain(`>${label}<`);
    expect(html).not.toContain("tableId=");
    expect(html).not.toContain("Create table");
    expect(html).not.toContain(">Fields<");
  });

  it.each([null, "fields"] as const)(
    "keeps the table sidebar in its own scope for %s",
    (section) => {
      const html = renderToStaticMarkup(
        createElement(PageNavigation, {
          section,
          role: "admin",
          databaseId: "db",
          tableId: "table",
        }),
      );
      for (const label of ["Rows", "Fields", "Unique rules", "Search indexes"])
        expect(html).toContain(`>${label}<`);
      expect(html).toContain('href="/?databaseId=db&amp;tableId=table"');
      expect(html).not.toContain(">Backups<");
      expect(html).not.toContain(">Tables<");
      expect(html).not.toContain(">Your profile<");
    },
  );
});
