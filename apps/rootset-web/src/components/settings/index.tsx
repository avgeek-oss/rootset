"use client";
import { useState, useEffect } from "react";
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
import { BackupScheduleSettings } from "./backups";
import { BackupHistorySettings } from "./backup-history";
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

export function SettingsPanel(props: SettingsPanelProps) {
  const activeSection = props.section;
  const commonSettings = ["account", "team"].includes(
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
    organisation: OrganisationSettings,
    members: MembersSettings,
    "api-keys": PersonalKeysSettings,
    "team-api-keys": TeamKeysSettings,
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
    "database-danger-zone": DatabaseDangerZone,
    table: TableSettings,
    "table-danger-zone": TableDangerZone,
    fields: FieldsSettings,
    rules: UniqueRulesSettings,
    "foreign-keys": ForeignKeysSettings,
    exports: ExportsSettings,
  };
  const Component = components[activeSection];
  const tableSections = [
    "table",
    "table-danger-zone",
    "fields",
    "rules",
    "foreign-keys",
    "exports",
  ];
  const databaseSections = [
    "database",
    "database-danger-zone",
    "backup-schedule",
    "backup-history",
  ];
  const content =
    context.loading || context.error ? (
      <Loading {...context} retry={context.reload} />
    ) : !canOpenSettings(
        activeSection,
        props.role ?? context.data?.principal.role,
      ) ? (
      <Empty>Admin access is required to manage these settings.</Empty>
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
        {commonSettings && activeSection === "passkeys" ? (
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
                : { label: "Account Settings", href: "/settings/profile" },
            ]}
            actions={selection?.actions}
            titleContent={
              <SettingsPageTitle
                section={
                  activeSection === "organisation"
                    ? "general"
                    : activeSection === "team-api-keys"
                      ? "api-keys"
                      : (activeSection as Parameters<
                          typeof SettingsPageTitle
                        >[0]["section"])
                }
              />
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

function TeamKeysSettings() {
  return <ApiMcpSettings section="team-keys" />;
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
