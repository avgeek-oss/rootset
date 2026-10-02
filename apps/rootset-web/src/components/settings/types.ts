import type { ConnectionSchema } from "@rootset/contracts";
import type { z } from "zod";

export type SettingsSection =
  | "organisation"
  | "members"
  | "grants"
  | "keys"
  | "profile"
  | "preferences"
  | "security"
  | "sessions"
  | "connections"
  | "audit"
  | "database"
  | "table"
  | "fields"
  | "rules"
  | "indexes"
  | "backups"
  | "imports"
  | "exports"
  | "jobs"
  | "operator";

export interface SettingsPanelProps {
  section: SettingsSection;
  orgId: string;
  databaseId?: string;
  tableId?: string;
  onClose: () => void;
  onChanged?: () => void;
}

export interface Organisation {
  id: string;
  name: string;
  description?: string;
  state?: string;
}
export interface Profile {
  id: string;
  name?: string;
  displayName?: string;
  email: string;
  emailVerified?: boolean;
}
export interface Preferences {
  timezone: string;
  locale: string;
  dateFormat: string;
  timeFormat: "12h" | "24h";
  theme: "system" | "light" | "dark";
}
export interface Member {
  id: string;
  userId: string;
  name?: string;
  email: string;
  role: string;
  state?: string;
  disabled?: boolean;
  version: string;
  verified: boolean;
}
export interface Invitation {
  id: string;
  email: string;
  role: string;
  status?: string;
  state?: string;
  expiresAt?: string;
}
export interface Grant {
  id?: string;
  membershipId?: string;
  principalId?: string;
  targetType: "database" | "table";
  targetId: string;
  level: "read" | "edit" | "manage";
}
export interface ApiKey {
  id: string;
  name: string;
  prefix?: string;
  ownerKind?: string;
  scopes: string[];
  targets?: ResourceTarget[];
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}
export interface ResourceTarget {
  databaseId?: string;
  tableId?: string;
  level: "read" | "edit" | "manage";
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
  totpEnabled?: boolean;
  recoveryCodesRemaining?: number;
  passkeys?: Passkey[];
}
export interface TableField {
  id: string;
  apiKey: string;
  label: string;
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
export interface BackupPolicy {
  enabled: boolean;
  cron: string;
  timezone: string;
  retentionDays: number;
  retentionCount: number;
  maxRuntimeSeconds: number;
  destination: "installation";
  encryption: true;
  notifications: boolean;
  nextRunAt?: string;
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
export interface AuditEvent {
  id: string;
  operation?: string;
  operationId?: string;
  actorId?: string;
  actorKind?: string;
  targetId?: string;
  target?: unknown;
  outcome?: unknown;
  createdAt?: string;
  timestamp?: string;
  requestId?: string;
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
  organisation: "Organisation",
  members: "People and invitations",
  grants: "Resource access",
  keys: "API keys",
  profile: "Your profile",
  preferences: "Viewing preferences",
  security: "Security",
  sessions: "Browser sessions",
  connections: "Connected applications",
  audit: "Organisation audit",
  database: "Database settings",
  table: "Table settings",
  fields: "Fields",
  rules: "Unique rules",
  indexes: "Search indexes",
  backups: "Database backups",
  imports: "Import rows",
  exports: "Export rows",
  jobs: "Jobs",
  operator: "Installation settings",
};
