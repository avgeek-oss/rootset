import { z } from "zod";
import { OperationalMetricsSchema } from "@rootset/observability/schema";
import {
  ActorSchema,
  IdSchema,
  JobAcceptedSchema,
  JobSchema,
  JsonValueSchema,
  PreferencesSchema,
  QueryResultSchema,
  ResourceTargetSchema,
  RoleSchema,
  RowSchema,
  SchemaVersionSchema,
  StorageErrorCodeSchema,
  VersionSchema,
  ViewPreferencesSchema,
  limits,
  type Role,
} from "./models";
import {
  DateTimeSchema,
  FieldDefinitionSchema,
  FieldInputSchema,
} from "./values";
import { QuerySpecSchema } from "./query";
import {
  AccountActionSchema,
  AccountActionTypeSchema,
  ArtifactSchema,
  BackupPolicySchema,
  BackupSchema,
  ConnectionSchema,
  ContextSchema,
  DatabaseSchema,
  HistoryPageSchema,
  HistoryRetentionPolicySchema,
  HistoryArchiveSchema,
  CapacityConfigurationSchema,
  CapacityStatusSchema,
  CapacityConfigurationPatchSchema,
  DeletionRetentionSchema,
  DeletionRetentionPatchSchema,
  StorageAdmissionSchema,
  ImportMappingSchema,
  IndexSchema,
  InvitationSchema,
  KeyCreatedSchema,
  KeyMetadataSchema,
  MemberSchema,
  OrganisationSchema,
  OperatorRepairReasonSchema,
  OperatorRepairUpdateSchema,
  ProfileSchema,
  RowValuesInputSchema,
  SchemaChangeSchema,
  SchemaOperationReportSchema,
  SessionMetadataSchema,
  TableSchema,
  TableSchemaResultSchema,
  UniqueRuleSchema,
  ViewPreferencesResultSchema,
} from "./resources";

export interface OperationDefinition {
  id: string;
  toolName: string;
  path: string;
  httpMethod: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  scopes: string[];
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  idempotencyRequired: boolean;
  stepUp: "never" | "conditional" | "required";
  job: boolean;
  personal: boolean;
  operator: boolean;
  minimumRole: Role;
  resource: "none" | "organisation" | "database" | "table";
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  description: string;
  tags: string[];
  auditEvent: string | null;
  errors: string[];
  successStatus: number;
  example: Record<string, unknown>;
}
const org = { orgId: IdSchema };
const database = { ...org, databaseId: IdSchema };
const table = { ...database, tableId: IdSchema };
const expected = { expectedSchemaVersion: SchemaVersionSchema };
const approval = { approvalId: IdSchema.optional() };
const paging = {
  limit: z.number().int().min(1).max(limits.queryRows).optional(),
  cursor: z.string().max(131200).nullable().optional(),
};
const jobPaging = {
  ...paging,
  limit: z.number().int().min(1).max(100).optional(),
};
const names = {
  name: z.string().min(1).max(255),
  description: z.string().max(4096).nullable().optional(),
};
const values = RowValuesInputSchema;
const empty = z.strictObject({});
const outcome = z.strictObject({
  mutationId: IdSchema,
  replayed: z.boolean().optional(),
  result: JsonValueSchema.optional(),
});
const deleted = z.strictObject({
  deleted: z.boolean(),
  mutationId: IdSchema.optional(),
});
const list = (schema: z.ZodType) =>
  z.strictObject({
    data: z.array(schema),
    nextCursor: z.string().nullable().optional(),
    hasMore: z.boolean().optional(),
  });
const jobOr = (schema: z.ZodType) => z.union([schema, JobAcceptedSchema]);
const O = "/v1/orgs/{orgId}",
  D = `${O}/databases/{databaseId}`,
  T = `${D}/tables/{tableId}`;

type Settings = Partial<
  Pick<
    OperationDefinition,
    | "readOnly"
    | "destructive"
    | "idempotent"
    | "idempotencyRequired"
    | "stepUp"
    | "job"
    | "personal"
    | "operator"
    | "minimumRole"
    | "resource"
    | "successStatus"
    | "example"
  >
>;
const definitions: OperationDefinition[] = [];
function operation(
  id: string,
  tool: string,
  method: OperationDefinition["httpMethod"],
  path: string,
  scopes: string[],
  inputSchema: z.ZodType,
  outputSchema: z.ZodType,
  description: string,
  settings: Settings = {},
): void {
  const readOnly = settings.readOnly ?? method === "GET";
  const group = path.includes("/installation")
    ? "installation"
    : path.includes("/backups") || path.includes("/backup-policy")
      ? "backups"
      : path.includes("/imports") ||
          path.includes("/exports") ||
          path.includes("/artifacts")
        ? "artifacts"
        : path.includes("/jobs")
          ? "jobs"
          : path.includes("/rows") ||
              path.includes("/query") ||
              path.includes("/count") ||
              path.includes("/history") ||
              path.includes("/statistics")
            ? "data"
            : path.includes("/tables")
              ? "schema"
              : path.includes("/databases")
                ? "databases"
                : "accounts";
  definitions.push({
    id,
    toolName: `rootset_${tool}`,
    httpMethod: method,
    path,
    scopes,
    inputSchema,
    outputSchema,
    description,
    readOnly,
    destructive: method === "DELETE",
    idempotent: readOnly || method === "DELETE" || method === "PUT",
    idempotencyRequired: !readOnly,
    stepUp: "never",
    job: false,
    personal: false,
    operator: false,
    minimumRole:
      readOnly || settings.personal || settings.operator ? "viewer" : "editor",
    resource: path.includes("{tableId}")
      ? "table"
      : path.includes("{databaseId}")
        ? "database"
        : path.includes("{orgId}")
          ? "organisation"
          : "none",
    tags: [group],
    auditEvent: readOnly ? null : id,
    errors: [
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "ACCESS_DENIED",
      "FORBIDDEN",
      "INSUFFICIENT_SCOPE",
      ...(settings.personal ? ["PERSONAL_IDENTITY_REQUIRED"] : []),
      ...(settings.operator ? ["OPERATOR_REQUIRED"] : []),
      ...(id === "mutateRows"
        ? ["PERSONAL_IDENTITY_REQUIRED", "OPERATOR_REQUIRED"]
        : []),
      ...(settings.stepUp && settings.stepUp !== "never"
        ? ["STEP_UP_REQUIRED"]
        : []),
      ...([
        "createPersonalKey",
        "rotatePersonalKey",
        "createTeamKey",
        "rotateTeamKey",
        "updateGrants",
      ].includes(id)
        ? ["DELEGATION_EXCEEDS_AUTHORITY"]
        : []),
      "RESOURCE_NOT_FOUND",
      "DEPENDENCY_UNAVAILABLE",
      "REQUEST_TIMEOUT",
      ...(!readOnly
        ? ["IDEMPOTENCY_CONFLICT", ...StorageErrorCodeSchema.options]
        : []),
    ],
    successStatus: method === "POST" && !readOnly ? 201 : 200,
    example: {},
    ...settings,
  });
}

