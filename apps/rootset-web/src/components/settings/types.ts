import type {
  ConnectionSchema,
  UniqueRuleCondition,
  ForeignKey,
  Preferences as AccountPreferences,
} from "@rootset/contracts";
import type { z } from "zod";

export type SettingsSection =
  | "organisation"
  | "members"
  | "api-keys"
  | "team-api-keys"
  | "profile"
  | "preferences"
  | "email-password"
  | "passkeys"
  | "sessions"
  | "mcp-connections"
  | "mcp"
  | "database"
  | "backup-schedule"
  | "backup-history"
  | "database-danger-zone"
  | "table-danger-zone"
  | "table"
  | "fields"
  | "rules"
  | "foreign-keys"
  | "exports";

export interface SettingsPanelProps {
  section: SettingsSection;
  orgId: string;
  role?: string;
  databaseId?: string;
  tableId?: string;
  theme?: Preferences["theme"];
  preferences?: Preferences;
  onClose: () => void;
  onChanged?: () => void;
}

export interface Organisation {
  id: string;
  name: string;
  state?: string;
}
export interface Profile {
  id: string;
  name?: string;
  displayName?: string;
  email: string;
  emailVerified?: boolean;
}
export type Preferences = AccountPreferences;
export interface Member {
  id: string;
  userId: string;
  name?: string;
  email: string;
  role: "admin" | "member" | "viewer";
  version: string;
  verified: boolean;
}
export interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  status?: string;
  state?: string;
  expiresAt?: string;
}
export interface ApiKey {
  access: "read" | "edit";
  includeAdmin: boolean;
  id: string;
  name: string;
  prefix?: string;
  createdAt?: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}
export interface Session {
  id: string;
  createdAt?: string;
  lastActivityAt?: string;
  expiresAt?: string;
  userAgent?: string;
  ipAddress?: string;
  current?: boolean;
}
export type Connection = z.infer<typeof ConnectionSchema>;
export interface Passkey {
  id: string;
  name?: string;
  createdAt?: string;
  lastUsedAt?: string;
}
export interface SecurityStatus {
  twoFactorEnabled?: boolean;
  recoveryCodesRemaining?: number;
  passkeys?: Passkey[];
}
export interface TableField {
  id: string;
  name: string;
  type:
    | "text"
    | "uri"
    | "url"
    | "image"
    | "integer"
    | "float"
    | "boolean"
    | "date"
    | "time"
    | "date-time"
    | "json";
  required?: boolean;
  charLimit?: number;
  allowedValues?: string[] | null;
  autoIncrement?: boolean;
  min?: number | string;
  max?: number | string;
  default?: unknown;
}
export interface TableSchema {
  id?: string;
  name: string;
  description?: string;
  schemaVersion: number;
  state?: string;
  maintenance?: boolean;
  fields: TableField[];
}
export interface TableSchemaResult {
  table: Omit<TableSchema, "fields">;
  fields: TableField[];
  uniqueRules: UniqueRule[];
  foreignKeys: ForeignKey[];
}
export interface UniqueRule {
  id: string;
  name?: string;
  fieldIds?: string[];
  where?: UniqueRuleCondition;
  fields?: string[];
  state?: string;
  status?: string;
  jobId?: string;
}
export interface Job {
  id: string;
  type?: string;
  kind?: string;
  format?: "csv" | "jsonl";
  state: string;
  stage?: string;
  progress?: { completed: number; total?: number; unit?: string };
  createdAt?: string;
  updatedAt?: string;
  completed?: number;
  total?: number;
  error?: { code?: string; message: string } | string;
  result?: {
    artifactId?: string;
    rowCount?: number;
    rejected?: number;
    inserted?: number;
    updated?: number;
    reportArtifactId?: string;
    databaseId?: string;
  };
}
export interface Artifact {
  id: string;
  filename?: string;
  contentType?: string;
  downloadUrl?: string;
  expiresAt?: string;
  sizeBytes?: number;
}

export const FIELD_TYPES: TableField["type"][] = [
  "text",
  "uri",
  "url",
  "image",
  "integer",
  "float",
  "boolean",
  "date",
  "time",
  "date-time",
  "json",
];
export const SECTION_LABELS: Record<SettingsSection, string> = {
  organisation: "General",
  members: "Members",
  "api-keys": "API Keys",
  "team-api-keys": "API Keys",
  profile: "Profile",
  preferences: "Preferences",
  "email-password": "Email & Password",
  passkeys: "Passkeys",
  sessions: "Sessions",
  "mcp-connections": "MCP Connections",
  mcp: "MCP Guide",
  database: "General",
  "backup-schedule": "Backup Schedule",
  "backup-history": "Backup History",
  "database-danger-zone": "Danger Zone",
  table: "General",
  "table-danger-zone": "Danger Zone",
  fields: "Fields",
  rules: "Unique rules",
  "foreign-keys": "Foreign keys",
  exports: "Export Requests",
};

const ADMIN_SETTINGS: readonly SettingsSection[] = [
  "backup-schedule",
  "backup-history",
  "team-api-keys",
  "organisation",
  "members",
  "database-danger-zone",
  "table-danger-zone",
];

export function canOpenSettings(
  section: SettingsSection,
  role?: string,
): boolean {
  if (!["admin", "member", "viewer"].includes(role ?? "")) return false;
  if (ADMIN_SETTINGS.includes(section)) return role === "admin";
  if (
    ["database", "table", "fields", "rules", "foreign-keys"].includes(section)
  )
    return role !== "viewer";
  return true;
}

export function resolveSettingsSection(
  value: string | null,
): SettingsSection | null {
  const aliases: Record<string, SettingsSection> = {
    "export-requests": "exports",
    security: "passkeys",
    "2fa": "passkeys",
    keys: "api-keys",
    connections: "mcp-connections",
  };
  if (value && aliases[value]) return aliases[value];
  return value && Object.hasOwn(SECTION_LABELS, value)
    ? (value as SettingsSection)
    : null;
}
