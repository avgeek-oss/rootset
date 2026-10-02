import { z } from "zod";
import {
  IdSchema,
  ApiKeySchema,
  FieldTypeSchema,
  JsonValueSchema,
  PreferencesSchema,
  ResourceTargetSchema,
  RoleSchema,
  SchemaVersionSchema,
  VersionSchema,
  ViewPreferencesSchema,
  limits,
  preservingRecordSchema,
} from "./models";
import {
  DateTimeSchema,
  FieldDefinitionSchema,
  FieldInputSchema,
} from "./values";
import { QuerySpecSchema } from "./query";

const timestamps = { createdAt: DateTimeSchema, updatedAt: DateTimeSchema };
const byteString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
    "Byte limit exceeds PostgreSQL bigint",
  );
const capacityBase = z.strictObject({
  installationQuotaBytes: byteString.nullable(),
  defaultOrganisationQuotaBytes: byteString.nullable(),
  minimumFreeBytes: byteString.nullable(),
  reportMaxAgeSeconds: z.number().int().min(5).max(3600),
  organisationOverrides: z
    .array(
      z.strictObject({
        orgId: IdSchema,
        quotaBytes: byteString.nullable(),
      }),
    )
    .max(10000),
});
function uniqueOrganisationOverrides(
  value: { organisationOverrides?: { orgId: string }[] },
  context: z.RefinementCtx,
): void {
  const overrides = value.organisationOverrides;
  if (
    overrides &&
    new Set(overrides.map((item) => item.orgId)).size !== overrides.length
  )
    context.addIssue({
      code: "custom",
      message: "Organisation quota overrides must be unique",
      path: ["organisationOverrides"],
    });
}
export const CapacityConfigurationSchema = capacityBase
  .extend({
    installationQuotaBytes:
      capacityBase.shape.installationQuotaBytes.default(null),
    defaultOrganisationQuotaBytes:
      capacityBase.shape.defaultOrganisationQuotaBytes.default(null),
    minimumFreeBytes: capacityBase.shape.minimumFreeBytes.default(null),
    reportMaxAgeSeconds: capacityBase.shape.reportMaxAgeSeconds.default(30),
    organisationOverrides: capacityBase.shape.organisationOverrides.default([]),
  })
  .superRefine(uniqueOrganisationOverrides);
export const CapacityConfigurationPatchSchema = capacityBase
  .partial()
  .superRefine(uniqueOrganisationOverrides);
export type CapacityConfiguration = z.infer<typeof CapacityConfigurationSchema>;
export type CapacityConfigurationPatch = z.infer<
  typeof CapacityConfigurationPatchSchema
>;

const deletionRetentionBase = z.strictObject({
  organisationDays: z.number().int().min(1).max(36500).nullable(),
  accountAuditDays: z.number().int().min(1).max(36500).nullable(),
});
export const DeletionRetentionSchema = deletionRetentionBase.extend({
  organisationDays: deletionRetentionBase.shape.organisationDays.default(null),
  accountAuditDays: deletionRetentionBase.shape.accountAuditDays.default(null),
});
export const DeletionRetentionPatchSchema = deletionRetentionBase.partial();
export type DeletionRetention = z.infer<typeof DeletionRetentionSchema>;
export type DeletionRetentionPatch = z.infer<
  typeof DeletionRetentionPatchSchema
