"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  McpServerIcon,
  Layers01Icon,
  Clock01Icon,
  TransactionHistoryIcon,
  DatabaseIcon,
  DatabaseRestoreIcon,
  DatabaseSettingIcon,
  Delete02Icon,
  ColumnsThreeCogIcon,
  TablePropertiesIcon,
  FingerPrintIcon,
  Download01Icon,
  Upload01Icon,
  Key01Icon,
  Link01Icon,
  RowsThreeIcon,
  Mail01Icon,
  ComputerIcon,
  SecurityCheckIcon,
  Settings01Icon,
  TableIcon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import type { AppShellBreadcrumb } from "@avgeek-oss/design-system/layouts/app-shell-breadcrumb";
import type { DatabaseSummary, Table } from "@rootset/contracts";
import {
  SecondaryItems,
  SecondaryEntityHeader,
} from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { canOpenSettings, SECTION_LABELS, type SettingsSection } from "./types";

export type SettingsScope =
  "account" | "team" | "workspace" | "database" | "table";

export const settingsGroups = {
  account: [
    { title: "Account", sections: ["profile", "preferences"] },
    { title: "Security", sections: ["email-password", "passkeys", "sessions"] },
    { title: "API & MCP", sections: ["api-keys", "mcp-connections", "mcp"] },
  ],
  team: [
    { title: "Team", sections: ["organisation", "members", "team-workspaces"] },
  ],
  workspace: [
    {
      title: "Workspace",
      sections: [
        "workspace-general",
        "workspace-access",
        "workspace-api-keys",
        "workspace-audit-logs",
      ],
    },
    { title: "Danger Zone", sections: ["workspace-danger-zone"] },
  ],
  database: [
    { title: "Data", sections: ["database-exports"] },
    {
      title: "Backup & Restore",
      sections: ["backup-schedule", "backup-history", "restore-requests"],
    },
    { title: "Settings", sections: ["database"] },
    { title: "Danger Zone", sections: ["database-danger-zone"] },
  ],
  table: [
    { title: "Data", sections: ["imports", "exports"] },
    {
      title: "Settings",
      sections: ["table", "fields", "rules", "foreign-keys"],
    },
    { title: "Danger Zone", sections: ["table-danger-zone"] },
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
  workspace: "Workspace Settings",
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
  if (scope === "workspace")
    return `/workspace-settings/${section === "workspace-general" ? "general" : section === "workspace-access" ? "manage-access" : section === "workspace-audit-logs" ? "audit-logs" : section === "workspace-danger-zone" ? "delete-workspace" : "api-keys"}`;
  if (scope === "team")
    return `/team-settings/${section === "organisation" ? "general" : section === "team-workspaces" ? "workspaces" : section}`;
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
        : section === "exports" || section === "database-exports"
          ? "export-requests"
          : section === "imports"
            ? "import-requests"
            : section === "backup-history"
              ? "backup-attempts"
              : section === "restore-requests"
                ? "restore-attempts"
                : section;
  return `${base}/settings/${page}`;
}

export function dataHref(databaseId?: string | null, tableId?: string | null) {
  if (!databaseId) return "/";
  return `/databases/${encodeURIComponent(databaseId)}${tableId ? `/tables/${encodeURIComponent(tableId)}` : ""}`;
}

export function resourceBreadcrumbs(context: {
  databaseId?: string | null;
  databaseName?: string;
  tableId?: string | null;
  tableName?: string;
  section?: SettingsSection | null;
  databaseSwitcher?: ReactNode;
  tableSwitcher?: ReactNode;
  workspaceIsDefault?: boolean;
}): ComponentProps<typeof AppShellBreadcrumb>["items"] {
  const { databaseId, databaseName, tableId, tableName, section } = context;
  const scope = section ? settingsScope(section) : null;
  if (
    section &&
    (scope === "account" || scope === "team" || scope === "workspace")
  )
    return [
      scope === "account"
        ? { label: "Account Settings", href: "/settings/profile" }
        : scope === "workspace"
          ? {
              label: "Workspace Settings",
              href: context.workspaceIsDefault
                ? "/workspace-settings/api-keys"
                : "/workspace-settings/general",
            }
          : { label: "Team Settings", href: "/team-settings/general" },
      { label: SECTION_LABELS[section] },
    ];
  return [
    { label: "Rootset", href: "/" },
    { label: "Databases", ...(databaseId ? { href: "/" } : {}) },
    ...(databaseId
      ? [
          {
            label: databaseName ?? "Database",
            href: dataHref(databaseId),
            ...(context.databaseSwitcher
              ? {
                  content: context.databaseSwitcher,
                  contentKey: `database-${databaseId}`,
                }
              : {}),
          },
        ]
      : []),
    ...(databaseId && scope !== "database"
      ? [
          {
            label: "Tables",
            ...(tableId ? { href: dataHref(databaseId) } : {}),
          },
        ]
      : []),
    ...(tableId && scope !== "database"
      ? [
          {
            label: tableName ?? "Table",
            ...(section ? { href: dataHref(databaseId, tableId) } : {}),
            ...(context.tableSwitcher
              ? {
                  content: context.tableSwitcher,
                  contentKey: `table-${tableId}`,
                }
              : {}),
          },
        ]
      : []),
    ...(section ? [{ label: SECTION_LABELS[section] }] : []),
  ];
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
          ? tableId
            ? "exports"
            : "database-exports"
          : page === "import-requests"
            ? "imports"
            : page === "backup-attempts"
              ? "backup-history"
              : page === "restore-attempts"
                ? "restore-requests"
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
  "workspace-api-keys": Key01Icon,
  mcp: McpServerIcon,
  "workspace-general": Settings01Icon,
  "workspace-access": UserGroupIcon,
  "workspace-audit-logs": TransactionHistoryIcon,
  "workspace-danger-zone": Delete02Icon,
  "team-workspaces": Layers01Icon,
  organisation: Settings01Icon,
  members: UserGroupIcon,
  "mcp-connections": McpServerIcon,
  database: DatabaseSettingIcon,
  "backup-schedule": Clock01Icon,
  "backup-history": TransactionHistoryIcon,
  "restore-requests": DatabaseRestoreIcon,
  "database-exports": Download01Icon,
  "database-danger-zone": Delete02Icon,
  table: ColumnsThreeCogIcon,
  "table-danger-zone": Delete02Icon,
  fields: TablePropertiesIcon,
  rules: SecurityCheckIcon,
  "foreign-keys": Link01Icon,
  exports: Download01Icon,
  imports: Upload01Icon,
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
      key={`${settingsScope(section)}:${role}`}
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
  context: {
    databaseId?: string | null;
    tableId?: string | null;
    workspaceIsDefault?: boolean;
  } = {},
) {
  return settingsGroups[scope]
    .map((group) => ({
      title: group.title,
      items: group.sections
        .filter((item) => canOpenSettings(item, role))
        .filter(
          (item) =>
            !context.workspaceIsDefault ||
            ![
              "workspace-general",
              "workspace-access",
              "workspace-danger-zone",
            ].includes(item),
        )
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
  workspaceIsDefault,
}: {
  section?: SettingsSection | null;
  scope: SettingsScope;
  role: string;
  databaseId?: string | null;
  tableId?: string | null;
  workspaceIsDefault?: boolean;
}) {
  return (
    <>
      {settingsNavigationGroups(scope, role, {
        databaseId,
        tableId,
        workspaceIsDefault,
      }).map((group) => (
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
      ))}
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
  locale,
  workspaceIsDefault,
}: {
  section: SettingsSection | null;
  role: string;
  database?: DatabaseSummary;
  table?: Table;
  databaseId: string | null;
  tableId: string | null;
  locale: string;
  workspaceIsDefault?: boolean;
}) {
  const scope = section
    ? settingsScope(section)
    : tableId
      ? "table"
      : "database";
  if (
    section &&
    (scope === "account" || scope === "team" || scope === "workspace")
  )
    return (
      <SettingsSections
        key={`${scope}:${role}`}
        scope={scope}
        section={section}
        role={role}
        workspaceIsDefault={workspaceIsDefault}
      />
    );
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
            icon: (
              <HugeiconsIcon
                icon={tableScope ? RowsThreeIcon : TableIcon}
                aria-hidden
              />
            ),
            badge: (tableScope
              ? table?.rowCount
              : database?.tableCount
            )?.toLocaleString(locale),
          },
        ]}
      />
      <SettingsSections
        key={`${scope}:${role}`}
        scope={scope}
        section={section}
        role={role}
        databaseId={databaseId}
        tableId={tableId}
      />
    </>
  );
}
