"use client";
import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ContentPage } from "@avgeek-oss/design-system";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
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
import { SecuritySettings } from "./account/security-settings";
import { ApiMcpSettings } from "./account/api-mcp-settings";
import { settingsScope, settingsIcons } from "./navigation";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useResource } from "./api";
import { OrganisationSettings, MembersSettings } from "./accounts";
import { PreferencesSettings } from "./preferences";
import { AccountActionApproval } from "./security";
import { FieldsSettings, RulesIndexesSettings, TableSettings } from "./schema";
import { BackupsSettings, ImportsSettings, ExportsSettings } from "./jobs";
import { InstallationSettings } from "./operator";
import { DatabaseSettings } from "./database";
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
  const account = settingsScope(activeSection) === "account";
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
    profile: ProfileSettings,
    preferences: PreferencesSettings,
    "email-password": EmailPasswordSettings,
    "2fa": SecuritySettings,
    sessions: SessionSettings,
    mcp: McpGuideSettings,
    database: DatabaseSettings,
    table: TableSettings,
    fields: FieldsSettings,
    rules: RulesIndexesSettings,
    indexes: RulesIndexesSettings,
    backups: BackupsSettings,
    imports: ImportsSettings,
    exports: ExportsSettings,
    operator: InstallationSettings,
  };
  const Component = components[activeSection];
  const tableSections = [
    "table",
    "fields",
    "rules",
    "indexes",
    "imports",
    "exports",
  ];
  const databaseSections = ["database", "backups"];
  const content =
    context.loading || context.error ? (
      <Loading {...context} retry={context.reload} />
    ) : !canOpenSettings(
        activeSection,
        props.role ?? context.data?.principal.role,
      ) ? (
      <Empty>
        {activeSection === "imports"
          ? "Editor or admin access is required to import rows."
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
        {account ? (
          <ContentPage
            title={title}
            breadcrumbAncestors={[{ label: "Rootset", href: "/" }]}
            actions={selection?.actions}
            titleContent={
              <span className="inline-flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-flex shrink-0 [&_svg]:size-6"
                >
                  <HugeiconsIcon icon={settingsIcons[activeSection]} />
                </span>
                <TooltipText className="truncate" tooltip={title}>
                  {title}
                </TooltipText>
              </span>
            }
          >
            <div className="content-grid min-w-0">{content}</div>
            <AccountActionApproval orgId={props.orgId} />
          </ContentPage>
        ) : (
          <div className="rootset-settings">
            <header className="settings-header">
              <h1>{SECTION_LABELS[activeSection]}</h1>
              <Button
                variant="ghost"
                onPress={props.onClose}
                aria-label="Close settings"
              >
                Back to data
              </Button>
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
