import {
  BackupDestinationSchema,
  BackupTimingSchema,
  BackupScheduleInputSchema,
  BackupScheduleResultSchema,
  DatabaseBackupSchema,
} from "./backups";
import { UniqueRuleConditionSchema } from "./unique-rules";
import { ImportSourceSchema } from "./imports";
import {
  SavedViewDefinitionSchema,
  SavedViewSchema,
  SavedViewSummarySchema,
  SavedViewVisibilitySchema,
} from "./views";
import { z } from "zod";
import {
  AccountNameSchema,
  CanonicalUtcDateTimeSchema,
  ActorSchema,
  IdSchema,
  JobAcceptedSchema,
  JobSchema,
  JsonValueSchema,
  PreferencesSchema,
  QueryResultSchema,
  RoleSchema,
  RowSchema,
  SchemaVersionSchema,
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
  ArtifactSchema,
  ConnectionSchema,
  ContextSchema,
  DatabaseSchema,
  DatabaseSummarySchema,
  HistoryPageSchema,
  InvitationSchema,
  KeyCreatedSchema,
  KeyMetadataSchema,
  MemberSchema,
  OrganisationSchema,
  OperatorRepairReasonSchema,
  OperatorRepairUpdateSchema,
  ProfileSchema,
  RowValuesInputSchema,
  RowCommentSchema,
  SchemaChangeSchema,
  SchemaOperationReportSchema,
  SessionMetadataSchema,
  TableSchema,
  TableSummarySchema,
  TableSchemaResultSchema,
  UniqueRuleSchema,
  ForeignKeySchema,
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
  stepUp: "never" | "required";
  job: boolean;
  personal: boolean;
  minimumRole: Role;
  resource: "none" | "organisation" | "database" | "table";
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  description: string;
  tags: string[];
  errors: string[];
  successStatus: number;
  example: Record<string, unknown>;
}
const org = { orgId: IdSchema };
const database = { ...org, databaseId: IdSchema };
const table = { ...database, tableId: IdSchema };
const expected = { expectedSchemaVersion: SchemaVersionSchema };
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
    : path.includes("/exports") || path.includes("/artifacts")
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
    minimumRole: settings.personal
      ? "viewer"
      : scopes.some(
            (scope) =>
              (scope.endsWith(":manage") &&
                ![
                  "databases:manage",
                  "tables:manage",
                  "schema:manage",
                ].includes(scope)) ||
              scope === "members:read" ||
              scope.startsWith("installation:"),
          )
        ? "admin"
        : scopes.some((scope) => scope.endsWith(":manage"))
          ? "member"
          : readOnly
            ? "viewer"
            : "member",
    resource: path.includes("{tableId}")
      ? "table"
      : path.includes("{databaseId}")
        ? "database"
        : path.includes("{orgId}")
          ? "organisation"
          : "none",
    tags: [group],
    errors: [
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "ACCESS_DENIED",
      "FORBIDDEN",
      "INSUFFICIENT_SCOPE",
      ...(settings.personal ? ["PERSONAL_IDENTITY_REQUIRED"] : []),
      ...(id === "mutateRows" ? ["PERSONAL_IDENTITY_REQUIRED"] : []),
      ...(settings.stepUp && settings.stepUp !== "never"
        ? ["STEP_UP_REQUIRED"]
        : []),
      ...(["updateMember", "removeMember"].includes(id) ? ["LAST_ADMIN"] : []),
      "RESOURCE_NOT_FOUND",
      "DEPENDENCY_UNAVAILABLE",
      "REQUEST_TIMEOUT",
      ...(!readOnly ? ["IDEMPOTENCY_CONFLICT"] : []),
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
  "Get the caller, installation organisation, current role capabilities and preferences.",
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
  z.strictObject({ name: AccountNameSchema }),
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
  "Read display preferences.",
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
    dateFormats: z.array(PreferencesSchema.shape.dateFormat),
    timeFormats: z.array(PreferencesSchema.shape.timeFormat),
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
  z.strictObject({
    preferences: PreferencesSchema,
    value: DateTimeSchema,
  }),
  z.strictObject({
    utc: DateTimeSchema,
    displayed: z.string(),
    timezone: z.string(),
  }),
  "Preview a UTC instant with proposed display preferences.",
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
  z.strictObject({ id: IdSchema }),
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
  z.strictObject({ ...org, name: AccountNameSchema }),
  OrganisationSchema,
  "Update the installation organisation name.",
  { minimumRole: "admin" },
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
    name: AccountNameSchema.optional(),
    role: RoleSchema.optional(),
    expectedVersion: VersionSchema,
  }),
  MemberSchema,
  "Update a member name or role while preserving at least one admin.",
  { minimumRole: "admin" },
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
  }),
  deleted,
  "Remove a member and invalidate delegated access.",
  { minimumRole: "admin" },
);
operation(
  "listInvitations",
  "list_invitations",
  "GET",
  `${O}/invitations`,
  ["members:manage"],
  z.strictObject({
    ...org,
    ...paging,
    state: InvitationSchema.shape.state.optional(),
  }),
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
    role: z.enum(["admin", "member", "viewer"]),
  }),
  InvitationSchema.extend({ inviteUrl: z.url() }),
  "Invite a member as an admin with email proof.",
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
const keyInput = {
  name: AccountNameSchema,
  access: z.enum(["read", "edit"]),
  includeAdmin: z.boolean(),
  expiresAt: DateTimeSchema.nullable(),
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
  z
    .strictObject({ ...org, ...keyInput })
    .refine((input) => !input.includeAdmin || input.access === "edit", {
      message: "Administrative keys require edit access",
    }),
  KeyCreatedSchema,
  "Create a personal key with read-only, edit or administrative permissions capped by your live role; secret appears once.",
  { personal: true },
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
    name: names.name.optional(),
    access: z.enum(["read", "edit"]).optional(),
    includeAdmin: z.boolean().optional(),
    expiresAt: DateTimeSchema.nullable().optional(),
  }),
  KeyCreatedSchema,
  "Rotate a personal key with bounded overlap and one-time secret display; preserve name, permissions and expiry unless explicitly changed.",
  { personal: true },
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
  ["team-keys:manage"],
  z.strictObject({ ...org, ...paging }),
  list(KeyMetadataSchema),
  "List metadata for workspace-owned API keys. Administrators only.",
  { minimumRole: "admin", personal: true },
);
operation(
  "createTeamKey",
  "create_team_key",
  "POST",
  `${O}/keys`,
  ["team-keys:manage"],
  z
    .strictObject({ ...org, ...keyInput })
    .refine((input) => !input.includeAdmin || input.access === "edit", {
      message: "Administrative keys require edit access",
    }),
  KeyCreatedSchema,
  "Create a workspace-owned API key with explicit permissions and expiry; the secret appears once and access is independent of its creator.",
  { minimumRole: "admin", personal: true },
);
operation(
  "rotateTeamKey",
  "rotate_team_key",
  "POST",
  `${O}/keys/{id}/rotate`,
  ["team-keys:manage"],
  z.strictObject({
    ...org,
    id: IdSchema,
    overlapSeconds: z.number().int().min(0).max(86400).optional(),
    name: names.name.optional(),
    access: z.enum(["read", "edit"]).optional(),
    includeAdmin: z.boolean().optional(),
    expiresAt: DateTimeSchema.nullable().optional(),
  }),
  KeyCreatedSchema,
  "Rotate a workspace API key with bounded overlap; preserve permissions and expiry unless explicitly changed. Administrators only.",
  { minimumRole: "admin", personal: true },
);
operation(
  "revokeTeamKey",
  "revoke_team_key",
  "DELETE",
  `${O}/keys/{id}`,
  ["team-keys:manage"],
  z.strictObject({ ...org, id: IdSchema }),
  deleted,
  "Revoke a workspace-owned API key. Administrators only.",
  { minimumRole: "admin", personal: true },
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
  list(DatabaseSummarySchema),
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
  { minimumRole: "member" },
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
  { minimumRole: "member" },
);
operation(
  "deleteDatabase",
  "delete_database",
  "DELETE",
  D,
  ["databases:manage"],
  z.strictObject({ ...database }),
  JobAcceptedSchema,
  "Start administrator database deletion, removing its tables, rows and cell history.",
  { minimumRole: "admin", stepUp: "required", job: true, successStatus: 202 },
);
operation(
  "listTables",
  "list_tables",
  "GET",
  `${D}/tables`,
  ["tables:read"],
  z.strictObject({ ...database, ...paging }),
  list(TableSummarySchema),
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
  z.strictObject({ ...table, ...expected }),
  JobAcceptedSchema,
  "Start administrator table deletion, removing its rows and cell history.",
  { minimumRole: "admin", job: true, successStatus: 202 },
);
operation(
  "getTableSchema",
  "get_table_schema",
  "GET",
  `${T}/schema`,
  ["tables:read"],
  z.strictObject(table),
  TableSchemaResultSchema,
  "Discover active fields, rules, limits and operator coverage.",
);
operation(
  "listFields",
  "list_fields",
  "GET",
  `${T}/fields`,
  ["tables:read"],
  z.strictObject(table),
  list(FieldDefinitionSchema),
  "List active fields by property name and stable identifier.",
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
    clearDefault: z.boolean().optional().meta({
      description:
        "Remove the previous constant default. Do not also supply field.default.",
    }),
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
  "Remove a field safely after approving dependent unique-rule removal.",
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
  { readOnly: true, idempotencyRequired: false, minimumRole: "admin" },
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
    where: UniqueRuleConditionSchema.optional(),
  }),
  jobOr(UniqueRuleSchema),
  "Validate existing matching rows and atomically activate scalar uniqueness. Optional where accepts one scalar field ID with eq, ne, isNull or isNotNull; null unique values remain distinct.",
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
  "listForeignKeys",
  "list_foreign_keys",
  "GET",
  `${T}/foreign-keys`,
  ["tables:read"],
  z.strictObject(table),
  list(ForeignKeySchema),
  "List foreign keys linking fields to an unconditional unique key in the same database.",
);
operation(
  "createForeignKey",
  "create_foreign_key",
  "POST",
  `${T}/foreign-keys`,
  ["schema:manage"],
  z.strictObject({
    ...table,
    ...expected,
    fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
    referencedTableId: IdSchema,
    referencedRuleId: IdSchema,
    expectedReferencedSchemaVersion: SchemaVersionSchema,
  }),
  jobOr(ForeignKeySchema),
  "Validate existing rows and create a foreign key to matching scalar fields in the same database. The target requires an active unconditional unique rule. Any NULL in the local tuple skips validation. Referenced values cannot be changed or deleted while in use.",
  { job: true },
);
operation(
  "deleteForeignKey",
  "delete_foreign_key",
  "DELETE",
  `${T}/foreign-keys/{id}`,
  ["schema:manage"],
  z.strictObject({ ...table, ...expected, id: IdSchema }),
  deleted,
  "Remove foreign-key validation without changing existing rows.",
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
  "listRowComments",
  "list_row_comments",
  "GET",
  `${T}/rows/{rowId}/comments`,
  ["rows:read"],
  z.strictObject({
    ...table,
    rowId: IdSchema,
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().max(2048).nullable().optional(),
  }),
  list(RowCommentSchema),
  "Read a row discussion in chronological cursor pages of up to 50 entries, including deleted comments with an empty body and a deletedAt timestamp. Requires current access to the row.",
);
operation(
  "countRowComments",
  "count_row_comments",
  "POST",
  `${T}/comments/counts`,
  ["rows:read"],
  z.strictObject({ ...table, rowIds: z.array(IdSchema).min(1).max(200) }),
  z.strictObject({
    data: z.array(
      z.strictObject({
        rowId: IdSchema,
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
  "Read discussion entry counts, including deleted comments, for at most 200 visible rows in one batch. Missing rows are omitted; existing rows without comments return zero.",
  { readOnly: true, idempotencyRequired: false },
);
operation(
  "createRowComment",
  "create_row_comment",
  "POST",
  `${T}/rows/{rowId}/comments`,
  ["rows:write"],
  z.strictObject({
    ...table,
    rowId: IdSchema,
    body: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) => value.trim().length > 0 && !value.includes("\u0000"),
        "Enter a nonblank comment without null characters",
      ),
  }),
  z.strictObject({ id: IdSchema }),
  "Add a plain-text comment of up to 4096 characters with authenticated attribution. Returns its ID; idempotent retries never retain or resurrect deleted bodies. Does not change row or schema versions.",
);
operation(
  "deleteRowComment",
  "delete_row_comment",
  "DELETE",
  `${T}/rows/{rowId}/comments/{commentId}`,
  ["rows:write"],
  z.strictObject({ ...table, rowId: IdSchema, commentId: IdSchema }),
  deleted,
  "Permanently clear your own comment's body, or moderate as an administrator, while retaining its author, creation time and deletion timestamp in the discussion. Requires current write access to the row. Deleted entries cannot be edited, restored or removed through comment operations.",
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
  "Delete a row with If-Match revision, remove its cell history and release live capacity.",
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
  "Commit at most 1,000 create/update/delete mutations atomically. With repair, accept only revision-bound updates as a durable operator repair job; require a personal admin with installation:manage and rows:write, current permission checks for the target, schema, revisions, values and reason. Ordinary batches return the synchronous result.",
  { destructive: true, job: true },
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
  "Read the latest 200 saved changes for an existing cell.",
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
  "previewImportRows",
  "preview_import_rows",
  "POST",
  `${T}/imports/preview`,
  ["rows:read", "rows:write"],
  z.strictObject({ ...table, ...expected, ...ImportSourceSchema.shape }),
  JobAcceptedSchema,
  "Validate an append-only CSV or JSONL import, including mapping, field constraints, unique keys and foreign keys, without inserting records. The job returns a typed preview and a downloadable JSONL error report.",
  { job: true, successStatus: 202 },
);
operation(
  "importRows",
  "import_rows",
  "POST",
  `${T}/imports`,
  ["rows:read", "rows:write"],
  z.strictObject({ ...table, ...expected, previewId: IdSchema }),
  JobAcceptedSchema,
  "Append a previously validated import. Each preview can start one import; retries resume committed batches without duplicating records. Current constraints and authority are checked again before publication.",
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
  }),
  JobAcceptedSchema,
  "Start a complete-table snapshot export in CSV or JSONL, including every row and field, with checksummed artifacts.",
  { minimumRole: "viewer", job: true, successStatus: 202 },
);
operation(
  "exportDatabase",
  "export_database",
  "POST",
  `${D}/exports`,
  ["exports:read", "rows:read", "schema:read"],
  z.strictObject({ ...database, format: z.enum(["csv", "jsonl"]) }),
  JobAcceptedSchema,
  "Export every table and its schema from one database snapshot as a ZIP containing CSV or JSONL data, field definitions, unique rules and foreign keys.",
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
operation(
  "updateForeignKeyDisplayField",
  "update_foreign_key_display_field",
  "PUT",
  "/v1/me/view-preferences/{tableId}/foreign-keys/{foreignKeyId}",
  ["rows:read"],
  z.strictObject({
    tableId: IdSchema,
    foreignKeyId: IdSchema,
    displayFieldId: IdSchema.nullable(),
  }),
  ViewPreferencesResultSchema,
  "Choose your display field for a foreign-key picker without changing its stored keys or other view preferences.",
  { personal: true, resource: "table", minimumRole: "viewer" },
);
operation(
  "listSavedViews",
  "list_saved_views",
  "GET",
  `${T}/views`,
  ["rows:read"],
  z.strictObject(table),
  z.strictObject({ data: z.array(SavedViewSummarySchema).max(200) }),
  "List your personal views and accessible shared views. Sharing a view never grants access to its table.",
  { personal: true, minimumRole: "viewer" },
);
operation(
  "getSavedView",
  "get_saved_view",
  "GET",
  `${T}/views/{viewId}`,
  ["rows:read"],
  z.strictObject({ ...table, viewId: IdSchema }),
  SavedViewSchema,
  "Read an accessible saved view and its current schema validation. Invalid predicates are retained and must be corrected before executing the view.",
  { personal: true, minimumRole: "viewer" },
);
operation(
  "createSavedView",
  "create_saved_view",
  "POST",
  `${T}/views`,
  ["rows:read"],
  z.strictObject({
    ...table,
    ...expected,
    name: AccountNameSchema,
    visibility: SavedViewVisibilitySchema,
    definition: SavedViewDefinitionSchema,
  }),
  SavedViewSchema,
  "Save your filters, sorting and column layout as a personal view. Shared views additionally require current row write authority. Each scope supports up to 100 views.",
  { personal: true, minimumRole: "viewer", successStatus: 201 },
);
operation(
  "updateSavedView",
  "update_saved_view",
  "PATCH",
  `${T}/views/{viewId}`,
  ["rows:read"],
  z
    .strictObject({
      ...table,
      ...expected,
      viewId: IdSchema,
      expectedVersion: VersionSchema,
      name: AccountNameSchema.optional(),
      visibility: SavedViewVisibilitySchema.optional(),
      definition: SavedViewDefinitionSchema.optional(),
    })
    .refine(
      (value) =>
        value.name !== undefined ||
        value.visibility !== undefined ||
        value.definition !== undefined,
      "Change a name, visibility or definition",
    ),
  SavedViewSchema,
  "Update your personal view, or an owned/shared view with current write authority. Administrators can manage shared views; only its owner can make one personal. Versions reject concurrent edits.",
  {
    personal: true,
    minimumRole: "viewer",
    example: {
      orgId: "01K6J7B8000000000000000000",
      databaseId: "01K6J7B8000000000000000001",
      tableId: "01K6J7B8000000000000000002",
      viewId: "01K6J7B8000000000000000003",
      expectedSchemaVersion: 1,
      expectedVersion: "1",
      name: "Needs review",
    },
  },
);
operation(
  "deleteSavedView",
  "delete_saved_view",
  "DELETE",
  `${T}/views/{viewId}`,
  ["rows:read"],
  z.strictObject({
    ...table,
    viewId: IdSchema,
    expectedVersion: VersionSchema,
  }),
  z.strictObject({
    id: IdSchema,
    deleted: z.literal(true),
    version: VersionSchema,
  }),
  "Delete an owned personal view or a shared view you can manage. Deleting a view never changes its records.",
  { personal: true, minimumRole: "viewer" },
);
operation(
  "getBackupSchedule",
  "get_backup_schedule",
  "GET",
  `${D}/backup-schedule`,
  ["backups:read"],
  z.strictObject(database),
  BackupScheduleResultSchema,
  "Read the database backup schedule and worker availability.",
  { minimumRole: "admin" },
);
operation(
  "saveBackupSchedule",
  "save_backup_schedule",
  "PUT",
  `${D}/backup-schedule`,
  ["backups:manage"],
  BackupScheduleInputSchema.extend(database),
  JobAcceptedSchema,
  "Verify the destination on the worker, then save and enable the schedule only if verification succeeds.",
  { minimumRole: "admin", job: true, successStatus: 202 },
);
operation(
  "deleteBackupSchedule",
  "delete_backup_schedule",
  "DELETE",
  `${D}/backup-schedule`,
  ["backups:manage"],
  z.strictObject({ ...database, expectedVersion: z.number().int().min(0) }),
  BackupScheduleResultSchema,
  "Delete the schedule and cancel pending scheduled runs and schedule saves. Existing backup packages and history are retained.",
  { minimumRole: "admin" },
);
operation(
  "previewBackupSchedule",
  "preview_backup_schedule",
  "POST",
  `${D}/backup-schedule/preview`,
  ["backups:read"],
  BackupTimingSchema.extend(database),
  z.strictObject({ nextRuns: z.array(CanonicalUtcDateTimeSchema) }),
  "Preview the next three occurrences of a five-field cron schedule in an explicit timezone.",
  { readOnly: true, minimumRole: "admin", successStatus: 200 },
);
operation(
  "listDatabaseBackups",
  "list_database_backups",
  "GET",
  `${D}/backups`,
  ["backups:read"],
  z.strictObject({ ...database, ...jobPaging }),
  list(DatabaseBackupSchema),
  "List database backup runs, destination tests and missed schedule ranges.",
  { minimumRole: "admin" },
);
operation(
  "runDatabaseBackup",
  "run_database_backup",
  "POST",
  `${D}/backups`,
  ["backups:manage"],
  z.strictObject(database),
  JobAcceptedSchema,
  "Queue a full encrypted database backup to the saved destination.",
  { minimumRole: "admin", job: true, successStatus: 202 },
);
operation(
  "testBackupDestination",
  "test_backup_destination",
  "POST",
  `${D}/backup-schedule/test`,
  ["backups:manage"],
  BackupDestinationSchema.extend(database),
  JobAcceptedSchema,
  "Ask a backup-enabled worker to write, read, verify and remove a probe at the destination.",
  { minimumRole: "admin", job: true, successStatus: 202 },
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
    path: "/mcp",
    methods: ["GET", "POST", "DELETE"],
    kind: "protocol",
    reason:
      "Streamable HTTP MCP transport negotiates protocol methods and requires a personal API key or MCP-resource OAuth actor; its named tools come from the operation catalog.",
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
    path: "/v1/public/auth/request-verification-email",
    methods: ["POST"],
    kind: "identity",
    reason:
      "Public normalized-email verification request with neutral acknowledgement and fixed login callback.",
  },
  {
    path: "/v1/auth/*",
    methods: ["GET", "POST", "DELETE"],
    kind: "identity",
    reason:
      "Identity/factor proof is browser-mediated. Personal account deletion, organisation lifecycle and team credentials are not supported.",
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
