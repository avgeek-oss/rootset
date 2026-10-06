import { z } from "zod";
import {
  IdSchema,
  FieldNameSchema,
  FieldTypeSchema,
  JobAcceptedSchema,
  JsonValueSchema,
  PreferencesSchema,
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
export const NotificationSchema = z.strictObject({
  id: IdSchema,
  type: z.enum(["backup.succeeded", "backup.failed", "backup.cancelled"]),
  occurredAt: DateTimeSchema,
  createdAt: DateTimeSchema,
  payload: z.strictObject({
    title: z.string().min(1).max(255),
    message: z.string().max(1024),
    databaseId: IdSchema,
    databaseName: z.string().min(1).max(255),
    backupId: IdSchema,
  }),
  readAt: DateTimeSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;
export const NotificationPageSchema = z.strictObject({
  notifications: z.array(NotificationSchema).max(100),
  unreadCount: z.number().int().nonnegative(),
  nextCursor: z.string().max(2048).nullable(),
});
export type NotificationPage = z.infer<typeof NotificationPageSchema>;
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
  ...timestamps,
});
export const OrganisationSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(255),
  ...timestamps,
});
export const MemberSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  userId: IdSchema,
  name: z.string(),
  email: z.email(),
  role: RoleSchema,
  version: VersionSchema,
  verified: z.boolean(),
  twoFactorEnabled: z.boolean(),
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
  userId: IdSchema,
  prefix: z.string(),
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
export const RowValuesInputSchema = preservingRecordSchema(
  FieldNameSchema,
  JsonValueSchema,
);
export const OperatorRepairReasonSchema = z.string().trim().min(1).max(512);
export const OperatorRepairUpdateSchema = z.strictObject({
  rowId: IdSchema,
  expectedVersion: VersionSchema,
  values: RowValuesInputSchema,
});
export const OperatorRepairIntentSchema = z.strictObject({
  orgId: IdSchema,
  databaseId: IdSchema,
  tableId: IdSchema,
  expectedSchemaVersion: SchemaVersionSchema,
  reason: OperatorRepairReasonSchema,
  updates: z.array(OperatorRepairUpdateSchema).min(1).max(limits.mutationBatch),
});
export type OperatorRepairIntent = z.infer<typeof OperatorRepairIntentSchema>;
export const AccountActionTypeSchema = z.enum([
  "update_member",
  "remove_member",
  "change_password",
  "change_email",
  "register_passkey",
  "remove_passkey",
  "rotate_recovery_codes",
  "sign_out_everywhere",
  "create_key",
  "rotate_key",
  "set_backup_policy",
  "set_history_retention_policy",
  "archive_history",
  "restore_backup",
  "delete_database",
  "delete_table",
  "update_installation_configuration",
  "test_email",
  "operator_repair",
]);
const accountActionFields = {
  id: IdSchema,
  state: z.enum(["pending", "approved", "consumed", "expired", "denied"]),
  expiresAt: DateTimeSchema,
  approvalUrl: z.string(),
};
const pendingRepairIntent = {
  if: {
    properties: { state: { enum: ["pending", "approved"] } },
    required: ["state"],
  },
  then: { required: ["repairIntent"] },
};
export const OperatorRepairAccountActionSchema = z
  .strictObject({
    ...accountActionFields,
    type: z.literal("operator_repair"),
    repairIntent: OperatorRepairIntentSchema.optional(),
    result: JobAcceptedSchema.optional(),
  })
  .superRefine((action, context) => {
    if (
      (action.state === "pending" || action.state === "approved") &&
      !action.repairIntent
    )
      context.addIssue({
        code: "custom",
        message: "Pending operator repair requires its exact requested intent",
        path: ["repairIntent"],
      });
  })
  .meta({ allOf: [pendingRepairIntent] });
export type OperatorRepairAccountAction = z.infer<
  typeof OperatorRepairAccountActionSchema
>;
const repairResultJsonSchema = z.toJSONSchema(JobAcceptedSchema, {
  io: "input",
  target: "draft-2020-12",
});
delete repairResultJsonSchema.$schema;
export const AccountActionSchema = z
  .strictObject({
    ...accountActionFields,
    type: AccountActionTypeSchema,
    repairIntent: OperatorRepairIntentSchema.optional(),
    result: JsonValueSchema.optional(),
  })
  .superRefine((action, context) => {
    if (action.type === "operator_repair") {
      const result = OperatorRepairAccountActionSchema.safeParse(action);
      if (!result.success)
        for (const issue of result.error.issues)
          context.addIssue({
            code: "custom",
            message: issue.message,
            path: issue.path,
          });
    } else if (action.repairIntent)
      context.addIssue({
        code: "custom",
        message: "Repair intent belongs to an operator repair action",
        path: ["repairIntent"],
      });
  })
  .meta({
    allOf: [
      {
        if: {
          properties: { type: { const: "operator_repair" } },
          required: ["type"],
        },
        then: {
          properties: { result: repairResultJsonSchema },
          allOf: [pendingRepairIntent],
        },
        else: { not: { required: ["repairIntent"] } },
      },
    ],
  });
export const ContextSchema = z.strictObject({
  principal: z.strictObject({
    id: z.string(),
    kind: z.string(),
    userId: IdSchema.optional(),
    role: RoleSchema,
  }),
  organisation: OrganisationSchema.nullable(),
  scopes: z.array(z.string()),
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
  FieldNameSchema,
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
  name: FieldNameSchema.optional(),
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