operation(
  "getContext",
  "get_context",
  "GET",
  "/v1/me",
  [],
  empty,
  ContextSchema,
  "Get the caller, selected organisation, current permissions and preferences.",
);
operation(
  "getProfile",
  "get_profile",
  "GET",
  "/v1/me/profile",
  ["profile:manage"],
  empty,
  ProfileSchema,
  "Read your profile.",
  { personal: true },
);
operation(
  "updateProfile",
  "update_profile",
  "PATCH",
  "/v1/me/profile",
  ["profile:manage"],
  z.strictObject({ name: names.name }),
  ProfileSchema,
  "Update your display name.",
  { personal: true },
);
operation(
  "getPreferences",
  "get_preferences",
  "GET",
  "/v1/me/preferences",
  ["profile:manage"],
  empty,
  PreferencesSchema,
  "Read viewing preferences.",
  { personal: true },
);
operation(
  "updatePreferences",
  "update_preferences",
  "PATCH",
  "/v1/me/preferences",
  ["profile:manage"],
  PreferencesSchema.partial(),
  PreferencesSchema,
  "Update timezone, locale, format or theme preferences.",
  { personal: true },
);
operation(
  "getPreferenceOptions",
  "get_preference_options",
  "GET",
  "/v1/preferences/options",
  [],
  empty,
  z.strictObject({
    timezones: z.array(z.string()),
    locales: z.array(z.string()),
    dateFormats: z.array(z.string()),
    timeFormats: z.array(z.string()),
    themes: z.array(z.string()),
  }),
  "List supported preference values.",
);
operation(
  "previewPreferences",
  "preview_preferences",
  "POST",
  "/v1/me/preferences/preview",
  [],
  z.strictObject({ preferences: PreferencesSchema, value: DateTimeSchema }),
  z.strictObject({
    utc: DateTimeSchema,
    displayed: z.string(),
    timezone: z.string(),
  }),
  "Preview a UTC instant with proposed viewing preferences.",
  { readOnly: true, idempotencyRequired: false },
);
operation(
  "listSessions",
  "list_sessions",
  "GET",
  "/v1/me/sessions",
  ["account:security"],
  empty,
  list(SessionMetadataSchema),
  "List your active browser sessions without session secrets.",
  { personal: true },
);
operation(
  "revokeSession",
  "revoke_session",
  "DELETE",
  "/v1/me/sessions/{id}",
  ["account:security"],
  z.strictObject({ id: IdSchema, ...approval }),
  deleted,
  "Revoke an owned browser session.",
  { personal: true },
);
operation(
  "listConnections",
  "list_connections",
  "GET",
  "/v1/me/connections",
  ["account:security"],
  empty,
  list(ConnectionSchema),
  "List your delegated OAuth connections.",
  { personal: true },
);
operation(
  "revokeConnection",
  "revoke_connection",
  "DELETE",
  "/v1/me/connections/{id}",
  ["account:security"],
  z.strictObject({ id: IdSchema }),
  deleted,
  "Revoke an owned OAuth grant and refresh family.",
  { personal: true },
);
operation(
  "beginAccountAction",
  "begin_account_action",
  "POST",
  "/v1/me/actions",
  [],
  z.strictObject({
    type: AccountActionTypeSchema,
    operationId: z.string().optional(),
    input: JsonValueSchema,
    ...org,
  }),
  AccountActionSchema,
  "Start a bound sensitive action requiring browser approval.",
  { personal: true },
);
operation(
  "getAccountAction",
  "get_account_action",
  "GET",
  "/v1/me/actions/{id}",
  [],
  z.strictObject({ id: IdSchema }),
  AccountActionSchema,
  "Inspect an owned action approval without factor secrets.",
  { personal: true },
);
operation(
  "completeAccountAction",
  "complete_account_action",
  "POST",
  "/v1/me/actions/{id}/complete",
  [],
  z.strictObject({ id: IdSchema }),
  AccountActionSchema,
  "Consume approval and complete exactly the bound action.",
  { personal: true, stepUp: "required", destructive: true },
);
operation(
  "listOrganisations",
  "list_organisations",
  "GET",
  "/v1/orgs",
  [],
  empty,
  list(OrganisationSchema),
  "List organisations currently accessible to the caller.",
);
operation(
  "getOrganisation",
  "get_organisation",
  "GET",
  O,
  ["org:read"],
  z.strictObject(org),
  OrganisationSchema,
  "Read an authorised organisation.",
);
operation(
  "updateOrganisation",
  "update_organisation",
  "PATCH",
  O,
  ["org:manage"],
  z.strictObject({ ...org, ...names }),
  OrganisationSchema,
  "Update organisation name and description.",
  { minimumRole: "admin" },
);
operation(
  "transferOwnership",
  "transfer_ownership",
  "POST",
  `${O}/ownership-transfer`,
  ["ownership:manage"],
  z.strictObject({ ...org, userId: IdSchema, ...approval }),
  OrganisationSchema,
  "Transfer ownership to an enabled verified member.",
  { minimumRole: "owner", personal: true, stepUp: "required" },
);
operation(
  "deleteOrganisation",
  "delete_organisation",
  "DELETE",
  O,
  ["ownership:manage"],
  z.strictObject({ ...org, ...approval }),
  JobAcceptedSchema,
  "Start approved organisation deletion with retention handling.",
  {
    minimumRole: "owner",
    personal: true,
    stepUp: "required",
    job: true,
    successStatus: 202,
  },
);
operation(
  "listMembers",
  "list_members",
  "GET",
  `${O}/members`,
  ["members:read"],
  z.strictObject({ ...org, ...paging }),
  list(MemberSchema),
  "List organisation members.",
  { minimumRole: "admin" },
);
operation(
  "updateMember",
  "update_member",
  "PATCH",
  `${O}/members/{id}`,
  ["members:manage"],
  z.strictObject({
    ...org,
    id: IdSchema,
    role: RoleSchema.optional(),
    state: z.enum(["active", "disabled"]).optional(),
    expectedVersion: VersionSchema,
    ...approval,
  }),
  MemberSchema,
  "Change membership authority while preserving the verified-owner invariant.",
  { minimumRole: "admin", stepUp: "conditional" },
);
operation(
  "removeMember",
  "remove_member",
  "DELETE",
  `${O}/members/{id}`,
  ["members:manage"],
  z.strictObject({
    ...org,
    id: IdSchema,
    expectedVersion: VersionSchema,
    ...approval,
  }),
  deleted,
  "Remove a member and invalidate delegated access.",
  { minimumRole: "admin", stepUp: "conditional" },
);
operation(
  "listInvitations",
  "list_invitations",
  "GET",
  `${O}/invitations`,
  ["members:manage"],
  z.strictObject({ ...org, ...paging }),
  list(InvitationSchema),
  "List redacted organisation invitations.",
  { minimumRole: "admin" },
);
operation(
  "inviteMember",
  "invite_member",
  "POST",
  `${O}/invitations`,
  ["members:manage"],
  z.strictObject({
    ...org,
    email: z.email(),
    role: z.enum(["admin", "editor", "viewer"]),
  }),
  InvitationSchema,
  "Invite a member as a personal Owner or Admin with email proof; invitations cannot create owners.",
  { minimumRole: "admin", personal: true },
);
operation(
  "cancelInvitation",
  "cancel_invitation",
  "DELETE",
  `${O}/invitations/{id}`,
  ["members:manage"],
  z.strictObject({ ...org, id: IdSchema }),
  deleted,
  "Cancel an invitation before acceptance.",
  { minimumRole: "admin" },
);
const grantSchema = z.strictObject({
  membershipId: IdSchema,
  unrestricted: z.boolean(),
  targets: z.array(ResourceTargetSchema),
  version: SchemaVersionSchema,
});
operation(
  "getGrants",
  "get_grants",
  "GET",
  `${O}/grants`,
  ["grants:manage"],
  z.strictObject(org),
  list(grantSchema),
  "Read current organisation resource grants.",
  { minimumRole: "admin" },
);
operation(
  "updateGrants",
  "update_grants",
  "PATCH",
  `${O}/grants`,
  ["grants:manage"],
  z.strictObject({ ...org, grants: z.array(grantSchema).max(1000) }),
  list(grantSchema),
  "Replace bounded member grants without raising organisation role ceilings.",
  { minimumRole: "admin" },
);
operation(
  "queryOrganisationAudit",
  "query_organisation_audit",
  "POST",
  `${O}/audit/query`,
  ["audit:read"],
  z.strictObject({
    ...org,
    ...paging,
    from: DateTimeSchema.optional(),
    to: DateTimeSchema.optional(),
    operationId: z.string().optional(),
    actorId: z.string().optional(),
    databaseId: IdSchema.optional(),
    tableId: IdSchema.optional(),
  }),
  list(
    z.strictObject({
      id: IdSchema,
      operationId: z.string(),
      actorId: z.string(),
      timestamp: DateTimeSchema,
      target: JsonValueSchema,
      outcome: JsonValueSchema,
    }),
  ),
  "Query redacted organisation audit within current target grants.",
  { readOnly: true, idempotencyRequired: false },
);
const keyInput = {
  name: names.name,
  scopes: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(64)
    .refine(
      (value) => value.every((scope) => scopeNames.includes(scope)),
      "Unknown operation scope",
    )
    .refine(
      (value) => new Set(value).size === value.length,
      "Scopes must be distinct",
    ),
  targets: z.array(ResourceTargetSchema).max(200),
  unrestricted: z.boolean().optional(),
  expiresAt: DateTimeSchema.nullable().optional(),
  ...approval,
};
operation(
  "listPersonalKeys",
  "list_personal_keys",
  "GET",
  "/v1/me/keys",
  ["keys:manage"],
  empty,
  list(KeyMetadataSchema),
  "List metadata for your personal keys.",
  { personal: true },
);
operation(
  "createPersonalKey",
  "create_personal_key",
  "POST",
  "/v1/me/keys",
  ["keys:manage"],
  z.strictObject({ ...org, ...keyInput }),
  KeyCreatedSchema,
  "Create a personal key within effective authority; secret appears once.",
  { personal: true, stepUp: "conditional" },
);
operation(
  "rotatePersonalKey",
  "rotate_personal_key",
  "POST",
  "/v1/me/keys/{id}/rotate",
  ["keys:manage"],
  z.strictObject({
    id: IdSchema,
    overlapSeconds: z.number().int().min(0).max(86400).optional(),
    ...approval,
  }),
  KeyCreatedSchema,
  "Rotate a personal key with bounded overlap and one-time secret display.",
  { personal: true, stepUp: "conditional" },
);
operation(
  "revokePersonalKey",
  "revoke_personal_key",
  "DELETE",
  "/v1/me/keys/{id}",
  ["keys:manage"],
  z.strictObject({ id: IdSchema }),
  deleted,
  "Revoke an owned personal key.",
  { personal: true },
);
operation(
  "listTeamKeys",
  "list_team_keys",
  "GET",
  `${O}/keys`,
  ["keys:manage"],
  z.strictObject(org),
  list(KeyMetadataSchema),
  "List organisation service-principal keys.",
  { minimumRole: "admin" },
);
operation(
  "createTeamKey",
  "create_team_key",
  "POST",
  `${O}/keys`,
  ["keys:manage"],
  z.strictObject({ ...org, ...keyInput }),
  KeyCreatedSchema,
  "Create a team key independent of its creator membership.",
  { minimumRole: "admin", stepUp: "required" },
);
operation(
  "rotateTeamKey",
  "rotate_team_key",
  "POST",
  `${O}/keys/{id}/rotate`,
  ["keys:manage"],
  z.strictObject({
    ...org,
    id: IdSchema,
    overlapSeconds: z.number().int().min(0).max(86400).optional(),
    ...approval,
  }),
  KeyCreatedSchema,
  "Rotate an organisation service key with approved bounded overlap.",
  { minimumRole: "admin", stepUp: "required" },
);
operation(
  "revokeTeamKey",
  "revoke_team_key",
  "DELETE",
  `${O}/keys/{id}`,
  ["keys:manage"],
  z.strictObject({ ...org, id: IdSchema }),
  deleted,
  "Revoke a team key.",
  { minimumRole: "admin" },
);
operation(
  "getSecurityStatus",
  "get_security_status",
  "GET",
  "/v1/me/security",
  ["account:security"],
  empty,
  z.strictObject({
    twoFactorEnabled: z.boolean(),
    recoveryCodesRemaining: z.number().int().nonnegative(),
    passkeys: z.array(
      z.strictObject({
        id: IdSchema,
        name: z.string(),
        createdAt: DateTimeSchema,
        lastUsedAt: DateTimeSchema.nullable(),
      }),
    ),
  }),
  "Read factor status and credential metadata only.",
  { personal: true },
);

