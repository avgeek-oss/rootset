import { UniqueRuleConditionSchema } from "./unique-rules";
import { z } from "zod";
import {
  AccountNameSchema,
  IdSchema,
  FieldNameSchema,
  FieldTypeSchema,
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
  AllowedValuesSchema,
  DateTimeSchema,
  FieldDefinitionSchema,
  FieldInputSchema,
} from "./values";

export const RowCommentSchema = z.strictObject({
  id: IdSchema,
  rowId: IdSchema,
  authorUserId: IdSchema.nullable(),
  authorName: z.string().max(120),
  body: z.string().max(4096),
  createdAt: DateTimeSchema,
  deletedAt: DateTimeSchema.nullable(),
  canDelete: z.boolean(),
});
export type RowComment = z.infer<typeof RowCommentSchema>;

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
export const DatabaseSummarySchema = DatabaseSchema.extend({
  tableCount: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  lastDataChangeAt: DateTimeSchema.nullable(),
});
export type DatabaseSummary = z.infer<typeof DatabaseSummarySchema>;

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
export const TableSummarySchema = TableSchema.extend({
  fieldCount: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  lastDataChangeAt: DateTimeSchema.nullable(),
});
export type TableSummary = z.infer<typeof TableSummarySchema>;
export const UniqueRuleSchema = z.strictObject({
  id: IdSchema,
  tableId: IdSchema,
  fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  where: UniqueRuleConditionSchema.optional(),
  nullPolicy: z.literal("distinct"),
  state: z.enum(["building", "active", "failed", "deleting"]),
  strategy: z.enum(["native", "registry"]),
  jobId: IdSchema.optional(),
  error: z.string().optional(),
});
export const ForeignKeySchema = z.strictObject({
  id: IdSchema,
  tableId: IdSchema,
  fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  referencedTableId: IdSchema,
  referencedTableName: z.string(),
  referencedRuleId: IdSchema,
  referencedFieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  referencedFieldNames: z.array(z.string()).min(1).max(limits.maxUniqueFields),
  state: z.literal("active"),
});
export type ForeignKey = z.infer<typeof ForeignKeySchema>;
export const TableSchemaResultSchema = z.strictObject({
  table: TableSchema,
  fields: z.array(FieldDefinitionSchema).max(limits.maxFields),
  uniqueRules: z.array(UniqueRuleSchema).max(limits.maxUniqueRules),
  foreignKeys: z.array(ForeignKeySchema).max(limits.maxForeignKeys),
  operators: z.record(z.string(), z.array(z.string())),
  limits: z.record(z.string(), z.number()),
  schemaOperationId: IdSchema.optional(),
});
export type TableSchemaResult = z.infer<typeof TableSchemaResultSchema>;
export const ProfileSchema = z.strictObject({
  id: IdSchema,
  name: AccountNameSchema,
  email: z.email(),
  emailVerified: z.boolean(),
  ...timestamps,
});
export const OrganisationSchema = z.strictObject({
  id: IdSchema,
  name: AccountNameSchema,
  ...timestamps,
});
export const MemberSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  userId: IdSchema,
  name: AccountNameSchema,
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
  role: z.enum(["admin", "member", "viewer"]),
  state: z.enum(["pending", "accepted", "cancelled", "expired"]),
  expiresAt: DateTimeSchema,
  createdAt: DateTimeSchema,
});
export const KeyMetadataSchema = z.strictObject({
  scope: z.enum(["personal", "team"]),
  access: z.enum(["read", "edit"]),
  includeAdmin: z.boolean(),
  id: IdSchema,
  orgId: IdSchema,
  name: AccountNameSchema,
  userId: IdSchema.nullable(),
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
  operation: z.enum(["create", "update", "delete", "conversion", "repair"]),
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
});

export const ArtifactSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  kind: z.enum(["export", "import_report"]),
  format: z.enum(["csv", "jsonl", "json", "zip"]),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string(),
  expiresAt: DateTimeSchema,
  downloadUrl: z.string().optional(),
  resourceUri: z.string().optional(),
  rowCount: z.number().int().nonnegative().optional(),
  tableCount: z.number().int().nonnegative().optional(),
});
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
  autoIncrement: z.boolean().optional(),
  clearDefault: z.boolean().optional(),
  allowedValues: AllowedValuesSchema.nullable().optional(),
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
    where: UniqueRuleConditionSchema.optional(),
    name: journalNames.name.optional(),
  }),
  z.strictObject({ kind: z.literal("rule.delete"), id: IdSchema.optional() }),
  z.strictObject({
    kind: z.literal("foreign-key.create"),
    fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
    referencedTableId: IdSchema,
    referencedRuleId: IdSchema,
    expectedReferencedSchemaVersion: SchemaVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("foreign-key.delete"),
    id: IdSchema.optional(),
  }),
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
});
