import type {
  ConnectionSchema,
  Preferences as AccountPreferences,
} from "@rootset/contracts";
import type { z } from "zod";

export type SettingsSection =
  | "organisation"
  | "members"
  | "api-keys"
  | "profile"
  | "preferences"
  | "email-password"
  | "passkeys"
  | "sessions"
  | "mcp-connections"
  | "mcp"
  | "database"
  | "table"
  | "fields"
  | "rules"
  | "indexes"
  | "backups"
  | "imports"
  | "exports";

export interface SettingsPanelProps {
  section: SettingsSection;
  orgId: string;
  role?: string;
  databaseId?: string;
  tableId?: string;
  theme?: Preferences["theme"];
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
    | "integer"
    | "float"
    | "boolean"
    | "date"
    | "time"
    | "date-time"
    | "json";
  required?: boolean;
  charLimit?: number;
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
  indexes: TableIndex[];
}
export interface UniqueRule {
  id: string;
  name?: string;
  fieldIds?: string[];
  fields?: string[];
  state?: string;
  status?: string;
  jobId?: string;
}
export interface TableIndex {
  id: string;
  name?: string;
  fieldIds?: string[];
  fields?: string[];
  kind: string;
  state?: string;
  status?: string;
  jobId?: string;
}
export interface Job {
  id: string;
  type?: string;
  kind?: string;
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
    rejected?: number;
    inserted?: number;
    updated?: number;
    reportArtifactId?: string;
    databaseId?: string;
  };
}
export interface Backup {
  id: string;
  state: string;
  createdAt?: string;
  verifiedAt?: string;
  rowCount?: number;
  sizeBytes?: number;
  jobId?: string;
  error?: string;
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
  profile: "Profile",
  preferences: "Preferences",
  "email-password": "Email & Password",
  passkeys: "Passkeys",
  sessions: "Sessions",
  "mcp-connections": "MCP Connections",
  mcp: "MCP Guide",
  database: "Database settings",
  table: "Table settings",
  fields: "Fields",
  rules: "Unique rules",
  indexes: "Search indexes",
  backups: "Database backups",
  imports: "Import rows",
  exports: "Export rows",
};

const ADMIN_SETTINGS: readonly SettingsSection[] = [
  "organisation",
  "members",
  "database",
  "table",
  "fields",
  "rules",
  "indexes",
  "backups",
];

export function canOpenSettings(
  section: SettingsSection,
  role?: string,
): boolean {
  if (!["admin", "member", "viewer"].includes(role ?? "")) return false;
  if (ADMIN_SETTINGS.includes(section)) return role === "admin";
  if (section === "imports") return role === "admin" || role === "member";
  return true;
}

export function resolveSettingsSection(
  value: string | null,
): SettingsSection | null {
  const aliases: Record<string, SettingsSection> = {
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