operation(
  "listDatabases",
  "list_databases",
  "GET",
  `${O}/databases`,
  ["databases:read"],
  z.strictObject({ ...org, ...paging }),
  list(DatabaseSchema),
  "List accessible logical databases.",
);
operation(
  "createDatabase",
  "create_database",
  "POST",
  `${O}/databases`,
  ["databases:manage"],
  z.strictObject({ ...org, ...names }),
  DatabaseSchema,
  "Create a logical database with a managed PostgreSQL namespace.",
  { minimumRole: "editor" },
);
operation(
  "getDatabase",
  "get_database",
  "GET",
  D,
  ["databases:read"],
  z.strictObject(database),
  DatabaseSchema,
  "Read a database within its full organisation parent.",
);
operation(
  "updateDatabase",
  "update_database",
  "PATCH",
  D,
  ["databases:manage"],
  z.strictObject({ ...database, ...names }),
  DatabaseSchema,
  "Update database presentation metadata.",
  { minimumRole: "admin" },
);
operation(
  "deleteDatabase",
  "delete_database",
  "DELETE",
  D,
  ["databases:manage"],
  z.strictObject({ ...database, ...approval }),
  JobAcceptedSchema,
  "Start approved database deletion and retained-history handling.",
  { minimumRole: "admin", stepUp: "required", job: true, successStatus: 202 },
);
operation(
  "listTables",
  "list_tables",
  "GET",
  `${D}/tables`,
  ["tables:read"],
  z.strictObject({ ...database, ...paging }),
  list(TableSchema),
  "List accessible tables inside a database.",
);
operation(
  "createTable",
  "create_table",
  "POST",
  `${D}/tables`,
  ["tables:manage"],
  z.strictObject({
    ...database,
    ...names,
    fields: z.array(FieldInputSchema).max(limits.maxFields).optional(),
  }),
  TableSchemaResultSchema,
  "Create a physical typed table and runtime schema metadata.",
);
operation(
  "getTable",
  "get_table",
  "GET",
  T,
  ["tables:read"],
  z.strictObject(table),
  TableSchema,
  "Read table metadata including cached live-row count.",
);
operation(
  "updateTable",
  "update_table",
  "PATCH",
  T,
  ["tables:manage"],
  z.strictObject({ ...table, ...expected, ...names }),
  TableSchema,
  "Update table name and description.",
);
operation(
  "deleteTable",
  "delete_table",
  "DELETE",
  T,
  ["tables:manage"],
  z.strictObject({ ...table, ...expected, ...approval }),
  JobAcceptedSchema,
  "Start approved table deletion, preserving retained history metadata.",
  { stepUp: "required", job: true, successStatus: 202 },
);
operation(
  "getTableSchema",
  "get_table_schema",
  "GET",
  `${T}/schema`,
  ["tables:read"],
  z.strictObject(table),
  TableSchemaResultSchema,
  "Discover active fields, rules, indexes, limits and operator coverage.",
);
operation(
  "listFields",
  "list_fields",
  "GET",
  `${T}/fields`,
  ["tables:read"],
  z.strictObject(table),
  list(FieldDefinitionSchema),
  "List active fields with immutable API keys.",
);
operation(
  "createField",
  "create_field",
  "POST",
  `${T}/fields`,
  ["schema:manage"],
  z.strictObject({ ...table, ...expected, field: FieldInputSchema }),
  jobOr(TableSchemaResultSchema),
  "Add a validated field, checking existing values and row bytes.",
  { job: true },
);
operation(
  "updateField",
  "update_field",
  "PATCH",
  `${T}/fields/{fieldId}`,
  ["schema:manage"],
  z.strictObject({
    ...table,
    ...expected,
    fieldId: IdSchema,
    field: FieldInputSchema,
    conversion: z.enum(["explicit", "lossless"]).optional(),
  }),
  jobOr(TableSchemaResultSchema),
  "Change field definition with explicit existing-data validation and conversion.",
  { job: true },
);
operation(
  "deleteField",
  "delete_field",
  "DELETE",
  `${T}/fields/{fieldId}`,
  ["schema:manage"],
  z.strictObject({
    ...table,
    ...expected,
    fieldId: IdSchema,
    removeDependencies: z.boolean().optional(),
  }),
  jobOr(TableSchemaResultSchema),
  "Remove a field safely after approving dependent rule/index removal.",
  { destructive: true, job: true },
);
operation(
  "reorderFields",
  "reorder_fields",
  "PUT",
  `${T}/field-order`,
  ["schema:manage"],
  z.strictObject({
    ...table,
    ...expected,
    fieldIds: z.array(IdSchema).max(limits.maxFields),
  }),
  TableSchemaResultSchema,
  "Set field presentation order without changing API keys.",
);
const schemaInput = { ...table, ...expected, change: SchemaChangeSchema };
const previewSchema = z.strictObject({
  valid: z.boolean(),
  requiresJob: z.boolean(),
  rowCount: z.number().int().nonnegative(),
  conflicts: z
    .array(
      z.strictObject({
        rowId: IdSchema,
        fieldId: IdSchema.optional(),
        code: z.string(),
        message: z.string(),
      }),
    )
    .max(1000),
  reportArtifactId: IdSchema.optional(),
});
operation(
  "previewSchemaChange",
  "preview_schema_change",
  "POST",
  `${T}/schema/preview`,
  ["schema:manage"],
  z.strictObject(schemaInput),
  previewSchema,
  "Dry run a proposed schema change over existing values.",
  { readOnly: true, idempotencyRequired: false, minimumRole: "editor" },
);
operation(
  "applySchemaChange",
  "apply_schema_change",
  "POST",
  `${T}/schema/operations`,
  ["schema:manage"],
  z.strictObject(schemaInput),
  JobAcceptedSchema,
  "Start a journalled resumable schema change with verified cutover.",
  { job: true, successStatus: 202, destructive: true },
);
operation(
  "getSchemaOperation",
  "get_schema_operation",
  "GET",
  `${T}/schema/operations/{id}`,
  ["schema:manage"],
  z.strictObject({ ...table, id: IdSchema }),
  SchemaOperationReportSchema,
  "Inspect a schema journal using its journal ID or the originating schema job ID. Reports preserve recovery state and public business definitions without physical identifiers.",
);
operation(
  "listUniqueRules",
  "list_unique_rules",
  "GET",
  `${T}/unique-rules`,
  ["tables:read"],
  z.strictObject(table),
  list(UniqueRuleSchema),
  "List active or building scalar uniqueness rules.",
);
operation(
  "createUniqueRule",
  "create_unique_rule",
  "POST",
  `${T}/unique-rules`,
  ["schema:manage"],
  z.strictObject({
    ...table,
    ...expected,
    fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  }),
  jobOr(UniqueRuleSchema),
  "Validate the whole table and activate collision-safe scalar uniqueness.",
  { job: true },
);
operation(
  "deleteUniqueRule",
  "delete_unique_rule",
  "DELETE",
  `${T}/unique-rules/{id}`,
  ["schema:manage"],
  z.strictObject({ ...table, ...expected, id: IdSchema }),
  deleted,
  "Remove uniqueness enforcement and update the schema version.",
);
operation(
  "listIndexes",
  "list_indexes",
  "GET",
  `${T}/indexes`,
  ["tables:read"],
  z.strictObject(table),
  list(IndexSchema),
  "List index state and supported operator coverage.",
);
operation(
  "createIndex",
  "create_index",
  "POST",
  `${T}/indexes`,
  ["schema:manage"],
  z.strictObject({
    ...table,
    ...expected,
    fieldIds: z.array(IdSchema).length(1),
    kind: z.enum(["btree", "trigram", "jsonb"]),
  }),
  jobOr(IndexSchema),
  "Start a verified index build within the secondary-index budget.",
  { job: true },
);
operation(
  "deleteIndex",
  "delete_index",
  "DELETE",
  `${T}/indexes/{id}`,
  ["schema:manage"],
  z.strictObject({ ...table, ...expected, id: IdSchema }),
  deleted,
  "Remove a secondary index without removing unique enforcement.",
);

