"use client";
import { useState, useEffect } from "react";
import { Page } from "@avgeek-oss/design-system/layouts/page";
import { ContentPage, SettingsPageTitle } from "@avgeek-oss/design-system";
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
import { settingsScope } from "./navigation";

import { useResource } from "./api";
import { OrganisationSettings, MembersSettings } from "./accounts";
import { PreferencesSettings } from "./preferences";
import { AccountActionApproval } from "./security";
import {
  FieldsSettings,
  RulesIndexesSettings,
  TableSettings,
  TableDangerZone,
} from "./schema";
import { ImportsSettings, ExportsSettings } from "./jobs";
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
    "mcp-connections": ConnectionsSettings,
    profile: ProfileSettings,
    preferences: PreferencesSettings,
    "email-password": EmailPasswordSettings,
    passkeys: PasskeySettings,
    sessions: SessionSettings,
    mcp: McpGuideSettings,
    database: DatabaseSettings,
    "database-danger-zone": DatabaseDangerZone,
    table: TableSettings,
    "table-danger-zone": TableDangerZone,
    fields: FieldsSettings,
    rules: RulesIndexesSettings,
    indexes: RulesIndexesSettings,
    imports: ImportsSettings,
    exports: ExportsSettings,
  };
  const Component = components[activeSection];
  const tableSections = [
    "table",
    "table-danger-zone",
    "fields",
    "rules",
    "indexes",
    "imports",
    "exports",
  ];
  const databaseSections = ["database", "database-danger-zone"];
  const content =
    context.loading || context.error ? (
      <Loading {...context} retry={context.reload} />
    ) : !canOpenSettings(
        activeSection,
        props.role ?? context.data?.principal.role,
      ) ? (
      <Empty>
        {activeSection === "imports"
          ? "Member or admin access is required to import rows."
          : "Admin access is required to manage these settings."}
      </Empty>
    ) : (
      <Component
        key={`${activeSection}:${props.orgId}:${databaseSections.includes(activeSection) || tableSections.includes(activeSection) ? props.databaseId : ""}:${tableSections.includes(activeSection) ? props.tableId : ""}`}
        {...props}
        section={activeSection}
        {...(activeSection === "indexes" ? { indexes: true } : {})}
      />
    );
  const title = selection?.label ?? SECTION_LABELS[activeSection];
  return (
    <PageSelectionContext.Provider value={setSelection}>
      <RelativeTimeProvider>
        {commonSettings && activeSection === "passkeys" ? (
          <Page>
            <div className="min-w-0">{content}</div>
            <AccountActionApproval orgId={props.orgId} />
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
                    : (activeSection as Parameters<
                        typeof SettingsPageTitle
                      >[0]["section"])
                }
              />
            }
          >
            <div className="content-grid min-w-0">{content}</div>
            <AccountActionApproval orgId={props.orgId} />
          </ContentPage>
        ) : (
          <div className="rootset-settings">
            <header className="settings-header">
              <h1>{SECTION_LABELS[activeSection]}</h1>
            </header>
            <div className="settings-content">{content}</div>
            <AccountActionApproval orgId={props.orgId} />
          </div>
        )}
      </RelativeTimeProvider>
    </PageSelectionContext.Provider>
  );
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
