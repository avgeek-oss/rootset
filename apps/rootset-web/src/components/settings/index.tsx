"use client";
import {
  WorkspaceDetailsSettings,
  WorkspaceAccessSettings,
  TeamWorkspacesSettings,
} from "../workspaces";
import { lazy, useState, useEffect } from "react";
import { Page } from "@avgeek-oss/design-system/layouts/page";
import { ContentPage, SettingsPageTitle } from "@avgeek-oss/design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  PageSelectionContext,
  type PageSelection,
} from "./account/page-selection-title";
import { RelativeTimeProvider } from "./account/last-synced-time";
import {
  ProfileSettings,
  EmailPasswordSettings,
  SessionSettings,
} from "./account/settings-pages";
import { PasskeySettings } from "./account/passkey-settings";
import { ApiMcpSettings } from "./account/api-mcp-settings";
import { settingsIcons, settingsScope } from "./navigation";

import { useResource } from "./api";
import { OrganisationSettings, MembersSettings } from "./accounts";
import { PreferencesSettings } from "./preferences";
import { IdentityConfirmation } from "./security";
import {
  FieldsSettings,
  UniqueRulesSettings,
  TableSettings,
  TableDangerZone,
} from "./schema";
import { ExportsSettings } from "./jobs";
import { ImportsSettings } from "./imports";
import { BackupScheduleSettings } from "./backups";
import { BackupHistorySettings } from "./backup-history";
import { RestoreRequestsSettings } from "./restore-requests";
import { ForeignKeysSettings } from "./foreign-keys";
import { DatabaseSettings, DatabaseDangerZone } from "./database";
import {
  canOpenSettings,
  SECTION_LABELS,
  type SettingsPanelProps,
} from "./types";
import { Empty, Loading } from "./ui";
import "./settings.css";

export type { SettingsPanelProps, SettingsSection } from "./types";

const WorkspaceAuditLogsPage = lazy(() =>
  import("../activity-page").then((module) => ({
    default: module.AuditLogsPage,
  })),
);

