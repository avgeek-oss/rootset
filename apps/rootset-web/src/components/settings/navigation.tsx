"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
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
import {
  SecondaryLinks,
  SecondarySection,
  SecondarySidebar,
} from "../ui/shell";
import { canOpenSettings, SECTION_LABELS, type SettingsSection } from "./types";

export type SettingsScope = "account" | "team" | "database" | "table";

export const settingsGroups = {
  account: [
    { title: "Account", sections: ["profile", "preferences"] },
    { title: "Security", sections: ["email-password", "2fa", "sessions"] },
    { title: "API & MCP", sections: ["api-keys", "mcp"] },
  ],
  team: [
    { title: "Team", sections: ["organisation", "members"] },
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
      {settingsGroups[scope].map((group) => {
        const sections = group.sections.filter((item) =>
          canOpenSettings(item, role),
        );
        return sections.length ? (
          <SecondarySection key={group.title} title={group.title}>
            <SecondaryLinks
              items={sections.map((item) => ({
                id: item,
                href: settingsHref(item, { databaseId, tableId }),
                label:
                  item === "database" ||
                  item === "table" ||
                  item === "organisation"
                    ? "General"
                    : item === "backups"
                      ? "Backups"
                      : SECTION_LABELS[item],
                active: section === item,
                icon: (
                  <HugeiconsIcon
                    icon={settingsIcons[item]}
                    size={16}
                    aria-hidden="true"
                    className="size-4 shrink-0"
                  />
                ),
              }))}
            />
          </SecondarySection>
        ) : null;
      })}
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
    return (
      <SecondarySidebar title={scopeTitles[scope]} hideTitle items={[]}>
        <SettingsSections scope={scope} section={section} role={role} />
      </SecondarySidebar>
    );
  if (!databaseId) return null;
  const tableScope = scope === "table";
  const title = tableScope
    ? (table?.name ?? "Table")
    : (database?.name ?? "Database");
  return (
    <SecondarySidebar title={title} hideTitle items={[]}>
      <div className="secondary-resource-heading">
        <h2 title={title}>{title}</h2>
      </div>
      <SecondarySection title={tableScope ? "Table" : "Database"}>
        <SecondaryLinks
          items={[
            {
              id: tableScope ? "rows" : "tables",
              label: tableScope ? "Rows" : "Tables",
              href: dataHref(databaseId, tableScope ? tableId : null),
              active: !section,
              icon: (
                <HugeiconsIcon
                  icon={Table01Icon}
                  size={16}
                  aria-hidden="true"
                  className="size-4 shrink-0"
                />
              ),
            },
          ]}
        />
      </SecondarySection>
      <SettingsSections
        scope={scope}
        section={section}
        role={role}
        databaseId={databaseId}
        tableId={tableId}
      />
    </SecondarySidebar>
  );
}
