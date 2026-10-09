"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Link01Icon,
  DatabaseIcon,
  DatabaseSettingIcon,
  Delete02Icon,
  ColumnsThreeCogIcon,
  TablePropertiesIcon,
  FingerPrintIcon,
  Download01Icon,
  Key01Icon,
  BookOpen01Icon,
  Mail01Icon,
  ComputerIcon,
  SecurityCheckIcon,
  Settings01Icon,
  TableIcon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { Database, Table } from "@rootset/contracts";
import {
  SecondaryItems,
  SecondaryEntityHeader,
} from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { canOpenSettings, SECTION_LABELS, type SettingsSection } from "./types";

export type SettingsScope = "account" | "team" | "database" | "table";

export const settingsGroups = {
  account: [
    { title: "Account", sections: ["profile", "preferences"] },
    { title: "Security", sections: ["email-password", "passkeys", "sessions"] },
    { title: "API & MCP", sections: ["api-keys", "mcp-connections", "mcp"] },
  ],
  team: [{ title: "Account", sections: ["organisation", "members"] }],
  database: [
    { title: "Settings", sections: ["database", "database-danger-zone"] },
  ],
  table: [
    {
      title: "Settings",
      sections: ["table", "fields", "rules", "table-danger-zone"],
    },
    { title: "Data", sections: ["exports"] },
  ],
} satisfies Record<
  SettingsScope,
  { title: string; sections: SettingsSection[] }[]
>;

export function settingsScope(section: SettingsSection): SettingsScope {
  for (const scope of Object.keys(settingsGroups) as SettingsScope[]) {
    if (
      settingsGroups[scope].some((group) =>
        (group.sections as SettingsSection[]).includes(section),
      )
    )
      return scope;
  }
  throw new Error(`Unknown settings section: ${section}`);
}

export const scopeTitles: Record<SettingsScope, string> = {
  account: "Account Settings",
  team: "Team Settings",
  database: "Database settings",
  table: "Table settings",
};

export function settingsHref(
  section: SettingsSection,
  context: { databaseId?: string | null; tableId?: string | null },
) {
  const scope = settingsScope(section);
  if (scope === "team")
    return `/team-settings/${section === "organisation" ? "general" : section}`;
  if (scope === "account") return `/settings/${section}`;
  const base = dataHref(
    context.databaseId,
    scope === "table" ? context.tableId : null,
  );
  const page =
    section === "database" || section === "table"
      ? "general"
      : section.endsWith("danger-zone")
        ? "danger-zone"
        : section === "exports"
          ? "export-requests"
          : section;
  return `${base}/settings/${page}`;
}

export function dataHref(databaseId?: string | null, tableId?: string | null) {
  if (!databaseId) return "/";
  return `/databases/${encodeURIComponent(databaseId)}${tableId ? `/tables/${encodeURIComponent(tableId)}` : ""}`;
}

export function resourceRoute(path: string) {
  const parts = path.split("/").filter(Boolean);
  const databaseId = parts[0] === "databases" ? (parts[1] ?? null) : null;
  const tableId =
    databaseId && parts[2] === "tables" ? (parts[3] ?? null) : null;
  const settingsIndex = tableId ? 4 : 2;
  const page =
    databaseId && parts[settingsIndex] === "settings"
      ? parts[settingsIndex + 1]
      : null;
  const section =
    page === "general"
      ? tableId
        ? "table"
        : "database"
      : page === "danger-zone"
        ? tableId
          ? "table-danger-zone"
          : "database-danger-zone"
        : page === "export-requests"
          ? "exports"
          : page;
  return { databaseId, tableId, section };
}

export const settingsIcons = {
  profile: UserAccountIcon,
  preferences: Settings01Icon,
  "email-password": Mail01Icon,
  passkeys: FingerPrintIcon,
  sessions: ComputerIcon,
  "api-keys": Key01Icon,
  mcp: BookOpen01Icon,
  organisation: Settings01Icon,
  members: UserGroupIcon,
  "mcp-connections": Link01Icon,
  database: DatabaseSettingIcon,
  "database-danger-zone": Delete02Icon,
  table: ColumnsThreeCogIcon,
  "table-danger-zone": Delete02Icon,
  fields: TablePropertiesIcon,
  rules: SecurityCheckIcon,
  exports: Download01Icon,
};

export function SettingsNavigation({
  section,
  role,
  databaseId,
  tableId,
}: {
  section: SettingsSection;
  role: string;
  databaseId?: string | null;
  tableId?: string | null;
}) {
  return (
    <SettingsSections
      section={section}
      scope={settingsScope(section)}
      role={role}
      databaseId={databaseId}
      tableId={tableId}
    />
  );
}

export function settingsNavigationGroups(
  scope: SettingsScope,
  role: string,
  context: { databaseId?: string | null; tableId?: string | null } = {},
) {
  return settingsGroups[scope]
    .map((group) => ({
      title: group.title,
      items: group.sections
        .filter((item) => canOpenSettings(item, role))
        .map((item) => ({
          id: item,
          label: ["database", "table", "organisation"].includes(item)
            ? "General"
            : SECTION_LABELS[item],
          href: settingsHref(item, context),
          icon: settingsIcons[item],
          destructive: item.endsWith("danger-zone"),
        })),
    }))
    .filter((group) => group.items.length > 0);
}

function SettingsSections({
  section,
  scope,
  role,
  databaseId,
  tableId,
}: {
  section?: SettingsSection | null;
  scope: SettingsScope;
  role: string;
  databaseId?: string | null;
  tableId?: string | null;
}) {
  return (
    <>
      {settingsNavigationGroups(scope, role, { databaseId, tableId }).map(
        (group) => (
          <SecondaryItems
            key={group.title}
            title={group.title}
            selected={section ?? ""}
            items={group.items.map((item) => ({
              id: item.id,
              href: item.href,
              label: item.label,
              icon: <HugeiconsIcon icon={item.icon} />,
              destructive: item.destructive,
            }))}
          />
        ),
      )}
    </>
  );
}

export function PageNavigation({
  section,
  role,
  database,
  table,
  databaseId,
  tableId,
}: {
  section: SettingsSection | null;
  role: string;
  database?: Database;
  table?: Table;
  databaseId: string | null;
  tableId: string | null;
}) {
  const scope = section
    ? settingsScope(section)
    : tableId
      ? "table"
      : "database";
  if (scope === "account" || scope === "team")
    return <SettingsSections scope={scope} section={section} role={role} />;
  if (!databaseId) return null;
  const tableScope = scope === "table";
  const title = tableScope
    ? (table?.name ?? "Table")
    : (database?.name ?? "Database");
  return (
    <>
      <SecondaryEntityHeader
        title={title}
        icon={<HugeiconsIcon icon={tableScope ? TableIcon : DatabaseIcon} />}
      >
        {title}
      </SecondaryEntityHeader>
      <SecondaryItems
        title={tableScope ? "Table" : "Database"}
        selected={section ? "" : tableScope ? "rows" : "tables"}
        items={[
          {
            id: tableScope ? "rows" : "tables",
            label: tableScope ? "Rows" : "Tables",
            href: dataHref(databaseId, tableScope ? tableId : null),
            icon: <HugeiconsIcon icon={TableIcon} />,
          },
        ]}
      />
      <SettingsSections
        scope={scope}
        section={section}
        role={role}
        databaseId={databaseId}
        tableId={tableId}
      />
    </>
  );
}
