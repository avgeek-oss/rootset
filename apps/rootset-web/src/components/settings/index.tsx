"use client";

import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import { useResource } from "./api";
import {
  OrganisationSettings,
  MembersSettings,
  GrantsSettings,
  KeysSettings,
  ProfileSettings,
  PreferencesSettings,
  SessionsSettings,
  ConnectionsSettings,
  AuditSettings,
} from "./accounts";
import { AccountActionApproval, SecuritySettings } from "./security";
import { FieldsSettings, RulesIndexesSettings, TableSettings } from "./schema";
import {
  BackupsSettings,
  ImportsSettings,
  ExportsSettings,
  JobsSettings,
} from "./jobs";
import { InstallationSettings } from "./operator";
import { DatabaseSettings } from "./database";
import { SECTION_LABELS, type SettingsPanelProps } from "./types";
import "./settings.css";

export type { SettingsPanelProps, SettingsSection } from "./types";

export function SettingsPanel(props: SettingsPanelProps) {
  const [activeSection, setActiveSection] = useState(props.section);
  const context = useResource<{
    principal: { role: string; operator: boolean };
    scopes: string[];
  } | null>("/context", null);
  useEffect(() => setActiveSection(props.section), [props.section]);
  const components = {
    organisation: OrganisationSettings,
    members: MembersSettings,
    grants: GrantsSettings,
    keys: KeysSettings,
    profile: ProfileSettings,
    preferences: PreferencesSettings,
    security: SecuritySettings,
    sessions: SessionsSettings,
    connections: ConnectionsSettings,
    audit: AuditSettings,
    database: DatabaseSettings,
    table: TableSettings,
    fields: FieldsSettings,
    rules: RulesIndexesSettings,
    indexes: RulesIndexesSettings,
    backups: BackupsSettings,
    imports: ImportsSettings,
    exports: ExportsSettings,
    jobs: JobsSettings,
    operator: InstallationSettings,
  };
  const Component = components[activeSection];
  const sections = Object.keys(components) as (keyof typeof components)[];
  const tableSections = [
    "table",
    "fields",
    "rules",
    "indexes",
    "imports",
    "exports",
  ];
  const databaseSections = ["database", "backups"];
  const adminSections = ["members", "grants", "audit"];
  const admin =
    context.data && ["owner", "admin"].includes(context.data.principal.role);
  return (
    <div className="rootset-settings">
      <header className="settings-header">
        <div>
          <span className="settings-eyebrow">Settings</span>
          <h1>{SECTION_LABELS[activeSection]}</h1>
        </div>
        <Button
          variant="ghost"
          onPress={props.onClose}
          aria-label="Close settings"
        >
          Close
        </Button>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {sections
            .filter(
              (section) =>
                section !== "operator" || context.data?.principal.operator,
            )
            .filter((section) => !adminSections.includes(section) || admin)
            .map((section) => (
              <Button
                key={section}
                variant={activeSection === section ? "secondary" : "ghost"}
                aria-current={activeSection === section ? "page" : undefined}
                isDisabled={
                  (tableSections.includes(section) && !props.tableId) ||
                  (databaseSections.includes(section) && !props.databaseId)
                }
                onPress={() => setActiveSection(section)}
              >
                {SECTION_LABELS[section]}
              </Button>
            ))}
        </nav>
        <div className="settings-content">
          <Component
            key={`${activeSection}:${props.orgId}:${databaseSections.includes(activeSection) || tableSections.includes(activeSection) ? props.databaseId : ""}:${tableSections.includes(activeSection) ? props.tableId : ""}`}
            {...props}
            section={activeSection}
            {...(activeSection === "indexes" ? { indexes: true } : {})}
          />
        </div>
      </div>
      <AccountActionApproval orgId={props.orgId} />
    </div>
  );
}