operation(
  "listRows",
  "list_rows",
  "GET",
  `${T}/rows`,
  ["rows:read"],
  z.strictObject({
    ...table,
    select: z.array(z.string().min(1).max(64)).max(limits.maxFields).optional(),
    orderBy:
      QuerySpecSchema instanceof z.ZodObject
        ? QuerySpecSchema.shape.orderBy
        : z
            .array(
              z.strictObject({
                field: z.string(),
                direction: z.enum(["asc", "desc"]),
              }),
            )
            .max(limits.querySorts)
            .optional(),
    ...paging,
  }),
  QueryResultSchema,
  "List rows with compact projection/order/cursor parameters.",
);
operation(
  "queryRows",
  "query_rows",
  "POST",
  `${T}/query`,
  ["rows:read"],
  z.strictObject({ ...table, query: QuerySpecSchema }),
  QueryResultSchema,
  "Query typed fields with bounded projection, filters, sorting and live cursors.",
  {
    readOnly: true,
    idempotencyRequired: false,
    example: {
      orgId: "01K6J7B8000000000000000000",
      databaseId: "01K6J7B8000000000000000001",
      tableId: "01K6J7B8000000000000000002",
      query: { select: ["AIRLINE_ID", "SHORT_NAME"], limit: 200 },
    },
  },
);
operation(
  "getRow",
  "get_row",
  "GET",
  `${T}/rows/{rowId}`,
  ["rows:read"],
  z.strictObject({ ...table, rowId: IdSchema }),
  RowSchema,
  "Get one canonical row with its opaque ID and decimal-string revision.",
);
operation(
  "createRow",
  "create_row",
  "POST",
  `${T}/rows`,
  ["rows:write"],
  z.strictObject({ ...table, ...expected, values }),
  z.strictObject({ row: RowSchema, mutationId: IdSchema }),
  "Commit a validated row, uniqueness, capacity, initial cell history and idempotency.",
);
operation(
  "updateRow",
  "update_row",
  "PATCH",
  `${T}/rows/{rowId}`,
  ["rows:write"],
  z.strictObject({
    ...table,
    ...expected,
    rowId: IdSchema,
    expectedVersion: VersionSchema,
    values,
  }),
  z.strictObject({ row: RowSchema, mutationId: IdSchema }),
  "Patch cells with optimistic revision checks and atomic history.",
);
operation(
  "deleteRow",
  "delete_row",
  "DELETE",
  `${T}/rows/{rowId}`,
  ["rows:write"],
  z.strictObject({
    ...table,
    ...expected,
    rowId: IdSchema,
    expectedVersion: VersionSchema,
  }),
  deleted,
  "Delete a row with If-Match revision, retained history and released live capacity.",
);
const rowMutation = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("create"), values }),
  OperatorRepairUpdateSchema.extend({ type: z.literal("update") }),
  z.strictObject({
    type: z.literal("delete"),
    rowId: IdSchema,
    expectedVersion: VersionSchema,
  }),
]);
operation(
  "mutateRows",
  "mutate_rows",
  "POST",
  `${T}/rows/batch`,
  ["rows:write"],
  z
    .strictObject({
      ...table,
      ...expected,
      ...approval,
      mutations: z.array(rowMutation).min(1).max(limits.mutationBatch),
      repair: z.strictObject({ reason: OperatorRepairReasonSchema }).optional(),
    })
    .superRefine((input, context) => {
      if (input.repair)
        for (const [index, mutation] of input.mutations.entries())
          if (mutation.type !== "update")
            context.addIssue({
              code: "custom",
              message: "Operator repair accepts revision-bound updates only",
              path: ["mutations", index, "type"],
            });
    })
    .meta({
      allOf: [
        {
          if: { required: ["repair"] },
          then: {
            properties: {
              mutations: {
                items: { properties: { type: { const: "update" } } },
              },
            },
          },
        },
      ],
    }),
  jobOr(
    z.strictObject({
      mutationId: IdSchema,
      results: z
        .array(
          z.strictObject({
            type: z.enum(["create", "update", "delete"]),
            rowId: IdSchema,
            row: RowSchema.optional(),
            deleted: z.boolean().optional(),
          }),
        )
        .max(limits.mutationBatch),
    }),
  ),
  "Commit at most 1,000 create/update/delete mutations atomically. With repair, accept only revision-bound updates as a durable operator repair job; require a personal installation operator with installation:manage, rows:write and current edit access, plus an explicit approval bound to the exact target, schema, revisions, values and reason, even for a recent session. Ordinary batches return the synchronous result.",
  { destructive: true, job: true, stepUp: "conditional" },
);
operation(
  "getTableStatistics",
  "get_table_statistics",
  "GET",
  `${T}/statistics`,
  ["rows:read"],
  z.strictObject(table),
  z.strictObject({
    liveRows: z.number().int().nonnegative(),
    rowCountKind: z.enum(["cached", "live", "approximate"]),
    storageBytes: z.number().nonnegative(),
    indexBytes: z.number().nonnegative(),
    historyEvents: z.number().int().nonnegative(),
    asOf: DateTimeSchema,
  }),
  "Read counts and size estimates without counting every filtered page.",
);
operation(
  "countRows",
  "count_rows",
  "POST",
  `${T}/count`,
  ["rows:read"],
  z.strictObject({
    ...table,
    query: QuerySpecSchema.optional(),
    exact: z.boolean().optional(),
  }),
  jobOr(
    z.strictObject({
      count: z.number().int().nonnegative(),
      kind: z.enum(["cached", "live", "approximate", "exact"]),
      asOf: DateTimeSchema,
    }),
  ),
  "Get an explicitly labelled count; expensive exact filtered counts become jobs.",
  { readOnly: true, idempotencyRequired: false, job: true },
);
operation(
  "getCellHistory",
  "get_cell_history",
  "GET",
  `${T}/rows/{rowId}/cells/{fieldId}/history`,
  ["history:read"],
  z.strictObject({ ...table, rowId: IdSchema, fieldId: IdSchema, ...paging }),
  HistoryPageSchema,
  "Read one cell history including retained deleted-row/field events.",
);
operation(
  "queryHistory",
  "query_history",
  "POST",
  `${T}/history/query`,
  ["history:read"],
  z.strictObject({
    ...table,
    rowId: IdSchema.optional(),
    fieldId: IdSchema.optional(),
    mutationId: IdSchema.optional(),
    from: DateTimeSchema.optional(),
    to: DateTimeSchema.optional(),
    ...paging,
  }),
  HistoryPageSchema,
  "Query bounded row/table history under current resource access.",
  { readOnly: true, idempotencyRequired: false },
);
operation(
  "getMutation",
  "get_mutation",
  "GET",
  `${O}/mutations/{id}`,
  [],
  z.strictObject({ ...org, id: IdSchema }),
  outcome,
  "Inspect a committed mutation without replaying one-time secrets.",
);