export function SettingsPanel(props: SettingsPanelProps) {
  const activeSection = props.section;
  const commonSettings = ["account", "team", "workspace"].includes(
    settingsScope(activeSection),
  );
  const [selection, setSelection] = useState<PageSelection | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["account-settings"] });
      props.onChanged?.();
    };
    window.addEventListener("rootset:account-refresh", refresh);
    window.addEventListener("rootset:identity-changed", refresh);
    return () => {
      window.removeEventListener("rootset:account-refresh", refresh);
      window.removeEventListener("rootset:identity-changed", refresh);
    };
  }, [queryClient, props.onChanged]);
  const context = useResource<{
    principal: { role: string };
    scopes: string[];
  } | null>(props.role ? undefined : "/context", null);
  const components = {
    "workspace-general": WorkspaceDetailsSettings,
    "workspace-danger-zone": WorkspaceDetailsSettings,
    "workspace-audit-logs": WorkspaceAuditLogsPage,
    "workspace-access": WorkspaceAccessSettings,
    "team-workspaces": TeamWorkspacesSettings,
    organisation: OrganisationSettings,
    members: MembersSettings,
    "api-keys": PersonalKeysSettings,
    "workspace-api-keys": WorkspaceKeysSettings,
    "mcp-connections": ConnectionsSettings,
    profile: ProfileSettings,
    preferences: PreferencesSettings,
    "email-password": EmailPasswordSettings,
    passkeys: PasskeySettings,
    sessions: SessionSettings,
    mcp: McpGuideSettings,
    database: DatabaseSettings,
    "backup-schedule": BackupScheduleSettings,
    "backup-history": BackupHistorySettings,
    "restore-requests": RestoreRequestsSettings,
    "database-exports": ExportsSettings,
    "database-danger-zone": DatabaseDangerZone,
    table: TableSettings,
    "table-danger-zone": TableDangerZone,
    fields: FieldsSettings,
    rules: UniqueRulesSettings,
    "foreign-keys": ForeignKeysSettings,
    exports: ExportsSettings,
    imports: ImportsSettings,
  };
  const Component = components[activeSection];
  const tableSections = [
    "table",
    "table-danger-zone",
    "fields",
    "rules",
    "foreign-keys",
    "exports",
    "imports",
  ];
  const databaseSections = [
    "database",
    "database-danger-zone",
    "backup-schedule",
    "backup-history",
    "restore-requests",
    "database-exports",
  ];
  const content =
    context.loading || context.error ? (
      <Loading {...context} retry={context.reload} />
    ) : !canOpenSettings(
        activeSection,
        props.role ?? context.data?.principal.role,
      ) ? (
      <Empty>Your role does not allow access to this page.</Empty>
    ) : (
      <Component
        key={`${activeSection}:${props.orgId}:${databaseSections.includes(activeSection) || tableSections.includes(activeSection) ? props.databaseId : ""}:${tableSections.includes(activeSection) ? props.tableId : ""}`}
        {...props}
        section={activeSection}
      />
    );
  const title = selection?.label ?? SECTION_LABELS[activeSection];
  return (
    <PageSelectionContext.Provider value={setSelection}>
      <RelativeTimeProvider>
        {activeSection === "workspace-audit-logs" ? (
          content
        ) : commonSettings && activeSection === "passkeys" ? (
          <Page>
            <div className="min-w-0">{content}</div>
            <IdentityConfirmation />
          </Page>
        ) : commonSettings ? (
          <ContentPage
            title={title}
            breadcrumbAncestors={[
              settingsScope(activeSection) === "team"
                ? { label: "Team Settings", href: "/team-settings/general" }
                : settingsScope(activeSection) === "workspace"
                  ? {
                      label: "Workspace Settings",
                      href: props.workspaceIsDefault
                        ? "/workspace-settings/api-keys"
                        : "/workspace-settings/general",
                    }
                  : { label: "Account Settings", href: "/settings/profile" },
            ]}
            actions={selection?.actions}
            titleContent={
              settingsScope(activeSection) === "workspace" ||
              activeSection === "team-workspaces" ? (
                <span className="inline-flex items-center gap-2">
                  <HugeiconsIcon
                    icon={settingsIcons[activeSection]}
                    size={20}
                  />
                  {title}
                </span>
              ) : (
                <SettingsPageTitle
                  section={
                    ["organisation", "workspace-general"].includes(
                      activeSection,
                    )
                      ? "general"
                      : activeSection === "workspace-api-keys"
                        ? "api-keys"
                        : (activeSection as Parameters<
                            typeof SettingsPageTitle
                          >[0]["section"])
                  }
                />
              )
            }
          >
            <div className="content-grid min-w-0">{content}</div>
            <IdentityConfirmation />
          </ContentPage>
        ) : (
          <ContentPage
            title={title}
            breadcrumbAncestors={[]}
            actions={selection?.actions}
            titleContent={
              <span className="inline-flex min-w-0 items-center gap-2">
                <HugeiconsIcon
                  icon={settingsIcons[activeSection]}
                  size={24}
                  className="shrink-0"
                  aria-hidden="true"
                />
                <span>{title}</span>
              </span>
            }
          >
            <div className="settings-content">{content}</div>
            <IdentityConfirmation />
          </ContentPage>
        )}
      </RelativeTimeProvider>
    </PageSelectionContext.Provider>
  );
}

function WorkspaceKeysSettings() {
  return <ApiMcpSettings section="workspace-keys" />;
}

function PersonalKeysSettings() {
  return <ApiMcpSettings section="personal-keys" />;
}
function McpGuideSettings() {
  return <ApiMcpSettings section="mcp" />;
}

function ConnectionsSettings() {
  return <ApiMcpSettings section="mcp-connections" />;
}
