"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
  Database01Icon,
  Download01Icon,
  Key01Icon,
  BookOpen01Icon,
  Mail01Icon,
  ComputerIcon,
  SecurityCheckIcon,
  Settings01Icon,
  Table01Icon,
  Upload01Icon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { Database, Table } from "@rootset/contracts";
import { useRouter } from "next/navigation";
import {
  SecondaryItems,
  SecondaryEntityHeader,
} from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { canOpenSettings, SECTION_LABELS, type SettingsSection } from "./types";

export type SettingsScope = "account" | "team" | "database" | "table";

export const settingsGroups = {
  account: [
    { title: "Account", sections: ["profile", "preferences"] },
    { title: "Security", sections: ["email-password", "2fa", "sessions"] },
    { title: "API & MCP", sections: ["api-keys", "mcp"] },
  ],
  team: [
    { title: "Account", sections: ["organisation", "members"] },
    { title: "Installation", sections: ["operator"] },
  ],
  database: [{ title: "Settings", sections: ["database", "backups"] }],
  table: [
    { title: "Settings", sections: ["table", "fields", "rules", "indexes"] },
    { title: "Data", sections: ["imports", "exports"] },
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
  account: "Account settings",
  team: "Team settings",
  database: "Database settings",
  table: "Table settings",
};

export function settingsHref(
  section: SettingsSection,
  context: { databaseId?: string | null; tableId?: string | null },
) {
  const parameters = new URLSearchParams();
  const scope = settingsScope(section);
  if ((scope === "database" || scope === "table") && context.databaseId)
    parameters.set("databaseId", context.databaseId);
  if (scope === "table" && context.tableId)
    parameters.set("tableId", context.tableId);
  const query = parameters.toString();
  return `/settings/${section}${query ? `?${query}` : ""}`;
}

export function dataHref(databaseId?: string | null, tableId?: string | null) {
  const parameters = new URLSearchParams();
  if (databaseId) parameters.set("databaseId", databaseId);
  if (tableId) parameters.set("tableId", tableId);
  const query = parameters.toString();
  return `/${query ? `?${query}` : ""}`;
}

export const settingsIcons = {
  profile: UserAccountIcon,
  preferences: Settings01Icon,
  "email-password": Mail01Icon,
  "2fa": SecurityCheckIcon,
  sessions: ComputerIcon,
  "api-keys": Key01Icon,
  mcp: BookOpen01Icon,
  organisation: Settings01Icon,
  members: UserGroupIcon,
  operator: Activity01Icon,
  database: Settings01Icon,
  backups: Download01Icon,
  table: Table01Icon,
  fields: Table01Icon,
  rules: SecurityCheckIcon,
  indexes: Key01Icon,
  imports: Upload01Icon,
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
            : item === "backups"
              ? "Backups"
              : SECTION_LABELS[item],
          href: settingsHref(item, context),
          icon: settingsIcons[item],
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
  const router = useRouter();
  return (
    <>
      {settingsNavigationGroups(scope, role, { databaseId, tableId }).map(
        (group) => (
          <SecondaryItems
            key={group.title}
            title={group.title}
            selected={section ?? ""}
            onSelect={(id) => {
              const item = group.items.find((candidate) => candidate.id === id);
              if (item) router.push(item.href);
            }}
            items={group.items.map((item) => ({
              id: item.id,
              label: item.label,
              icon: <HugeiconsIcon icon={item.icon} />,
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
  const router = useRouter();
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
        icon={
          <HugeiconsIcon icon={tableScope ? Table01Icon : Database01Icon} />
        }
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
            icon: <HugeiconsIcon icon={Table01Icon} />,
          },
        ]}
        onSelect={() =>
          router.push(dataHref(databaseId, tableScope ? tableId : null))
        }
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