operation(
  "prepareImportUpload",
  "prepare_import_upload",
  "POST",
  `${T}/imports/uploads`,
  ["imports:write"],
  z.strictObject({
    ...table,
    format: z.enum(["csv", "jsonl"]),
    byteLength: z.number().int().min(1).max(134217728),
    checksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  z.strictObject({
    artifactId: IdSchema,
    uploadUrl: z.string(),
    expiresAt: DateTimeSchema,
    maxBytes: z.number().int().positive(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    byteLength: z.number().int().min(1).max(134217728),
  }),
  "Prepare a bounded upload bound to the authorised import target.",
);
const importInput = {
  ...table,
  ...expected,
  artifactId: IdSchema,
  format: z.enum(["csv", "jsonl"]).optional(),
  mapping: ImportMappingSchema,
  mode: z.enum(["create", "upsert"]),
  uniqueRuleId: IdSchema.optional(),
  rowIdColumn: z.string().optional(),
  atomic: z.boolean().optional(),
  batchSize: z.number().int().min(1).max(limits.mutationBatch).optional(),
};
const importReport = z.strictObject({
  valid: z.boolean(),
  examined: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  errors: z
    .array(
      z.strictObject({
        record: z.number().int().min(1),
        field: z.string().optional(),
        code: z.string(),
        message: z.string(),
      }),
    )
    .max(1000),
  reportArtifactId: IdSchema.optional(),
});
operation(
  "validateImport",
  "validate_import",
  "POST",
  `${T}/imports/validate`,
  ["imports:write"],
  z.strictObject(importInput),
  jobOr(importReport),
  "Dry run CSV/JSONL mappings and validation without committing imported rows.",
  { readOnly: false, idempotencyRequired: true, job: true },
);
operation(
  "importRows",
  "import_rows",
  "POST",
  `${T}/imports`,
  ["imports:write", "rows:write"],
  z.strictObject(importInput),
  JobAcceptedSchema,
  "Import validated batches with durable checkpoints and explicit partial outcomes.",
  { job: true, successStatus: 202 },
);
operation(
  "exportRows",
  "export_rows",
  "POST",
  `${T}/exports`,
  ["exports:read", "rows:read"],
  z.strictObject({
    ...table,
    format: z.enum(["csv", "jsonl"]),
    query: QuerySpecSchema.optional(),
    spreadsheetSafe: z.boolean().optional(),
  }),
  JobAcceptedSchema,
  "Start a consistent snapshot CSV/JSONL export with checksummed artifacts.",
  { minimumRole: "viewer", job: true, successStatus: 202 },
);
operation(
  "getArtifact",
  "get_artifact",
  "GET",
  `${O}/artifacts/{id}`,
  [],
  z.strictObject({ ...org, id: IdSchema }),
  ArtifactSchema,
  "Get authenticated expiring artifact access after current source/target permission checks.",
);
operation(
  "getHistoryRetentionPolicy",
  "get_history_retention_policy",
  "GET",
  `${T}/history-retention-policy`,
  ["history:read"],
  z.strictObject(table),
  HistoryRetentionPolicySchema,
  "Read the optional history archive schedule; disabled policies retain hot history indefinitely.",
);
operation(
  "setHistoryRetentionPolicy",
  "set_history_retention_policy",
  "PUT",
  `${T}/history-retention-policy`,
  ["history:read", "schema:manage"],
  z.strictObject({
    ...table,
    ...HistoryRetentionPolicySchema.omit({ suspension: true }).shape,
    ...approval,
  }),
  HistoryRetentionPolicySchema,
  "Configure verified encrypted history archiving before removing old events from hot storage. Cold archives remain retained.",
  { minimumRole: "admin", stepUp: "conditional" },
);
operation(
  "archiveHistory",
  "archive_history",
  "POST",
  `${T}/history-archives`,
  ["history:read", "schema:manage"],
  z.strictObject({ ...table, before: DateTimeSchema, ...approval }),
  JobAcceptedSchema,
  "Archive history strictly before a UTC cutoff, verify its encrypted content, then purge covered hot events in resumable batches.",
  {
    minimumRole: "admin",
    stepUp: "conditional",
    job: true,
    successStatus: 202,
    destructive: true,
  },
);
operation(
  "listHistoryArchives",
  "list_history_archives",
  "GET",
  `${T}/history-archives`,
  ["history:read"],
  z.strictObject({ ...table, ...jobPaging }),
  list(HistoryArchiveSchema),
  "List authorised history archive manifests and their verification or purge state.",
);
operation(
  "getHistoryArchive",
  "get_history_archive",
  "GET",
  `${T}/history-archives/{id}`,
  ["history:read"],
  z.strictObject({ ...table, id: IdSchema }),
  HistoryArchiveSchema,
  "Read one retained history archive manifest without exposing storage credentials.",
);
operation(
  "getBackupPolicy",
  "get_backup_policy",
  "GET",
  `${D}/backup-policy`,
  ["backups:read"],
  z.strictObject(database),
  z.strictObject({ policy: BackupPolicySchema.nullable() }),
  "Read the backup policy without destination credentials.",
  { minimumRole: "admin" },
);
operation(
  "setBackupPolicy",
  "set_backup_policy",
  "PUT",
  `${D}/backup-policy`,
  ["backups:manage"],
  z.strictObject({
    ...database,
    ...BackupPolicySchema.omit({ suspension: true }).shape,
    ...approval,
  }),
  BackupPolicySchema,
  "Configure cron, timezone, encrypted destination and verified-recovery retention.",
  { minimumRole: "admin", stepUp: "conditional" },
);
operation(
  "previewBackupSchedule",
  "preview_backup_schedule",
  "POST",
  `${D}/backup-policy/preview`,
  ["backups:read"],
  z.strictObject({
    ...database,
    cron: BackupPolicySchema.shape.cron.optional(),
    timezone: PreferencesSchema.shape.timezone.optional(),
    count: z.number().int().min(1).max(20).optional(),
    from: DateTimeSchema.optional(),
  }),
  z.strictObject({
    occurrences: z.array(DateTimeSchema).max(20),
    timezone: z.string(),
    repeatedTimePolicy: z.literal("earlier"),
    nonexistentTimePolicy: z.literal("skip"),
  }),
  "Preview UTC cron occurrences with documented daylight-saving behavior.",
  { readOnly: true, idempotencyRequired: false, minimumRole: "admin" },
);
operation(
  "listBackups",
  "list_backups",
  "GET",
  `${D}/backups`,
  ["backups:read"],
  z.strictObject({ ...database, ...jobPaging }),
  list(BackupSchema),
  "List backup runs and verified-recovery state.",
  { minimumRole: "admin" },
);
operation(
  "getBackup",
  "get_backup",
  "GET",
  `${D}/backups/{id}`,
  ["backups:read"],
  z.strictObject({ ...database, id: IdSchema }),
  BackupSchema,
  "Read a backup run, manifest and terminal verification outcome.",
  { minimumRole: "admin" },
);
operation(
  "createBackup",
  "create_backup",
  "POST",
  `${D}/backups`,
  ["backups:manage"],
  z.strictObject(database),
  JobAcceptedSchema,
  "Start one database-wide snapshot followed by upload and isolated restore verification.",
  { minimumRole: "admin", job: true, successStatus: 202 },
);
operation(
  "deleteBackup",
  "delete_backup",
  "DELETE",
  `${D}/backups/{id}`,
  ["backups:manage"],
  z.strictObject({ ...database, id: IdSchema }),
  JobAcceptedSchema,
  "Queue resumable cleanup of an owned backup while preserving required recovery points; inspect the deletion job for terminal verification.",
  { minimumRole: "admin", job: true, successStatus: 202 },
);
const restoreInput = {
  ...database,
  id: IdSchema,
  mode: z.enum(["new", "replace"]),
  name: names.name.optional(),
  targetDatabaseId: IdSchema.optional(),
  ...approval,
};
operation(
  "previewRestore",
  "preview_restore",
  "POST",
  `${D}/backups/{id}/restore-preview`,
  ["backups:manage"],
  z.strictObject(restoreInput),
  z.strictObject({
    compatible: z.boolean(),
    mode: z.enum(["new", "replace"]),
    requiresApproval: z.boolean(),
    requiresRecoveryPoint: z.boolean(),
    warnings: z.array(z.string()),
  }),
  "Validate a backup and proposed restore mapping before any cutover.",
  { readOnly: true, idempotencyRequired: false, minimumRole: "admin" },
);
operation(
  "restoreBackup",
  "restore_backup",
  "POST",
  `${D}/backups/{id}/restores`,
  ["backups:manage", "databases:manage"],
  z.strictObject(restoreInput),
  JobAcceptedSchema,
  "Restore into a staged new database or approved replacement and verify before publication.",
  {
    minimumRole: "admin",
    stepUp: "conditional",
    job: true,
    successStatus: 202,
    destructive: true,
  },
);
operation(
  "listJobs",
  "list_jobs",
  "GET",
  `${O}/jobs`,
  ["jobs:read"],
  z.strictObject({
    ...org,
    ...jobPaging,
    databaseId: IdSchema.optional(),
    tableId: IdSchema.optional(),
    state: JobSchema.shape.state.optional(),
    kind: z.string().optional(),
  }),
  list(JobSchema),
  "List only currently authorised jobs and their truthful progress.",
);
operation(
  "getJob",
  "get_job",
  "GET",
  `${O}/jobs/{id}`,
  ["jobs:read"],
  z.strictObject({ ...org, id: IdSchema }),
  JobSchema,
  "Inspect a durable job and committed checkpoints.",
);
operation(
  "cancelJob",
  "cancel_job",
  "POST",
  `${O}/jobs/{id}/cancel`,
  ["jobs:cancel"],
  z.strictObject({ ...org, id: IdSchema }),
  JobSchema,
  "Request cancellation at a safe checkpoint with partial outcomes.",
  { destructive: true, minimumRole: "viewer" },
);
operation(
  "retryJob",
  "retry_job",
  "POST",
  `${O}/jobs/{id}/retry`,
  ["jobs:retry"],
  z.strictObject({ ...org, id: IdSchema }),
  JobAcceptedSchema,
  "Retry an authorised recoverable job after reconciliation.",
  { job: true, successStatus: 202, minimumRole: "viewer" },
);
operation(
  "getUsage",
  "get_usage",
  "GET",
  `${O}/usage`,
  ["org:read"],
  z.strictObject(org),
  z.strictObject({
    databases: z.number().int().nonnegative(),
    tables: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
    dataBytes: z.number().nonnegative(),
    indexBytes: z.number().nonnegative(),
    historyBytes: z.number().nonnegative(),
    artifactBytes: z.number().nonnegative(),
    storageQuotaBytes:
      CapacityConfigurationSchema.shape.defaultOrganisationQuotaBytes.removeDefault(),
    storageAdmission: StorageAdmissionSchema,
    admissionAvailable: z.boolean(),
  }),
  "Read appropriately redacted organisation usage and capacity.",
);

operation(
  "getViewPreferences",
  "get_view_preferences",
  "GET",
  "/v1/me/view-preferences/{tableId}",
  ["rows:read"],
  z.strictObject({ tableId: IdSchema }),
  ViewPreferencesResultSchema,
  "Read your accessible table column/filter preferences.",
  { personal: true, resource: "table" },
);
operation(
  "updateViewPreferences",
  "update_view_preferences",
  "PUT",
  "/v1/me/view-preferences/{tableId}",
  ["rows:read"],
  z.strictObject({ tableId: IdSchema, preferences: ViewPreferencesSchema }),
  ViewPreferencesResultSchema,
  "Save table view preferences without changing data/schema.",
  { personal: true, resource: "table", minimumRole: "viewer" },
);
const installationStatus = z.strictObject({
  healthy: z.boolean(),
  version: z.string(),
  migrationVersion: z.string(),
  dependencies: z.record(
    z.string(),
    z.enum(["healthy", "degraded", "unavailable"]),
  ),
  workerHeartbeatAt: DateTimeSchema.nullable(),
  metrics: OperationalMetricsSchema,
  storage: CapacityStatusSchema.nullable(),
});
const installationConfig = z.strictObject({
  baseUrl: z.url(),
  signupEnabled: z.literal(false),
  smtpConfigured: z.boolean(),
  objectStorageConfigured: z.boolean(),
  limits: z.record(z.string(), z.number()),
  operatorRecoveryEnabled: z.boolean(),
  restartRequired: z.boolean().optional(),
  storage: CapacityConfigurationSchema,
  deletionRetention: DeletionRetentionSchema,
});
export const SmtpConfigurationInputSchema = z.strictObject({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  from: z.email(),
  user: z.string().max(512).optional(),
  password: z
    .string()
    .max(4096)
    .meta({
      writeOnly: true,
      description: "Encrypted at rest and never returned.",
    })
    .optional(),
});
export const ObjectStorageConfigurationInputSchema = z.strictObject({
  endpoint: z
    .url()
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "Expected an HTTP(S) endpoint",
    ),
  region: z.string().min(1).max(255),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().max(512).meta({ writeOnly: true }).optional(),
  secretAccessKey: z
    .string()
    .max(4096)
    .meta({
      writeOnly: true,
      description: "Encrypted at rest and never returned.",
    })
    .optional(),
});
operation(
  "getInstallationStatus",
  "get_installation_status",
  "GET",
  "/v1/installation/status",
  ["installation:read"],
  empty,
  installationStatus,
  "Read operator-authorised installation dependency state.",
  { operator: true },
);
operation(
  "getInstallationConfiguration",
  "get_installation_configuration",
  "GET",
  "/v1/installation/configuration",
  ["installation:read"],
  empty,
  installationConfig,
  "Read redacted installation configuration without credential material.",
  { operator: true },
);
operation(
  "updateInstallationConfiguration",
  "update_installation_configuration",
  "PATCH",
  "/v1/installation/configuration",
  ["installation:manage"],
  z.strictObject({
    limits: z.record(z.string(), z.number().int().safe().positive()).optional(),
    storage: CapacityConfigurationPatchSchema.optional(),
    deletionRetention: DeletionRetentionPatchSchema.optional(),
    smtp: SmtpConfigurationInputSchema.optional(),
    objectStorage: ObjectStorageConfigurationInputSchema.optional(),
    ...approval,
  }),
  installationConfig,
  "Apply approved operator ceilings and configuration.",
  { operator: true, stepUp: "required" },
);
operation(
  "testEmail",
  "test_email",
  "POST",
  "/v1/installation/email-test",
  ["installation:manage"],
  z.strictObject({ recipient: z.email(), ...approval }),
  JobAcceptedSchema,
  "Queue a redacted operator-authorised test email.",
  { operator: true, stepUp: "required", job: true, successStatus: 202 },
);

export const operations: readonly OperationDefinition[] =
  Object.freeze(definitions);
export const operationMap: Readonly<Record<string, OperationDefinition>> =
  Object.freeze(
    Object.fromEntries(
      definitions.map((definition) => [definition.id, definition]),
    ),
  );
export const toolMap: Readonly<Record<string, OperationDefinition>> =
  Object.freeze(
    Object.fromEntries(
      definitions.map((definition) => [definition.toolName, definition]),
    ),
  );
export const scopeNames = Object.freeze(
  [...new Set(definitions.flatMap((definition) => definition.scopes))].sort(),
);
export const ScopeSchema = z.enum(scopeNames as [string, ...string[]]);
export function getOperation(idOrTool: string): OperationDefinition {
  const definition = operationMap[idOrTool] ?? toolMap[idOrTool];
  if (!definition) throw new Error(`Unknown Rootset operation ${idOrTool}`);
  return definition;
}
export function validateOperationInput(
  idOrTool: string,
  input: unknown,
): unknown {
  return getOperation(idOrTool).inputSchema.parse(input);
}
export const ProtocolAdapterInventory = Object.freeze([
  {
    path: "/api/backend/{path*}",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    kind: "reverse_proxy",
    surface: "web",
    allowedPaths: [
      "/v1/{path*}",
      "/api/internal/{path*}",
      "/oauth/authorize",
      "/oauth/token",
      "/oauth/revoke",
      "/oauth/register",
      "/mcp",
      "/.well-known/{path*}",
    ],
    upstream: "configured-api-only",
    jsonRequestMaxBytes: limits.requestBytes,
    jsonReadTimeoutMs: limits.requestTimeoutMs,
    requestHeaderMaxBytes: 192 * 1024,
    streamedResponses: true,
    binaryUpload: {
      path: "/api/artifact-upload/{orgId}/{id}",
      method: "PUT",
      maxBytes: 134217728,
      mappedPaths: [
        "/v1/orgs/{orgId}/artifacts/{id}/upload",
        "/api/internal/v1/orgs/{orgId}/artifacts/{id}/upload",
      ],
    },
    reason:
      "Same-origin web routing uses a local bounded streaming handler and a fixed configured API upstream. It preserves operation authentication, cookies, Origin and idempotency while removing untrusted forwarding/hop headers; completed-input MCP/SSE and verified binary responses stream without a ten-second response deadline. Only the narrow authenticated artifact upload handler has the separate 128 MiB request budget.",
  },
  {
    path: "/mcp",
    methods: ["GET", "POST", "DELETE"],
    kind: "protocol",
    reason:
      "Streamable HTTP MCP transport negotiates protocol methods and requires an MCP-resource OAuth actor; its named tools come from the operation catalog.",
  },
  {
    path: "/v1/orgs/{orgId}/artifacts/{id}/upload",
    methods: ["PUT"],
    kind: "binary",
    operationId: "prepareImportUpload",
    reason:
      "Bounded authenticated raw upload follows the prepared artifact handoff; binary bodies are not MCP tool arguments.",
  },
  {
    path: "/v1/orgs/{orgId}/artifacts/{id}/download",
    methods: ["GET"],
    kind: "binary",
    operationId: "getArtifact",
    reason:
      "An authenticated verified artifact stream follows metadata retrieval and checks current artifact-purpose, requester and target authority; MCP also exposes bounded artifact resources.",
  },
  {
    path: "/api/internal/v1/orgs/{orgId}/artifacts/{id}/download",
    methods: ["GET"],
    kind: "binary",
    operationId: "getArtifact",
    reason:
      "The browser session download adapter uses the same current artifact-purpose, requester and target checks. Bearer credentials use the public binary handoff; this read-only adapter does not require mutation CSRF proof.",
  },
  {
    path: "/v1/setup",
    methods: ["GET", "POST"],
    kind: "bootstrap",
    reason: "First identity must exist before OAuth.",
  },
  {
    path: "/v1/auth/*",
    methods: ["GET", "POST"],
    kind: "identity",
    reason:
      "Identity/factor proof is browser-mediated. Personal account deletion is admitted by the existing bound account-action/auth adapters with exact DELETE confirmation, account:security, explicit approval and the current last-Owner check. Its internal deleteAccount execution descriptor returns a queued job and is not a public catalog operation or separate MCP tool.",
  },
  {
    path: "/oauth/*",
    methods: ["GET", "POST"],
    kind: "protocol",
    reason: "OAuth identity/consent/token exchange is protocol-specific.",
  },
  {
    path: "/api/internal/v1/oauth/requests/*",
    methods: ["GET", "POST"],
    kind: "interactive",
    reason:
      "Browser session consent inspection and approval are OAuth protocol proof, with issuer/request/client binding.",
  },
  {
    path: "/.well-known/*",
    methods: ["GET"],
    kind: "discovery",
    reason: "OAuth resource and authorization server discovery.",
  },
  {
    path: "/api/internal/v1/context",
    methods: ["GET"],
    kind: "context",
    operationId: "getContext",
  },
  {
    path: "/api/internal/v1/tables/{id}/windows/query",
    methods: ["POST"],
    kind: "window",
    operationId: "queryRows",
  },
  {
    path: "/api/internal/v1/view-preferences/{tableId}",
    methods: ["GET", "PUT"],
    kind: "alias",
    operationIds: ["getViewPreferences", "updateViewPreferences"],
    reason:
      "Browser convenience aliases execute the same typed personal table-view preference operations.",
  },
  {
    path: "/api/internal/v1/account-actions/{id}/approve",
    methods: ["POST"],
    kind: "interactive",
    operationId: "completeAccountAction",
  },
  {
    path: "/v1/openapi.json",
    methods: ["GET"],
    kind: "discovery",
    reason:
      "Public generated contract publication contains no credential or private installation values.",
  },
  {
    path: "/api/internal/v1/openapi.json",
    methods: ["GET"],
    kind: "discovery",
    reason: "Browser-authenticated generated internal contract publication.",
  },
  {
    path: "/v1/operation-coverage",
    methods: ["GET"],
    kind: "discovery",
    reason:
      "Public static coverage inventory lists operation metadata, without user data or a claim that every operation was executed successfully.",
  },
  {
    path: "/health/live",
    methods: ["GET"],
    kind: "probe",
    reason: "Bounded redacted liveness.",
  },
  {
    path: "/health/ready",
    methods: ["GET"],
    kind: "probe",
    reason: "Bounded redacted readiness.",
  },
]);

// Retained as a schema export for callers validating internal operation context.
export const OperationContextSchema = z.strictObject({
  actor: ActorSchema,
  requestId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(255).optional(),
  surface: z.enum(["browser", "rest", "mcp", "worker", "operator"]),
});