>;
const measuredBytes = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const StorageAdmissionSchema = z.strictObject({
  state: z.enum([
    "available",
    "quota_exceeded",
    "disk_pressure",
    "report_stale",
    "unavailable",
  ]),
  reason: z.string().nullable(),
});
export const CapacityStatusSchema = z.strictObject({
  installation: z.strictObject({
    usedBytes: measuredBytes,
    quotaBytes: measuredBytes.nullable(),
    availableQuotaBytes: measuredBytes.nullable(),
    metric: z.literal("postgresql_database_bytes"),
  }),
  organisation: z
    .strictObject({
      orgId: IdSchema,
      nativeRelationBytes: measuredBytes,
      retainedControlTupleBytes: measuredBytes,
      usedBytes: measuredBytes,
      quotaBytes: measuredBytes.nullable(),
      availableQuotaBytes: measuredBytes.nullable(),
      metric: z.literal("native_relation_and_retained_control_tuple_bytes"),
    })
    .nullable(),
  disk: z.strictObject({
    minimumFreeBytes: measuredBytes.nullable(),
    reportedAvailableBytes: measuredBytes.nullable(),
    reportedTotalBytes: measuredBytes.nullable(),
    headroomClaimsBytes: measuredBytes,
    effectiveAvailableBytes: measuredBytes.nullable(),
    reportedAt: DateTimeSchema.nullable(),
    reportMaxAgeSeconds: z.number().int().min(5).max(3600),
    fresh: z.boolean(),
    volumes: z.array(
      z.strictObject({
        name: z.string(),
        availableBytes: measuredBytes,
        totalBytes: measuredBytes,
      }),
    ),
  }),
  admission: z.strictObject({
    enabled: z.boolean(),
    state: z.enum([
      "available",
      "quota_exceeded",
      "disk_pressure",
      "report_stale",
    ]),
    reason: z.string().nullable(),
  }),
});
export type CapacityStatus = z.infer<typeof CapacityStatusSchema>;
export type StorageAdmission = z.infer<typeof StorageAdmissionSchema>;
export const LifecycleSchema = z.enum([
  "active",
  "creating",
  "maintenance",
  "deleting",
  "deleted",
  "failed",
]);
export const DatabaseSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(4096).nullable().optional(),
  state: LifecycleSchema,
  ...timestamps,
});
export type Database = z.infer<typeof DatabaseSchema>;
export const TableSchema = z.strictObject({
  id: IdSchema,
  databaseId: IdSchema,
  orgId: IdSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(4096).nullable().optional(),
  schemaVersion: SchemaVersionSchema,
  rowCount: z.number().int().min(0).max(limits.maxRows),
  state: LifecycleSchema,
  ...timestamps,
});
export type Table = z.infer<typeof TableSchema>;
export const UniqueRuleSchema = z.strictObject({
  id: IdSchema,
  tableId: IdSchema,
  fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  nullPolicy: z.literal("distinct"),
  state: z.enum(["building", "active", "failed", "deleting"]),
  strategy: z.enum(["native", "registry"]),
  jobId: IdSchema.optional(),
  error: z.string().optional(),
});
export const IndexSchema = z.strictObject({
  id: IdSchema,
  tableId: IdSchema,
  fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  kind: z.enum(["btree", "trigram", "jsonb"]),
  state: z.enum(["building", "active", "failed", "deleting"]),
  jobId: IdSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export const TableSchemaResultSchema = z.strictObject({
  table: TableSchema,
  fields: z.array(FieldDefinitionSchema).max(limits.maxFields),
  uniqueRules: z.array(UniqueRuleSchema).max(limits.maxUniqueRules),
  indexes: z.array(IndexSchema).max(limits.maxIndexes),
  operators: z.record(z.string(), z.array(z.string())),
  limits: z.record(z.string(), z.number()),
  schemaOperationId: IdSchema.optional(),
});
export type TableSchemaResult = z.infer<typeof TableSchemaResultSchema>;
export const ProfileSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(255),
  email: z.email(),
  emailVerified: z.boolean(),
  disabled: z.boolean(),
  ...timestamps,
});
export const OrganisationSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(4096).nullable(),
  state: LifecycleSchema,
  ...timestamps,
});
export const MemberSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  userId: IdSchema,
  name: z.string(),
  email: z.email(),
  role: RoleSchema,
  state: z.enum(["active", "disabled"]),
  version: VersionSchema,
  verified: z.boolean(),
});
export const InvitationSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  email: z.email(),
  role: z.enum(["admin", "editor", "viewer"]),
  state: z.enum(["pending", "accepted", "cancelled", "expired"]),
  expiresAt: DateTimeSchema,
  createdAt: DateTimeSchema,
});
export const KeyMetadataSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  name: z.string().min(1).max(255),
  ownerKind: z.enum(["personal", "team"]),
  userId: IdSchema.optional(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  targets: z.array(ResourceTargetSchema),
  unrestricted: z.boolean().optional(),
  createdAt: DateTimeSchema,
  expiresAt: DateTimeSchema.nullable(),
  revokedAt: DateTimeSchema.nullable(),
  lastUsedAt: DateTimeSchema.nullable(),
});
export const KeyCreatedSchema = z.strictObject({
  key: KeyMetadataSchema,
  secret: z.string().optional(),
  replayed: z.boolean().optional(),
});
export const AccountActionTypeSchema = z.enum([
  "change_password",
  "change_email",
  "register_passkey",
  "remove_passkey",
  "enable_totp",
  "disable_totp",
  "rotate_recovery_codes",
  "delete_account",
  "sign_out_everywhere",
  "transfer_ownership",
  "create_key",
  "rotate_key",
  "set_backup_policy",
  "set_history_retention_policy",
  "archive_history",
  "restore_backup",
  "delete_organisation",
  "delete_database",
  "delete_table",
  "update_installation_configuration",
  "test_email",
]);
export const AccountActionSchema = z.strictObject({
  id: IdSchema,
  type: AccountActionTypeSchema,
  state: z.enum(["pending", "approved", "consumed", "expired", "denied"]),
  expiresAt: DateTimeSchema,
  approvalUrl: z.string(),
  result: JsonValueSchema.optional(),
});
export const ContextSchema = z.strictObject({
  principal: z.strictObject({
    id: z.string(),
    kind: z.string(),
    userId: IdSchema.optional(),
    role: RoleSchema,
    operator: z.boolean(),
  }),
  organisation: OrganisationSchema.nullable(),
  scopes: z.array(z.string()),
  targets: z.array(ResourceTargetSchema),
  profile: ProfileSchema.nullable(),
  preferences: PreferencesSchema.nullable(),
  onboarding: z.strictObject({
    needsEmailVerification: z.boolean(),
    setupComplete: z.boolean(),
  }),
});
export const SessionMetadataSchema = z.strictObject({
  id: IdSchema,
  createdAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  lastActivityAt: DateTimeSchema,
  current: z.boolean(),
  userAgent: z.string().optional(),
});
export const ConnectionSchema = z.strictObject({
  id: IdSchema,
  clientId: z.string(),
  clientName: z.string(),
  orgId: IdSchema,
  audience: z.string(),
  scopes: z.array(z.string()),
  targets: z.array(ResourceTargetSchema),
  createdAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  revokedAt: DateTimeSchema.nullable(),
});
export const CellChangeSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  databaseId: IdSchema,
  tableId: IdSchema,
  rowId: IdSchema,
  fieldId: IdSchema,
  mutationId: IdSchema,
  requestId: z.string(),
  actor: z.strictObject({
    id: z.string(),
    kind: z.string(),
    credentialId: IdSchema.optional(),
    clientId: z.string().optional(),
  }),
  source: z.string(),
  operation: z.enum([
    "create",
    "update",
    "delete",
    "conversion",
    "restore",
    "repair",
  ]),
  before: JsonValueSchema,
  after: JsonValueSchema,
  fieldDefinition: FieldDefinitionSchema,
  previousVersion: VersionSchema.nullable(),
  version: VersionSchema,
  timestamp: DateTimeSchema,
});
export const HistoryPageSchema = z.strictObject({
  data: z.array(CellChangeSchema).max(limits.queryRows),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  retentionGaps: z.array(
    z.strictObject({
      from: DateTimeSchema,
      to: DateTimeSchema,
      archiveId: IdSchema.optional(),
    }),
  ),
});
export const HistoryRetentionPolicySchema = z.strictObject({
  enabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(36500),
  cron: z
    .string()
    .min(9)
    .max(128)
    .refine(
      (value) => value.trim().split(/\s+/).length === 5,
      "Expected a five-field cron",
    ),
  timezone: PreferencesSchema.shape.timezone,
  maxRuntimeSeconds: z.number().int().min(60).max(86400),
  suspension: z
    .strictObject({ code: z.string(), at: DateTimeSchema })
    .optional(),
});
export const HistoryArchiveSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  databaseId: IdSchema,
  tableId: IdSchema,
  jobId: IdSchema,
  artifactId: IdSchema.nullable(),
  state: z.enum([
    "queued",
    "snapshotting",
    "uploading",
    "verifying",
    "purging",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  from: DateTimeSchema.nullable(),
  to: DateTimeSchema,
  createdAt: DateTimeSchema,
  verifiedAt: DateTimeSchema.nullable(),
  cellEvents: z.number().int().safe().nonnegative(),
  rowEvents: z.number().int().safe().nonnegative(),
  sizeBytes: z.number().int().safe().nonnegative().optional(),
  checksum: z.string().optional(),
  manifest: JsonValueSchema.optional(),
  error: z.string().optional(),
});
export const BackupPolicySchema = z.strictObject({
  enabled: z.boolean(),
  cron: z
    .string()
    .min(9)
    .max(128)
    .refine(
      (value) => value.trim().split(/\s+/).length === 5,
      "Expected a five-field cron",
    ),
  timezone: PreferencesSchema.shape.timezone,
  destination: z.literal("installation"),
  retentionDays: z.number().int().min(1).max(3650),
  retentionCount: z.number().int().min(1).max(1000),
  encryption: z.literal(true),
  maxRuntimeSeconds: z.number().int().min(30).max(86400),
  notifications: z.boolean(),
  suspension: z
    .strictObject({
      code: z.string(),
      at: DateTimeSchema,
    })
    .optional(),
});
export const BackupSchema = z.strictObject({
  id: IdSchema,
  databaseId: IdSchema,
  orgId: IdSchema,
  jobId: IdSchema,
  state: z.enum([
    "queued",
    "snapshotting",
    "uploading",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  createdAt: DateTimeSchema,
  verifiedAt: DateTimeSchema.nullable(),
  sizeBytes: z.number().int().nonnegative().optional(),
  checksum: z.string().optional(),
  manifest: JsonValueSchema.optional(),
  error: z.string().optional(),
  notificationState: z
    .enum(["pending", "sent", "failed", "disabled"])
    .optional(),
  cleanupError: z
    .strictObject({ code: z.string(), message: z.string() })
    .optional(),
});
export const ArtifactSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  kind: z.enum(["import", "export", "report", "backup", "history_archive"]),
  format: z.enum(["csv", "jsonl", "json", "archive"]),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string(),
  expiresAt: DateTimeSchema,
  downloadUrl: z.string().optional(),
  resourceUri: z.string().optional(),
  rowCount: z.number().int().nonnegative().optional(),
});
export const ArtifactUploadResultSchema = z.strictObject({
  artifactId: IdSchema,
  byteLength: z.number().int().min(1).max(134217728),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ImportMappingSchema = preservingRecordSchema(
  z.string().min(1).max(255),
  z.string().min(1).max(64),
);
export const SchemaChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("add_field"),
    field: z.record(z.string(), JsonValueSchema),
  }),
  z.strictObject({
    kind: z.literal("update_field"),
    fieldId: IdSchema,
    changes: z.record(z.string(), JsonValueSchema),
    conversion: z.enum(["explicit", "lossless"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("delete_field"),
    fieldId: IdSchema,
    removeDependencies: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("reorder_fields"),
    fieldIds: z.array(IdSchema).max(limits.maxFields),
  }),
]);
export const FieldChangesSchema = z.strictObject({
  apiKey: ApiKeySchema.optional(),
  label: z.string().min(1).max(255).optional(),
  type: FieldTypeSchema.optional(),
  required: z.boolean().optional(),
  default: JsonValueSchema.optional(),
  charLimit: z.number().int().min(1).max(limits.rowBytes).optional(),
  min: z.union([z.number().finite(), z.string()]).optional(),
  max: z.union([z.number().finite(), z.string()]).optional(),
  order: z
    .number()
    .int()
    .min(0)
    .max(limits.maxFields - 1)
    .optional(),
});
const journalNames = {
  name: z.string().min(1).max(255),
  description: z.string().max(4096).nullable().optional(),
};
const journalOptionalNames = {
  name: journalNames.name.optional(),
  description: journalNames.description,
};
export const SchemaJournalRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("database.create"), ...journalNames }),
  z.strictObject({
    kind: z.literal("database.update"),
    ...journalOptionalNames,
  }),
  z.strictObject({ kind: z.literal("database.delete") }),
  z.strictObject({
    kind: z.literal("table.create"),
    ...journalNames,
    fields: z.array(FieldInputSchema).max(limits.maxFields),
  }),
  z.strictObject({ kind: z.literal("table.update"), ...journalOptionalNames }),
  z.strictObject({ kind: z.literal("table.delete") }),
  z.strictObject({ kind: z.literal("field.create"), field: FieldInputSchema }),
  z.strictObject({
    kind: z.literal("field.update"),
    fieldId: IdSchema.optional(),
    changes: FieldChangesSchema,
  }),
  z.strictObject({
    kind: z.literal("field.convert"),
    fieldId: IdSchema.optional(),
    changes: FieldChangesSchema,
    conversion: z.enum(["explicit", "lossless"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("field.delete"),
    fieldId: IdSchema.optional(),
    removeDependencies: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("fields.reorder"),
    fieldIds: z.array(IdSchema).max(limits.maxFields),
  }),
  z.strictObject({
    kind: z.literal("rule.create"),
    fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
    name: journalNames.name.optional(),
  }),
  z.strictObject({ kind: z.literal("rule.delete"), id: IdSchema.optional() }),
  z.strictObject({
    kind: z.literal("index.create"),
    fieldIds: z.array(IdSchema).length(1),
    indexKind: z.enum(["btree", "trigram", "jsonb"]),
  }),
  z.strictObject({ kind: z.literal("index.delete"), id: IdSchema.optional() }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export const SchemaOperationReportSchema = z.strictObject({
  id: IdSchema,
  databaseId: IdSchema,
  tableId: IdSchema.nullable(),
  kind: z.string().min(1).max(128),
  state: z.string().min(1).max(64),
  phase: z.enum([
    "planned",
    "running",
    "committed",
    "failed",
    "historical",
    "unknown",
  ]),
  expectedSchemaVersion: SchemaVersionSchema.nullable(),
  request: SchemaJournalRequestSchema,
  before: z
    .strictObject({
      table: TableSchema,
      fields: z.array(FieldDefinitionSchema).max(limits.maxFields),
    })
    .nullable(),
  change: SchemaChangeSchema.optional(),
  verification: z.strictObject({
    transactional: z.boolean().optional(),
    fieldId: IdSchema.optional(),
    indexId: IdSchema.optional(),
    nextField: FieldDefinitionSchema.optional(),
  }),
  createdAt: DateTimeSchema,
  committedAt: DateTimeSchema.nullable(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
    })
    .optional(),
  jobId: IdSchema.optional(),
});
export type SchemaJournalRequest = z.infer<typeof SchemaJournalRequestSchema>;
export type SchemaOperationReport = z.infer<typeof SchemaOperationReportSchema>;
export const ViewPreferencesResultSchema = z.strictObject({
  tableId: IdSchema,
  preferences: ViewPreferencesSchema,
});
export const ExportSpecSchema = z.strictObject({
  format: z.enum(["csv", "jsonl"]),
  query: QuerySpecSchema.optional(),
  spreadsheetSafe: z.boolean().optional(),
});
