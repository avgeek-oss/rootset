// Generated from @rootset/contracts. Regenerate through pnpm contracts:generate.
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "ACCESS_DENIED"
  | "FORBIDDEN"
  | "LAST_ADMIN"
  | "INSUFFICIENT_SCOPE"
  | "PERSONAL_IDENTITY_REQUIRED"
  | "DELEGATION_EXCEEDS_AUTHORITY"
  | "RESOURCE_NOT_FOUND"
  | "ROW_VERSION_CONFLICT"
  | "SCHEMA_VERSION_CONFLICT"
  | "UNIQUE_CONFLICT"
  | "FOREIGN_KEY_CONFLICT"
  | "AUTO_INCREMENT_EXHAUSTED"
  | "ROW_SIZE_LIMIT"
  | "ROW_LIMIT_REACHED"
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_TIMEOUT"
  | "QUERY_TIMEOUT"
  | "CURSOR_INVALID"
  | "STEP_UP_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "JOB_FAILED"
  | "RATE_LIMITED"
  | "CAPACITY_LIMIT"
  | "SCHEMA_MAINTENANCE"
  | "ARTIFACT_UNVERIFIED"
  | "ARTIFACT_EXPIRED"
  | "CONFIGURATION_INVALID"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";
export const transportLimits = {
  jsonRequestMaxBytes: 8388608,
  jsonReadTimeoutMs: 10000,
  restResultMaxBytes: 8388608,
  mcpResultMaxBytes: 1048576,
} as const;
export type getContextInput = Record<string, never>;
export type getContextOutput = {
  principal: {
    id: string;
    kind: string;
    userId?: string;
    role: "admin" | "member" | "viewer";
  };
  organisation: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  scopes: string[];
  profile: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
  preferences: {
    timezone: string;
    locale: string;
    dateFormat:
      | "day-short-month-year"
      | "short-month-day-year"
      | "year-month-day"
      | "day-month-year"
      | "month-day-year";
    timeFormat: "24-hour" | "12-hour" | "24-hour-seconds" | "12-hour-seconds";
    theme: "system" | "light" | "dark";
  } | null;
  onboarding: { needsEmailVerification: boolean; setupComplete: boolean };
};
export type getProfileInput = Record<string, never>;
export type getProfileOutput = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
};
export type updateProfileInput = { name: string };
export type updateProfileOutput = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
};
export type getPreferencesInput = Record<string, never>;
export type getPreferencesOutput = {
  timezone: string;
  locale: string;
  dateFormat:
    | "day-short-month-year"
    | "short-month-day-year"
    | "year-month-day"
    | "day-month-year"
    | "month-day-year";
  timeFormat: "24-hour" | "12-hour" | "24-hour-seconds" | "12-hour-seconds";
  theme: "system" | "light" | "dark";
};
export type updatePreferencesInput = {
  timezone?: string;
  locale?: string;
  dateFormat?:
    | "day-short-month-year"
    | "short-month-day-year"
    | "year-month-day"
    | "day-month-year"
    | "month-day-year";
  timeFormat?: "24-hour" | "12-hour" | "24-hour-seconds" | "12-hour-seconds";
  theme?: "system" | "light" | "dark";
};
export type updatePreferencesOutput = {
  timezone: string;
  locale: string;
  dateFormat:
    | "day-short-month-year"
    | "short-month-day-year"
    | "year-month-day"
    | "day-month-year"
    | "month-day-year";
  timeFormat: "24-hour" | "12-hour" | "24-hour-seconds" | "12-hour-seconds";
  theme: "system" | "light" | "dark";
};
export type getPreferenceOptionsInput = Record<string, never>;
export type getPreferenceOptionsOutput = {
  timezones: string[];
  locales: string[];
  dateFormats: (
    | "day-short-month-year"
    | "short-month-day-year"
    | "year-month-day"
    | "day-month-year"
    | "month-day-year"
  )[];
  timeFormats: (
    "24-hour" | "12-hour" | "24-hour-seconds" | "12-hour-seconds"
  )[];
  themes: string[];
};
export type previewPreferencesInput = {
  preferences: {
    timezone: string;
    locale: string;
    dateFormat:
      | "day-short-month-year"
      | "short-month-day-year"
      | "year-month-day"
      | "day-month-year"
      | "month-day-year";
    timeFormat: "24-hour" | "12-hour" | "24-hour-seconds" | "12-hour-seconds";
    theme: "system" | "light" | "dark";
  };
  value: string;
};
export type previewPreferencesOutput = {
  utc: string;
  displayed: string;
  timezone: string;
};
export type listSessionsInput = Record<string, never>;
export type listSessionsOutput = {
  data: {
    id: string;
    createdAt: string;
    expiresAt: string;
    lastActivityAt: string;
    current: boolean;
    userAgent?: string;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type revokeSessionInput = { id: string };
export type revokeSessionOutput = { deleted: boolean; mutationId?: string };
export type listConnectionsInput = Record<string, never>;
export type listConnectionsOutput = {
  data: {
    id: string;
    clientId: string;
    clientName: string;
    orgId: string;
    audience: string;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type revokeConnectionInput = { id: string };
export type revokeConnectionOutput = { deleted: boolean; mutationId?: string };
export type getOrganisationInput = { orgId: string };
export type getOrganisationOutput = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};
export type updateOrganisationInput = { orgId: string; name: string };
export type updateOrganisationOutput = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};
export type listMembersInput = {
  orgId: string;
  limit?: number;
  cursor?: string | null;
};
export type listMembersOutput = {
  data: {
    id: string;
    orgId: string;
    userId: string;
    name: string;
    email: string;
    role: "admin" | "member" | "viewer";
    version: string;
    verified: boolean;
    twoFactorEnabled: boolean;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type updateMemberInput = {
  orgId: string;
  id: string;
  name?: string;
  role?: "admin" | "member" | "viewer";
  expectedVersion: string;
};
export type updateMemberOutput = {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  email: string;
  role: "admin" | "member" | "viewer";
  version: string;
  verified: boolean;
  twoFactorEnabled: boolean;
};
export type removeMemberInput = {
  orgId: string;
  id: string;
  expectedVersion: string;
};
export type removeMemberOutput = { deleted: boolean; mutationId?: string };
export type listInvitationsInput = {
  orgId: string;
  limit?: number;
  cursor?: string | null;
  state?: "pending" | "accepted" | "cancelled" | "expired";
};
export type listInvitationsOutput = {
  data: {
    id: string;
    orgId: string;
    email: string;
    role: "admin" | "member" | "viewer";
    state: "pending" | "accepted" | "cancelled" | "expired";
    expiresAt: string;
    createdAt: string;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type inviteMemberInput = {
  orgId: string;
  email: string;
  role: "admin" | "member" | "viewer";
};
export type inviteMemberOutput = {
  id: string;
  orgId: string;
  email: string;
  role: "admin" | "member" | "viewer";
  state: "pending" | "accepted" | "cancelled" | "expired";
  expiresAt: string;
  createdAt: string;
  inviteUrl: string;
};
export type cancelInvitationInput = { orgId: string; id: string };
export type cancelInvitationOutput = { deleted: boolean; mutationId?: string };
export type listPersonalKeysInput = Record<string, never>;
export type listPersonalKeysOutput = {
  data: {
    scope: "personal" | "team";
    access: "read" | "edit";
    includeAdmin: boolean;
    id: string;
    orgId: string;
    name: string;
    userId: string | null;
    prefix: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type createPersonalKeyInput = {
  orgId: string;
  name: string;
  access: "read" | "edit";
  includeAdmin: boolean;
  expiresAt: string | null;
};
export type createPersonalKeyOutput = {
  key: {
    scope: "personal" | "team";
    access: "read" | "edit";
    includeAdmin: boolean;
    id: string;
    orgId: string;
    name: string;
    userId: string | null;
    prefix: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  };
  secret?: string;
  replayed?: boolean;
};
export type rotatePersonalKeyInput = {
  id: string;
  overlapSeconds?: number;
  name?: string;
  access?: "read" | "edit";
  includeAdmin?: boolean;
  expiresAt?: string | null;
};
export type rotatePersonalKeyOutput = {
  key: {
    scope: "personal" | "team";
    access: "read" | "edit";
    includeAdmin: boolean;
    id: string;
    orgId: string;
    name: string;
    userId: string | null;
    prefix: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  };
  secret?: string;
  replayed?: boolean;
};
export type revokePersonalKeyInput = { id: string };
export type revokePersonalKeyOutput = { deleted: boolean; mutationId?: string };
export type listTeamKeysInput = {
  orgId: string;
  limit?: number;
  cursor?: string | null;
};
export type listTeamKeysOutput = {
  data: {
    scope: "personal" | "team";
    access: "read" | "edit";
    includeAdmin: boolean;
    id: string;
    orgId: string;
    name: string;
    userId: string | null;
    prefix: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type createTeamKeyInput = {
  orgId: string;
  name: string;
  access: "read" | "edit";
  includeAdmin: boolean;
  expiresAt: string | null;
};
export type createTeamKeyOutput = {
  key: {
    scope: "personal" | "team";
    access: "read" | "edit";
    includeAdmin: boolean;
    id: string;
    orgId: string;
    name: string;
    userId: string | null;
    prefix: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  };
  secret?: string;
  replayed?: boolean;
};
export type rotateTeamKeyInput = {
  orgId: string;
  id: string;
  overlapSeconds?: number;
  name?: string;
  access?: "read" | "edit";
  includeAdmin?: boolean;
  expiresAt?: string | null;
};
export type rotateTeamKeyOutput = {
  key: {
    scope: "personal" | "team";
    access: "read" | "edit";
    includeAdmin: boolean;
    id: string;
    orgId: string;
    name: string;
    userId: string | null;
    prefix: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  };
  secret?: string;
  replayed?: boolean;
};
export type revokeTeamKeyInput = { orgId: string; id: string };
export type revokeTeamKeyOutput = { deleted: boolean; mutationId?: string };
export type getSecurityStatusInput = Record<string, never>;
export type getSecurityStatusOutput = {
  twoFactorEnabled: boolean;
  recoveryCodesRemaining: number;
  passkeys: {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
};
export type listDatabasesInput = {
  orgId: string;
  limit?: number;
  cursor?: string | null;
};
export type listDatabasesOutput = {
  data: {
    id: string;
    orgId: string;
    name: string;
    description?: string | null;
    state:
      "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
    createdAt: string;
    updatedAt: string;
    tableCount: number;
    storageBytes: number;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type createDatabaseInput = {
  orgId: string;
  name: string;
  description?: string | null;
};
export type createDatabaseOutput = {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
  state:
    "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
  createdAt: string;
  updatedAt: string;
};
export type getDatabaseInput = { orgId: string; databaseId: string };
export type getDatabaseOutput = {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
  state:
    "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
  createdAt: string;
  updatedAt: string;
};
export type updateDatabaseInput = {
  orgId: string;
  databaseId: string;
  name: string;
  description?: string | null;
};
export type updateDatabaseOutput = {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
  state:
    "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
  createdAt: string;
  updatedAt: string;
};
export type deleteDatabaseInput = { orgId: string; databaseId: string };
export type deleteDatabaseOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type listTablesInput = {
  orgId: string;
  databaseId: string;
  limit?: number;
  cursor?: string | null;
};
export type listTablesOutput = {
  data: {
    id: string;
    databaseId: string;
    orgId: string;
    name: string;
    description?: string | null;
    schemaVersion: number;
    rowCount: number;
    state:
      "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
    createdAt: string;
    updatedAt: string;
    storageBytes: number;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type createTableInput = {
  orgId: string;
  databaseId: string;
  name: string;
  description?: string | null;
  fields?: (
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "text";
        allowedValues?: string[] | null;
        charLimit?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "integer";
        autoIncrement?: boolean;
        min?: number;
        max?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "float";
        min?: number;
        max?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "uri";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "url";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "image";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "boolean";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date";
        min?: string;
        max?: string;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "time";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date-time";
        min?: string;
        max?: string;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "json";
      }
  )[];
};
export type createTableOutput = {
  table: {
    id: string;
    databaseId: string;
    orgId: string;
    name: string;
    description?: string | null;
    schemaVersion: number;
    rowCount: number;
    state:
      "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
    createdAt: string;
    updatedAt: string;
  };
  fields: (
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "text";
        allowedValues?: string[] | null;
        charLimit?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "integer";
        autoIncrement?: boolean;
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "float";
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "uri";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "url";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "image";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "boolean";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "time";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date-time";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "json";
      }
  )[];
  uniqueRules: {
    id: string;
    tableId: string;
    fieldIds: string[];
    where?:
      | { field: string; op: "eq" | "ne"; value: string | number | boolean }
      | { field: string; op: "isNull" | "isNotNull" };
    nullPolicy: "distinct";
    state: "building" | "active" | "failed" | "deleting";
    strategy: "native" | "registry";
    jobId?: string;
    error?: string;
  }[];
  foreignKeys: {
    id: string;
    tableId: string;
    fieldIds: string[];
    referencedTableId: string;
    referencedTableName: string;
    referencedRuleId: string;
    referencedFieldIds: string[];
    referencedFieldNames: string[];
    state: "active";
  }[];
  operators: Record<string, string[]>;
  limits: Record<string, number>;
  schemaOperationId?: string;
};
export type getTableInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type getTableOutput = {
  id: string;
  databaseId: string;
  orgId: string;
  name: string;
  description?: string | null;
  schemaVersion: number;
  rowCount: number;
  state:
    "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
  createdAt: string;
  updatedAt: string;
};
export type updateTableInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  name: string;
  description?: string | null;
};
export type updateTableOutput = {
  id: string;
  databaseId: string;
  orgId: string;
  name: string;
  description?: string | null;
  schemaVersion: number;
  rowCount: number;
  state:
    "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
  createdAt: string;
  updatedAt: string;
};
export type deleteTableInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
};
export type deleteTableOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type getTableSchemaInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type getTableSchemaOutput = {
  table: {
    id: string;
    databaseId: string;
    orgId: string;
    name: string;
    description?: string | null;
    schemaVersion: number;
    rowCount: number;
    state:
      "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
    createdAt: string;
    updatedAt: string;
  };
  fields: (
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "text";
        allowedValues?: string[] | null;
        charLimit?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "integer";
        autoIncrement?: boolean;
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "float";
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "uri";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "url";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "image";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "boolean";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "time";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date-time";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "json";
      }
  )[];
  uniqueRules: {
    id: string;
    tableId: string;
    fieldIds: string[];
    where?:
      | { field: string; op: "eq" | "ne"; value: string | number | boolean }
      | { field: string; op: "isNull" | "isNotNull" };
    nullPolicy: "distinct";
    state: "building" | "active" | "failed" | "deleting";
    strategy: "native" | "registry";
    jobId?: string;
    error?: string;
  }[];
  foreignKeys: {
    id: string;
    tableId: string;
    fieldIds: string[];
    referencedTableId: string;
    referencedTableName: string;
    referencedRuleId: string;
    referencedFieldIds: string[];
    referencedFieldNames: string[];
    state: "active";
  }[];
  operators: Record<string, string[]>;
  limits: Record<string, number>;
  schemaOperationId?: string;
};
export type listFieldsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type listFieldsOutput = {
  data: (
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "text";
        allowedValues?: string[] | null;
        charLimit?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "integer";
        autoIncrement?: boolean;
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "float";
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "uri";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "url";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "image";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "boolean";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "time";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date-time";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "json";
      }
  )[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type createFieldInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  field:
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "text";
        allowedValues?: string[] | null;
        charLimit?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "integer";
        autoIncrement?: boolean;
        min?: number;
        max?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "float";
        min?: number;
        max?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "uri";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "url";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "image";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "boolean";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date";
        min?: string;
        max?: string;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "time";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date-time";
        min?: string;
        max?: string;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "json";
      };
};
export type createFieldOutput =
  | {
      table: {
        id: string;
        databaseId: string;
        orgId: string;
        name: string;
        description?: string | null;
        schemaVersion: number;
        rowCount: number;
        state:
          | "active"
          | "creating"
          | "maintenance"
          | "deleting"
          | "deleted"
          | "failed";
        createdAt: string;
        updatedAt: string;
      };
      fields: (
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "text";
            allowedValues?: string[] | null;
            charLimit?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "integer";
            autoIncrement?: boolean;
            min?: number;
            max?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "float";
            min?: number;
            max?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "uri";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "url";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "image";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "boolean";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "date";
            min?: string;
            max?: string;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "time";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "date-time";
            min?: string;
            max?: string;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "json";
          }
      )[];
      uniqueRules: {
        id: string;
        tableId: string;
        fieldIds: string[];
        where?:
          | { field: string; op: "eq" | "ne"; value: string | number | boolean }
          | { field: string; op: "isNull" | "isNotNull" };
        nullPolicy: "distinct";
        state: "building" | "active" | "failed" | "deleting";
        strategy: "native" | "registry";
        jobId?: string;
        error?: string;
      }[];
      foreignKeys: {
        id: string;
        tableId: string;
        fieldIds: string[];
        referencedTableId: string;
        referencedTableName: string;
        referencedRuleId: string;
        referencedFieldIds: string[];
        referencedFieldNames: string[];
        state: "active";
      }[];
      operators: Record<string, string[]>;
      limits: Record<string, number>;
      schemaOperationId?: string;
    }
  | {
      jobId: string;
      state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "partially_completed";
      statusUrl: string;
    };
export type updateFieldInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  fieldId: string;
  field:
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "text";
        allowedValues?: string[] | null;
        charLimit?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "integer";
        autoIncrement?: boolean;
        min?: number;
        max?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "float";
        min?: number;
        max?: number;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "uri";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "url";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "image";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "boolean";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date";
        min?: string;
        max?: string;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "time";
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date-time";
        min?: string;
        max?: string;
      }
    | {
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "json";
      };
  clearDefault?: boolean;
  conversion?: "explicit" | "lossless";
};
export type updateFieldOutput =
  | {
      table: {
        id: string;
        databaseId: string;
        orgId: string;
        name: string;
        description?: string | null;
        schemaVersion: number;
        rowCount: number;
        state:
          | "active"
          | "creating"
          | "maintenance"
          | "deleting"
          | "deleted"
          | "failed";
        createdAt: string;
        updatedAt: string;
      };
      fields: (
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "text";
            allowedValues?: string[] | null;
            charLimit?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "integer";
            autoIncrement?: boolean;
            min?: number;
            max?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "float";
            min?: number;
            max?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "uri";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "url";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "image";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "boolean";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "date";
            min?: string;
            max?: string;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "time";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "date-time";
            min?: string;
            max?: string;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "json";
          }
      )[];
      uniqueRules: {
        id: string;
        tableId: string;
        fieldIds: string[];
        where?:
          | { field: string; op: "eq" | "ne"; value: string | number | boolean }
          | { field: string; op: "isNull" | "isNotNull" };
        nullPolicy: "distinct";
        state: "building" | "active" | "failed" | "deleting";
        strategy: "native" | "registry";
        jobId?: string;
        error?: string;
      }[];
      foreignKeys: {
        id: string;
        tableId: string;
        fieldIds: string[];
        referencedTableId: string;
        referencedTableName: string;
        referencedRuleId: string;
        referencedFieldIds: string[];
        referencedFieldNames: string[];
        state: "active";
      }[];
      operators: Record<string, string[]>;
      limits: Record<string, number>;
      schemaOperationId?: string;
    }
  | {
      jobId: string;
      state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "partially_completed";
      statusUrl: string;
    };
export type deleteFieldInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  fieldId: string;
  removeDependencies?: boolean;
};
export type deleteFieldOutput =
  | {
      table: {
        id: string;
        databaseId: string;
        orgId: string;
        name: string;
        description?: string | null;
        schemaVersion: number;
        rowCount: number;
        state:
          | "active"
          | "creating"
          | "maintenance"
          | "deleting"
          | "deleted"
          | "failed";
        createdAt: string;
        updatedAt: string;
      };
      fields: (
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "text";
            allowedValues?: string[] | null;
            charLimit?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "integer";
            autoIncrement?: boolean;
            min?: number;
            max?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "float";
            min?: number;
            max?: number;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "uri";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "url";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "image";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "boolean";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "date";
            min?: string;
            max?: string;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "time";
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "date-time";
            min?: string;
            max?: string;
          }
        | {
            id: string;
            name: string;
            required?: boolean;
            default?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            order?: number;
            type: "json";
          }
      )[];
      uniqueRules: {
        id: string;
        tableId: string;
        fieldIds: string[];
        where?:
          | { field: string; op: "eq" | "ne"; value: string | number | boolean }
          | { field: string; op: "isNull" | "isNotNull" };
        nullPolicy: "distinct";
        state: "building" | "active" | "failed" | "deleting";
        strategy: "native" | "registry";
        jobId?: string;
        error?: string;
      }[];
      foreignKeys: {
        id: string;
        tableId: string;
        fieldIds: string[];
        referencedTableId: string;
        referencedTableName: string;
        referencedRuleId: string;
        referencedFieldIds: string[];
        referencedFieldNames: string[];
        state: "active";
      }[];
      operators: Record<string, string[]>;
      limits: Record<string, number>;
      schemaOperationId?: string;
    }
  | {
      jobId: string;
      state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "partially_completed";
      statusUrl: string;
    };
export type reorderFieldsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  fieldIds: string[];
};
export type reorderFieldsOutput = {
  table: {
    id: string;
    databaseId: string;
    orgId: string;
    name: string;
    description?: string | null;
    schemaVersion: number;
    rowCount: number;
    state:
      "active" | "creating" | "maintenance" | "deleting" | "deleted" | "failed";
    createdAt: string;
    updatedAt: string;
  };
  fields: (
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "text";
        allowedValues?: string[] | null;
        charLimit?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "integer";
        autoIncrement?: boolean;
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "float";
        min?: number;
        max?: number;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "uri";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "url";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "image";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "boolean";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "time";
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "date-time";
        min?: string;
        max?: string;
      }
    | {
        id: string;
        name: string;
        required?: boolean;
        default?:
          | null
          | boolean
          | number
          | string
          | unknown[]
          | Record<string, unknown>;
        order?: number;
        type: "json";
      }
  )[];
  uniqueRules: {
    id: string;
    tableId: string;
    fieldIds: string[];
    where?:
      | { field: string; op: "eq" | "ne"; value: string | number | boolean }
      | { field: string; op: "isNull" | "isNotNull" };
    nullPolicy: "distinct";
    state: "building" | "active" | "failed" | "deleting";
    strategy: "native" | "registry";
    jobId?: string;
    error?: string;
  }[];
  foreignKeys: {
    id: string;
    tableId: string;
    fieldIds: string[];
    referencedTableId: string;
    referencedTableName: string;
    referencedRuleId: string;
    referencedFieldIds: string[];
    referencedFieldNames: string[];
    state: "active";
  }[];
  operators: Record<string, string[]>;
  limits: Record<string, number>;
  schemaOperationId?: string;
};
export type previewSchemaChangeInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  change:
    | {
        kind: "add_field";
        field: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
      }
    | {
        kind: "update_field";
        fieldId: string;
        changes: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
        conversion?: "explicit" | "lossless";
      }
    | { kind: "delete_field"; fieldId: string; removeDependencies: boolean }
    | { kind: "reorder_fields"; fieldIds: string[] };
};
export type previewSchemaChangeOutput = {
  valid: boolean;
  requiresJob: boolean;
  rowCount: number;
  conflicts: {
    rowId: string;
    fieldId?: string;
    code: string;
    message: string;
  }[];
  reportArtifactId?: string;
};
export type applySchemaChangeInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  change:
    | {
        kind: "add_field";
        field: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
      }
    | {
        kind: "update_field";
        fieldId: string;
        changes: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
        conversion?: "explicit" | "lossless";
      }
    | { kind: "delete_field"; fieldId: string; removeDependencies: boolean }
    | { kind: "reorder_fields"; fieldIds: string[] };
};
export type applySchemaChangeOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type getSchemaOperationInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  id: string;
};
export type getSchemaOperationOutput = {
  id: string;
  databaseId: string;
  tableId: string | null;
  kind: string;
  state: string;
  phase:
    "planned" | "running" | "committed" | "failed" | "historical" | "unknown";
  expectedSchemaVersion: number | null;
  request:
    | { kind: "database.create"; name: string; description?: string | null }
    | { kind: "database.update"; name?: string; description?: string | null }
    | { kind: "database.delete" }
    | {
        kind: "table.create";
        name: string;
        description?: string | null;
        fields: (
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "text";
              allowedValues?: string[] | null;
              charLimit?: number;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "integer";
              autoIncrement?: boolean;
              min?: number;
              max?: number;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "float";
              min?: number;
              max?: number;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "uri";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "url";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "image";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "boolean";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "date";
              min?: string;
              max?: string;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "time";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "date-time";
              min?: string;
              max?: string;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "json";
            }
        )[];
      }
    | { kind: "table.update"; name?: string; description?: string | null }
    | { kind: "table.delete" }
    | {
        kind: "field.create";
        field:
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "text";
              allowedValues?: string[] | null;
              charLimit?: number;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "integer";
              autoIncrement?: boolean;
              min?: number;
              max?: number;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "float";
              min?: number;
              max?: number;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "uri";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "url";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "image";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "boolean";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "date";
              min?: string;
              max?: string;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "time";
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "date-time";
              min?: string;
              max?: string;
            }
          | {
              name: string;
              required?: boolean;
              default?:
                | null
                | boolean
                | number
                | string
                | unknown[]
                | Record<string, unknown>;
              order?: number;
              type: "json";
            };
      }
    | {
        kind: "field.update";
        fieldId?: string;
        changes: {
          autoIncrement?: boolean;
          clearDefault?: boolean;
          allowedValues?: string[] | null;
          name?: string;
          type?:
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
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          charLimit?: number;
          min?: unknown;
          max?: unknown;
          order?: number;
        };
      }
    | {
        kind: "field.convert";
        fieldId?: string;
        changes: {
          autoIncrement?: boolean;
          clearDefault?: boolean;
          allowedValues?: string[] | null;
          name?: string;
          type?:
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
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          charLimit?: number;
          min?: unknown;
          max?: unknown;
          order?: number;
        };
        conversion?: "explicit" | "lossless";
      }
    | { kind: "field.delete"; fieldId?: string; removeDependencies: boolean }
    | { kind: "fields.reorder"; fieldIds: string[] }
    | {
        kind: "rule.create";
        fieldIds: string[];
        where?:
          | { field: string; op: "eq" | "ne"; value: string | number | boolean }
          | { field: string; op: "isNull" | "isNotNull" };
        name?: string;
      }
    | { kind: "rule.delete"; id?: string }
    | {
        kind: "foreign-key.create";
        fieldIds: string[];
        referencedTableId: string;
        referencedRuleId: string;
        expectedReferencedSchemaVersion: number;
      }
    | { kind: "foreign-key.delete"; id?: string }
    | { kind: "unknown" };
  before: {
    table: {
      id: string;
      databaseId: string;
      orgId: string;
      name: string;
      description?: string | null;
      schemaVersion: number;
      rowCount: number;
      state:
        | "active"
        | "creating"
        | "maintenance"
        | "deleting"
        | "deleted"
        | "failed";
      createdAt: string;
      updatedAt: string;
    };
    fields: (
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "text";
          allowedValues?: string[] | null;
          charLimit?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "integer";
          autoIncrement?: boolean;
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "float";
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "uri";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "url";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "image";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "boolean";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "time";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date-time";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "json";
        }
    )[];
  } | null;
  change?:
    | {
        kind: "add_field";
        field: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
      }
    | {
        kind: "update_field";
        fieldId: string;
        changes: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
        conversion?: "explicit" | "lossless";
      }
    | { kind: "delete_field"; fieldId: string; removeDependencies: boolean }
    | { kind: "reorder_fields"; fieldIds: string[] };
  verification: {
    transactional?: boolean;
    fieldId?: string;
    nextField?:
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "text";
          allowedValues?: string[] | null;
          charLimit?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "integer";
          autoIncrement?: boolean;
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "float";
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "uri";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "url";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "image";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "boolean";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "time";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date-time";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "json";
        };
  };
  createdAt: string;
  committedAt: string | null;
  error?: { code: string; message: string; retryable?: boolean };
  jobId?: string;
};
export type listUniqueRulesInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type listUniqueRulesOutput = {
  data: {
    id: string;
    tableId: string;
    fieldIds: string[];
    where?:
      | { field: string; op: "eq" | "ne"; value: string | number | boolean }
      | { field: string; op: "isNull" | "isNotNull" };
    nullPolicy: "distinct";
    state: "building" | "active" | "failed" | "deleting";
    strategy: "native" | "registry";
    jobId?: string;
    error?: string;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type createUniqueRuleInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  fieldIds: string[];
  where?:
    | { field: string; op: "eq" | "ne"; value: string | number | boolean }
    | { field: string; op: "isNull" | "isNotNull" };
};
export type createUniqueRuleOutput =
  | {
      id: string;
      tableId: string;
      fieldIds: string[];
      where?:
        | { field: string; op: "eq" | "ne"; value: string | number | boolean }
        | { field: string; op: "isNull" | "isNotNull" };
      nullPolicy: "distinct";
      state: "building" | "active" | "failed" | "deleting";
      strategy: "native" | "registry";
      jobId?: string;
      error?: string;
    }
  | {
      jobId: string;
      state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "partially_completed";
      statusUrl: string;
    };
export type deleteUniqueRuleInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  id: string;
};
export type deleteUniqueRuleOutput = { deleted: boolean; mutationId?: string };
export type getRowRelationshipsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowId: string;
  expectedVersion?: string;
  cursor?: string | null;
  limit?: number;
};
export type getRowRelationshipsOutput = {
  rowVersion: string;
  asOf: string;
  data: {
    id: string;
    tableId: string;
    tableName: string;
    tableState: string;
    fieldIds: string[];
    fieldNames: string[];
    referencedFieldIds: string[];
    count: number;
    hasKey: boolean;
  }[];
  nextCursor: unknown;
  hasMore: boolean;
};
export type getRelatedRowFilterInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  ruleId: string;
  referencedRowId: string;
};
export type getRelatedRowFilterOutput = {
  filter: { fieldId: string; value: unknown }[];
  schemaVersion: number;
  referencedTableId: string;
  referencedRowId: string;
  referencedVersion: string;
};
export type listForeignKeysInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type listForeignKeysOutput = {
  data: {
    id: string;
    tableId: string;
    fieldIds: string[];
    referencedTableId: string;
    referencedTableName: string;
    referencedRuleId: string;
    referencedFieldIds: string[];
    referencedFieldNames: string[];
    state: "active";
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type createForeignKeyInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  fieldIds: string[];
  referencedTableId: string;
  referencedRuleId: string;
  expectedReferencedSchemaVersion: number;
};
export type createForeignKeyOutput =
  | {
      id: string;
      tableId: string;
      fieldIds: string[];
      referencedTableId: string;
      referencedTableName: string;
      referencedRuleId: string;
      referencedFieldIds: string[];
      referencedFieldNames: string[];
      state: "active";
    }
  | {
      jobId: string;
      state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "partially_completed";
      statusUrl: string;
    };
export type deleteForeignKeyInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  id: string;
};
export type deleteForeignKeyOutput = { deleted: boolean; mutationId?: string };
export type listRowsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  select?: string[];
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  limit?: number;
  cursor?: string | null;
};
export type listRowsOutput = {
  data: {
    id: string;
    version: string;
    createdAt: string;
    updatedAt: string;
    hasComments?: boolean;
    values: Record<
      string,
      null | boolean | number | string | unknown[] | Record<string, unknown>
    >;
  }[];
  schemaVersion: number;
  page: {
    returned: number;
    requestedLimit: number;
    hasMore: boolean;
    nextCursor: unknown;
    stopReason: "row_limit" | "byte_limit" | "end";
    consistency: "live";
  };
};
export type queryRowsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  query: {
    select?: string[];
    where?:
      | {
          field: string;
          op:
            | "eq"
            | "ne"
            | "lt"
            | "lte"
            | "gt"
            | "gte"
            | "between"
            | "in"
            | "isNull"
            | "isNotNull"
            | "prefix"
            | "contains"
            | "iContains"
            | "pathExists"
            | "pathEq"
            | "jsonContains";
          value?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          path?: (string | number)[];
        }
      | { and: JsonValue[] }
      | { or: JsonValue[] };
    orderBy?: { field: string; direction: "asc" | "desc" }[];
    limit?: number;
    cursor?: string | null;
  };
};
export type queryRowsOutput = {
  data: {
    id: string;
    version: string;
    createdAt: string;
    updatedAt: string;
    hasComments?: boolean;
    values: Record<
      string,
      null | boolean | number | string | unknown[] | Record<string, unknown>
    >;
  }[];
  schemaVersion: number;
  page: {
    returned: number;
    requestedLimit: number;
    hasMore: boolean;
    nextCursor: unknown;
    stopReason: "row_limit" | "byte_limit" | "end";
    consistency: "live";
  };
};
export type getRowInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowId: string;
};
export type getRowOutput = {
  id: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  hasComments?: boolean;
  values: Record<
    string,
    null | boolean | number | string | unknown[] | Record<string, unknown>
  >;
};
export type createRowInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  values: Record<
    string,
    null | boolean | number | string | unknown[] | Record<string, unknown>
  >;
};
export type createRowOutput = {
  row: {
    id: string;
    version: string;
    createdAt: string;
    updatedAt: string;
    hasComments?: boolean;
    values: Record<
      string,
      null | boolean | number | string | unknown[] | Record<string, unknown>
    >;
  };
  mutationId: string;
};
export type listRowCommentsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowId: string;
  limit?: number;
  cursor?: string | null;
};
export type listRowCommentsOutput = {
  data: {
    id: string;
    rowId: string;
    authorUserId: string | null;
    authorName: string;
    body: string;
    createdAt: string;
    deletedAt: string | null;
    canDelete: boolean;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type countRowCommentsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowIds: string[];
};
export type countRowCommentsOutput = {
  data: { rowId: string; count: number }[];
};
export type createRowCommentInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowId: string;
  body: string;
};
export type createRowCommentOutput = { id: string };
export type deleteRowCommentInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowId: string;
  commentId: string;
};
export type deleteRowCommentOutput = { deleted: boolean; mutationId?: string };
export type updateRowInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  rowId: string;
  expectedVersion: string;
  values: Record<
    string,
    null | boolean | number | string | unknown[] | Record<string, unknown>
  >;
};
export type updateRowOutput = {
  row: {
    id: string;
    version: string;
    createdAt: string;
    updatedAt: string;
    hasComments?: boolean;
    values: Record<
      string,
      null | boolean | number | string | unknown[] | Record<string, unknown>
    >;
  };
  mutationId: string;
};
export type deleteRowInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  rowId: string;
  expectedVersion: string;
};
export type deleteRowOutput = { deleted: boolean; mutationId?: string };
export type previewBulkRowsInput = {
  expectedSchemaVersion: number;
  rows: { rowId: string; expectedVersion: string }[];
  action:
    | {
        type: "set";
        values: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
      }
    | { type: "duplicate" }
    | { type: "delete" };
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type previewBulkRowsOutput = {
  action: "set" | "duplicate" | "delete";
  total: number;
  valid: number;
  schemaVersion: number;
  issues: {
    index: number;
    rowId: string;
    code: string;
    message: string;
    fieldId?: string;
    ruleId?: string;
  }[];
  sample: {
    rowId: string;
    before: Record<
      string,
      null | boolean | number | string | unknown[] | Record<string, unknown>
    >;
    after?: Record<
      string,
      null | boolean | number | string | unknown[] | Record<string, unknown>
    >;
  }[];
};
export type bulkRowsInput = {
  expectedSchemaVersion: number;
  rows: { rowId: string; expectedVersion: string }[];
  action:
    | {
        type: "set";
        values: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
      }
    | { type: "duplicate" }
    | { type: "delete" };
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type bulkRowsOutput = {
  mutationId: string;
  action: "set" | "duplicate" | "delete";
  affected: number;
  createdIds: string[];
  deletedIds: string[];
};
export type mutateRowsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  mutations: (
    | {
        type: "create";
        values: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
      }
    | {
        rowId: string;
        expectedVersion: string;
        values: Record<
          string,
          null | boolean | number | string | unknown[] | Record<string, unknown>
        >;
        type: "update";
      }
    | { type: "delete"; rowId: string; expectedVersion: string }
  )[];
  repair?: { reason: string };
};
export type mutateRowsOutput =
  | {
      mutationId: string;
      results: {
        type: "create" | "update" | "delete";
        rowId: string;
        row?: {
          id: string;
          version: string;
          createdAt: string;
          updatedAt: string;
          hasComments?: boolean;
          values: Record<
            string,
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>
          >;
        };
        deleted?: boolean;
      }[];
    }
  | {
      jobId: string;
      state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "partially_completed";
      statusUrl: string;
    };
export type getTableStatisticsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type getTableStatisticsOutput = {
  liveRows: number;
  rowCountKind: "cached" | "live" | "approximate";
  storageBytes: number;
  indexBytes: number;
  historyEvents: number;
  asOf: string;
};
export type countRowsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  query?: {
    select?: string[];
    where?:
      | {
          field: string;
          op:
            | "eq"
            | "ne"
            | "lt"
            | "lte"
            | "gt"
            | "gte"
            | "between"
            | "in"
            | "isNull"
            | "isNotNull"
            | "prefix"
            | "contains"
            | "iContains"
            | "pathExists"
            | "pathEq"
            | "jsonContains";
          value?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          path?: (string | number)[];
        }
      | { and: JsonValue[] }
      | { or: JsonValue[] };
    orderBy?: { field: string; direction: "asc" | "desc" }[];
    limit?: number;
    cursor?: string | null;
  };
  exact?: boolean;
};
export type countRowsOutput =
  | {
      count: number;
      kind: "cached" | "live" | "approximate" | "exact";
      asOf: string;
    }
  | {
      jobId: string;
      state:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "partially_completed";
      statusUrl: string;
    };
export type getCellHistoryInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowId: string;
  fieldId: string;
  limit?: number;
  cursor?: string | null;
};
export type getCellHistoryOutput = {
  data: {
    id: string;
    orgId: string;
    databaseId: string;
    tableId: string;
    rowId: string;
    fieldId: string;
    mutationId: string;
    requestId: string;
    actor: {
      id: string;
      kind: string;
      credentialId?: string;
      clientId?: string;
    };
    source: string;
    operation: "create" | "update" | "delete" | "conversion" | "repair";
    before:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    after:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    fieldDefinition:
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "text";
          allowedValues?: string[] | null;
          charLimit?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "integer";
          autoIncrement?: boolean;
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "float";
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "uri";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "url";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "image";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "boolean";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "time";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date-time";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "json";
        };
    previousVersion: string | null;
    version: string;
    timestamp: string;
  }[];
  nextCursor: unknown;
  hasMore: boolean;
};
export type queryHistoryInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  rowId?: string;
  fieldId?: string;
  mutationId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string | null;
};
export type queryHistoryOutput = {
  data: {
    id: string;
    orgId: string;
    databaseId: string;
    tableId: string;
    rowId: string;
    fieldId: string;
    mutationId: string;
    requestId: string;
    actor: {
      id: string;
      kind: string;
      credentialId?: string;
      clientId?: string;
    };
    source: string;
    operation: "create" | "update" | "delete" | "conversion" | "repair";
    before:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    after:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    fieldDefinition:
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "text";
          allowedValues?: string[] | null;
          charLimit?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "integer";
          autoIncrement?: boolean;
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "float";
          min?: number;
          max?: number;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "uri";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "url";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "image";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "boolean";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "time";
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "date-time";
          min?: string;
          max?: string;
        }
      | {
          id: string;
          name: string;
          required?: boolean;
          default?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          order?: number;
          type: "json";
        };
    previousVersion: string | null;
    version: string;
    timestamp: string;
  }[];
  nextCursor: unknown;
  hasMore: boolean;
};
export type getMutationInput = { orgId: string; id: string };
export type getMutationOutput = {
  mutationId: string;
  replayed?: boolean;
  result?:
    null | boolean | number | string | unknown[] | Record<string, unknown>;
};
export type previewImportRowsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  format: "csv" | "jsonl";
  content: string;
  fileName: string;
  mapping: { source: string; fieldId: string }[];
};
export type previewImportRowsOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type importRowsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  previewId: string;
};
export type importRowsOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type exportRowsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  format: "csv" | "jsonl";
};
export type exportRowsOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type exportViewInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  format: "csv" | "jsonl";
  query: {
    select: string[];
    where?:
      | {
          field: string;
          op:
            | "eq"
            | "ne"
            | "lt"
            | "lte"
            | "gt"
            | "gte"
            | "between"
            | "in"
            | "isNull"
            | "isNotNull"
            | "prefix"
            | "contains"
            | "iContains"
            | "pathExists"
            | "pathEq"
            | "jsonContains";
          value?:
            | null
            | boolean
            | number
            | string
            | unknown[]
            | Record<string, unknown>;
          path?: (string | number)[];
        }
      | { and: JsonValue[] }
      | { or: JsonValue[] };
    orderBy?: { field: string; direction: "asc" | "desc" }[];
  };
};
export type exportViewOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type exportDatabaseInput = {
  orgId: string;
  databaseId: string;
  format: "csv" | "jsonl";
};
export type exportDatabaseOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type getArtifactInput = { orgId: string; id: string };
export type getArtifactOutput = {
  id: string;
  orgId: string;
  kind: "export" | "import_report";
  format: "csv" | "jsonl" | "json" | "zip";
  sizeBytes: number;
  checksum: string;
  expiresAt: string;
  downloadUrl?: string;
  resourceUri?: string;
  rowCount?: number;
  tableCount?: number;
};
export type listJobsInput = {
  orgId: string;
  limit?: number;
  cursor?: string | null;
  databaseId?: string;
  tableId?: string;
  state?:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  kind?: string;
  order?: "asc" | "desc";
};
export type listJobsOutput = {
  data: {
    backupId?: string;
    id: string;
    orgId: string;
    kind: string;
    operationId: string;
    fileName?: string;
    previewId?: string;
    cancelRequested?: boolean;
    format?: "csv" | "jsonl";
    exportScope?: "view" | "table" | "database";
    state:
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "partially_completed";
    stage?: string;
    databaseId?: string;
    tableId?: string;
    progress?: {
      completed: number;
      committed?: number;
      total?: number;
      unit?: string;
    };
    createdAt: string;
    updatedAt: string;
    result?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    error?: {
      code: string;
      message: string;
      requestId: string;
      details?:
        null | boolean | number | string | unknown[] | Record<string, unknown>;
    };
    checkpoint?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    attempt?: number;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type getJobInput = { orgId: string; id: string };
export type getJobOutput = {
  backupId?: string;
  id: string;
  orgId: string;
  kind: string;
  operationId: string;
  fileName?: string;
  previewId?: string;
  cancelRequested?: boolean;
  format?: "csv" | "jsonl";
  exportScope?: "view" | "table" | "database";
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  stage?: string;
  databaseId?: string;
  tableId?: string;
  progress?: {
    completed: number;
    committed?: number;
    total?: number;
    unit?: string;
  };
  createdAt: string;
  updatedAt: string;
  result?:
    null | boolean | number | string | unknown[] | Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
  };
  checkpoint?:
    null | boolean | number | string | unknown[] | Record<string, unknown>;
  attempt?: number;
};
export type cancelJobInput = { orgId: string; id: string };
export type cancelJobOutput = {
  backupId?: string;
  id: string;
  orgId: string;
  kind: string;
  operationId: string;
  fileName?: string;
  previewId?: string;
  cancelRequested?: boolean;
  format?: "csv" | "jsonl";
  exportScope?: "view" | "table" | "database";
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  stage?: string;
  databaseId?: string;
  tableId?: string;
  progress?: {
    completed: number;
    committed?: number;
    total?: number;
    unit?: string;
  };
  createdAt: string;
  updatedAt: string;
  result?:
    null | boolean | number | string | unknown[] | Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
  };
  checkpoint?:
    null | boolean | number | string | unknown[] | Record<string, unknown>;
  attempt?: number;
};
export type retryJobInput = { orgId: string; id: string };
export type retryJobOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type getUsageInput = { orgId: string };
export type getUsageOutput = {
  databases: number;
  tables: number;
  rows: number;
  dataBytes: number;
  indexBytes: number;
  historyBytes: number;
  artifactBytes: number;
};
export type getViewPreferencesInput = { tableId: string };
export type getViewPreferencesOutput = {
  tableId: string;
  preferences: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    foreignKeyDisplayFields?: Record<string, string>;
  };
};
export type updateViewPreferencesInput = {
  tableId: string;
  preferences: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    foreignKeyDisplayFields?: Record<string, string>;
  };
};
export type updateViewPreferencesOutput = {
  tableId: string;
  preferences: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    foreignKeyDisplayFields?: Record<string, string>;
  };
};
export type updateForeignKeyDisplayFieldInput = {
  tableId: string;
  foreignKeyId: string;
  displayFieldId: string | null;
};
export type updateForeignKeyDisplayFieldOutput = {
  tableId: string;
  preferences: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query?:
      null | boolean | number | string | unknown[] | Record<string, unknown>;
    foreignKeyDisplayFields?: Record<string, string>;
  };
};
export type listSavedViewsInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
};
export type listSavedViewsOutput = {
  data: {
    id: string;
    tableId: string;
    name: string;
    visibility: "personal" | "shared";
    ownerUserId: string | null;
    ownerName: string;
    version: string;
    schemaVersion: number;
    canEdit: boolean;
    canChangeVisibility: boolean;
    createdAt: string;
    updatedAt: string;
  }[];
};
export type getSavedViewInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  viewId: string;
};
export type getSavedViewOutput = {
  id: string;
  tableId: string;
  name: string;
  visibility: "personal" | "shared";
  ownerUserId: string | null;
  ownerName: string;
  version: string;
  schemaVersion: number;
  canEdit: boolean;
  canChangeVisibility: boolean;
  createdAt: string;
  updatedAt: string;
  definition: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query: {
      where?:
        | {
            field: string;
            op:
              | "eq"
              | "ne"
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "between"
              | "in"
              | "isNull"
              | "isNotNull"
              | "prefix"
              | "contains"
              | "iContains"
              | "pathExists"
              | "pathEq"
              | "jsonContains";
            value?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            path?: (string | number)[];
          }
        | { and: JsonValue[] }
        | { or: JsonValue[] };
      orderBy?: { field: string; direction: "asc" | "desc" }[];
    };
  };
  validationErrors: string[];
};
export type createSavedViewInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  name: string;
  visibility: "personal" | "shared";
  definition: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query: {
      where?:
        | {
            field: string;
            op:
              | "eq"
              | "ne"
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "between"
              | "in"
              | "isNull"
              | "isNotNull"
              | "prefix"
              | "contains"
              | "iContains"
              | "pathExists"
              | "pathEq"
              | "jsonContains";
            value?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            path?: (string | number)[];
          }
        | { and: JsonValue[] }
        | { or: JsonValue[] };
      orderBy?: { field: string; direction: "asc" | "desc" }[];
    };
  };
};
export type createSavedViewOutput = {
  id: string;
  tableId: string;
  name: string;
  visibility: "personal" | "shared";
  ownerUserId: string | null;
  ownerName: string;
  version: string;
  schemaVersion: number;
  canEdit: boolean;
  canChangeVisibility: boolean;
  createdAt: string;
  updatedAt: string;
  definition: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query: {
      where?:
        | {
            field: string;
            op:
              | "eq"
              | "ne"
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "between"
              | "in"
              | "isNull"
              | "isNotNull"
              | "prefix"
              | "contains"
              | "iContains"
              | "pathExists"
              | "pathEq"
              | "jsonContains";
            value?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            path?: (string | number)[];
          }
        | { and: JsonValue[] }
        | { or: JsonValue[] };
      orderBy?: { field: string; direction: "asc" | "desc" }[];
    };
  };
  validationErrors: string[];
};
export type updateSavedViewInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  expectedSchemaVersion: number;
  viewId: string;
  expectedVersion: string;
  name?: string;
  visibility?: "personal" | "shared";
  definition?: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query: {
      where?:
        | {
            field: string;
            op:
              | "eq"
              | "ne"
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "between"
              | "in"
              | "isNull"
              | "isNotNull"
              | "prefix"
              | "contains"
              | "iContains"
              | "pathExists"
              | "pathEq"
              | "jsonContains";
            value?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            path?: (string | number)[];
          }
        | { and: JsonValue[] }
        | { or: JsonValue[] };
      orderBy?: { field: string; direction: "asc" | "desc" }[];
    };
  };
};
export type updateSavedViewOutput = {
  id: string;
  tableId: string;
  name: string;
  visibility: "personal" | "shared";
  ownerUserId: string | null;
  ownerName: string;
  version: string;
  schemaVersion: number;
  canEdit: boolean;
  canChangeVisibility: boolean;
  createdAt: string;
  updatedAt: string;
  definition: {
    columnOrder: string[];
    columnWidths: Record<string, number>;
    frozenColumns: number;
    hiddenColumns: string[];
    query: {
      where?:
        | {
            field: string;
            op:
              | "eq"
              | "ne"
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "between"
              | "in"
              | "isNull"
              | "isNotNull"
              | "prefix"
              | "contains"
              | "iContains"
              | "pathExists"
              | "pathEq"
              | "jsonContains";
            value?:
              | null
              | boolean
              | number
              | string
              | unknown[]
              | Record<string, unknown>;
            path?: (string | number)[];
          }
        | { and: JsonValue[] }
        | { or: JsonValue[] };
      orderBy?: { field: string; direction: "asc" | "desc" }[];
    };
  };
  validationErrors: string[];
};
export type deleteSavedViewInput = {
  orgId: string;
  databaseId: string;
  tableId: string;
  viewId: string;
  expectedVersion: string;
};
export type deleteSavedViewOutput = {
  id: string;
  deleted: true;
  version: string;
};
export type getDatabaseBackupPolicyInput = {
  orgId: string;
  databaseId: string;
};
export type getDatabaseBackupPolicyOutput = {
  policy: {
    retentionCount: number | null;
    overdueGraceMinutes: number;
    databaseId: string;
    version: number;
    updatedAt: string | null;
  };
  emailDeliveryAvailable: boolean;
  lastSuccessful: {
    backupId: string;
    snapshotAt: string;
    completedAt: string;
    bucket: string;
    objectKey: string;
  } | null;
  alerts: {
    id: string;
    kind: "failed" | "overdue";
    backupId: string | null;
    occurrenceAt: string;
    detectedAt: string;
    notifiedAt: string | null;
  }[];
  retentionError: unknown;
};
export type saveDatabaseBackupPolicyInput = {
  expectedVersion: number;
  retentionCount: number | null;
  overdueGraceMinutes: number;
  orgId: string;
  databaseId: string;
};
export type saveDatabaseBackupPolicyOutput = {
  policy: {
    retentionCount: number | null;
    overdueGraceMinutes: number;
    databaseId: string;
    version: number;
    updatedAt: string | null;
  };
  emailDeliveryAvailable: boolean;
  lastSuccessful: {
    backupId: string;
    snapshotAt: string;
    completedAt: string;
    bucket: string;
    objectKey: string;
  } | null;
  alerts: {
    id: string;
    kind: "failed" | "overdue";
    backupId: string | null;
    occurrenceAt: string;
    detectedAt: string;
    notifiedAt: string | null;
  }[];
  retentionError: unknown;
};
export type getBackupScheduleInput = { orgId: string; databaseId: string };
export type getBackupScheduleOutput = {
  schedule: {
    bucket: string;
    prefix: string;
    cron: string;
    timezone: string;
    databaseId: string;
    version: number;
    backendId: string;
    nextRunAt: string | null;
    testedAt: string | null;
    updatedAt: string;
  } | null;
  version: number;
  pendingSaveJobId: string | null;
  worker: { available: boolean; backendId: unknown; matchesSchedule: boolean };
  nextRuns: string[];
};
export type saveBackupScheduleInput = {
  bucket: string;
  prefix: string;
  cron: string;
  timezone: string;
  expectedVersion: number;
  orgId: string;
  databaseId: string;
};
export type saveBackupScheduleOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type deleteBackupScheduleInput = {
  orgId: string;
  databaseId: string;
  expectedVersion: number;
};
export type deleteBackupScheduleOutput = {
  schedule: {
    bucket: string;
    prefix: string;
    cron: string;
    timezone: string;
    databaseId: string;
    version: number;
    backendId: string;
    nextRunAt: string | null;
    testedAt: string | null;
    updatedAt: string;
  } | null;
  version: number;
  pendingSaveJobId: string | null;
  worker: { available: boolean; backendId: unknown; matchesSchedule: boolean };
  nextRuns: string[];
};
export type previewBackupScheduleInput = {
  cron: string;
  timezone: string;
  orgId: string;
  databaseId: string;
};
export type previewBackupScheduleOutput = { nextRuns: string[] };
export type listDatabaseBackupsInput = {
  orgId: string;
  databaseId: string;
  limit?: number;
  cursor?: string | null;
};
export type listDatabaseBackupsOutput = {
  data: {
    storageState: "available" | "deleting" | "pruned";
    prunedAt: string | null;
    retentionError: unknown;
    id: string;
    jobId: string | null;
    kind: "backup" | "destination_test" | "skipped";
    trigger: "manual" | "schedule";
    state:
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "skipped"
      | "partially_completed";
    stage: string;
    scheduledAt: string;
    skippedUntil: string | null;
    snapshotAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    bucket: string;
    objectKey: unknown;
    sizeBytes: number | null;
    checksum: unknown;
    tableCount: number | null;
    rowCount: number | null;
    attempt: number;
    error: unknown;
    note: unknown;
  }[];
  nextCursor?: unknown;
  hasMore?: boolean;
};
export type runDatabaseBackupInput = { orgId: string; databaseId: string };
export type runDatabaseBackupOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type testBackupDestinationInput = {
  bucket: string;
  prefix: string;
  orgId: string;
  databaseId: string;
};
export type testBackupDestinationOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type previewDatabaseRestoreInput = { orgId: string; backupId: string };
export type previewDatabaseRestoreOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export type restoreDatabaseBackupInput = {
  orgId: string;
  backupId: string;
  previewId: string;
  name: string;
};
export type restoreDatabaseBackupOutput = {
  jobId: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "partially_completed";
  statusUrl: string;
};
export interface CallOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}
const routes = {
  getContext: {
    path: "/v1/me",
    method: "GET",
    idempotencyRequired: false,
  },
  getProfile: {
    path: "/v1/me/profile",
    method: "GET",
    idempotencyRequired: false,
  },
  updateProfile: {
    path: "/v1/me/profile",
    method: "PATCH",
    idempotencyRequired: true,
  },
  getPreferences: {
    path: "/v1/me/preferences",
    method: "GET",
    idempotencyRequired: false,
  },
  updatePreferences: {
    path: "/v1/me/preferences",
    method: "PATCH",
    idempotencyRequired: true,
  },
  getPreferenceOptions: {
    path: "/v1/preferences/options",
    method: "GET",
    idempotencyRequired: false,
  },
  previewPreferences: {
    path: "/v1/me/preferences/preview",
    method: "POST",
    idempotencyRequired: false,
  },
  listSessions: {
    path: "/v1/me/sessions",
    method: "GET",
    idempotencyRequired: false,
  },
  revokeSession: {
    path: "/v1/me/sessions/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  listConnections: {
    path: "/v1/me/connections",
    method: "GET",
    idempotencyRequired: false,
  },
  revokeConnection: {
    path: "/v1/me/connections/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  getOrganisation: {
    path: "/v1/orgs/{orgId}",
    method: "GET",
    idempotencyRequired: false,
  },
  updateOrganisation: {
    path: "/v1/orgs/{orgId}",
    method: "PATCH",
    idempotencyRequired: true,
  },
  listMembers: {
    path: "/v1/orgs/{orgId}/members",
    method: "GET",
    idempotencyRequired: false,
  },
  updateMember: {
    path: "/v1/orgs/{orgId}/members/{id}",
    method: "PATCH",
    idempotencyRequired: true,
  },
  removeMember: {
    path: "/v1/orgs/{orgId}/members/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  listInvitations: {
    path: "/v1/orgs/{orgId}/invitations",
    method: "GET",
    idempotencyRequired: false,
  },
  inviteMember: {
    path: "/v1/orgs/{orgId}/invitations",
    method: "POST",
    idempotencyRequired: true,
  },
  cancelInvitation: {
    path: "/v1/orgs/{orgId}/invitations/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  listPersonalKeys: {
    path: "/v1/me/keys",
    method: "GET",
    idempotencyRequired: false,
  },
  createPersonalKey: {
    path: "/v1/me/keys",
    method: "POST",
    idempotencyRequired: true,
  },
  rotatePersonalKey: {
    path: "/v1/me/keys/{id}/rotate",
    method: "POST",
    idempotencyRequired: true,
  },
  revokePersonalKey: {
    path: "/v1/me/keys/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  listTeamKeys: {
    path: "/v1/orgs/{orgId}/keys",
    method: "GET",
    idempotencyRequired: false,
  },
  createTeamKey: {
    path: "/v1/orgs/{orgId}/keys",
    method: "POST",
    idempotencyRequired: true,
  },
  rotateTeamKey: {
    path: "/v1/orgs/{orgId}/keys/{id}/rotate",
    method: "POST",
    idempotencyRequired: true,
  },
  revokeTeamKey: {
    path: "/v1/orgs/{orgId}/keys/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  getSecurityStatus: {
    path: "/v1/me/security",
    method: "GET",
    idempotencyRequired: false,
  },
  listDatabases: {
    path: "/v1/orgs/{orgId}/databases",
    method: "GET",
    idempotencyRequired: false,
  },
  createDatabase: {
    path: "/v1/orgs/{orgId}/databases",
    method: "POST",
    idempotencyRequired: true,
  },
  getDatabase: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}",
    method: "GET",
    idempotencyRequired: false,
  },
  updateDatabase: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}",
    method: "PATCH",
    idempotencyRequired: true,
  },
  deleteDatabase: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  listTables: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables",
    method: "GET",
    idempotencyRequired: false,
  },
  createTable: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables",
    method: "POST",
    idempotencyRequired: true,
  },
  getTable: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}",
    method: "GET",
    idempotencyRequired: false,
  },
  updateTable: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}",
    method: "PATCH",
    idempotencyRequired: true,
  },
  deleteTable: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  getTableSchema: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/schema",
    method: "GET",
    idempotencyRequired: false,
  },
  listFields: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/fields",
    method: "GET",
    idempotencyRequired: false,
  },
  createField: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/fields",
    method: "POST",
    idempotencyRequired: true,
  },
  updateField: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/fields/{fieldId}",
    method: "PATCH",
    idempotencyRequired: true,
  },
  deleteField: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/fields/{fieldId}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  reorderFields: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/field-order",
    method: "PUT",
    idempotencyRequired: true,
  },
  previewSchemaChange: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/schema/preview",
    method: "POST",
    idempotencyRequired: false,
  },
  applySchemaChange: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/schema/operations",
    method: "POST",
    idempotencyRequired: true,
  },
  getSchemaOperation: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/schema/operations/{id}",
    method: "GET",
    idempotencyRequired: false,
  },
  listUniqueRules: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/unique-rules",
    method: "GET",
    idempotencyRequired: false,
  },
  createUniqueRule: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/unique-rules",
    method: "POST",
    idempotencyRequired: true,
  },
  deleteUniqueRule: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/unique-rules/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  getRowRelationships: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}/relationships",
    method: "GET",
    idempotencyRequired: false,
  },
  getRelatedRowFilter: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/relationships/{ruleId}/records/{referencedRowId}/filter",
    method: "GET",
    idempotencyRequired: false,
  },
  listForeignKeys: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/foreign-keys",
    method: "GET",
    idempotencyRequired: false,
  },
  createForeignKey: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/foreign-keys",
    method: "POST",
    idempotencyRequired: true,
  },
  deleteForeignKey: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/foreign-keys/{id}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  listRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows",
    method: "GET",
    idempotencyRequired: false,
  },
  queryRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/query",
    method: "POST",
    idempotencyRequired: false,
  },
  getRow: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}",
    method: "GET",
    idempotencyRequired: false,
  },
  createRow: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows",
    method: "POST",
    idempotencyRequired: true,
  },
  listRowComments: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}/comments",
    method: "GET",
    idempotencyRequired: false,
  },
  countRowComments: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/comments/counts",
    method: "POST",
    idempotencyRequired: false,
  },
  createRowComment: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}/comments",
    method: "POST",
    idempotencyRequired: true,
  },
  deleteRowComment: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}/comments/{commentId}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  updateRow: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}",
    method: "PATCH",
    idempotencyRequired: true,
  },
  deleteRow: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  previewBulkRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/bulk/preview",
    method: "POST",
    idempotencyRequired: false,
  },
  bulkRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/bulk",
    method: "POST",
    idempotencyRequired: true,
  },
  mutateRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/batch",
    method: "POST",
    idempotencyRequired: true,
  },
  getTableStatistics: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/statistics",
    method: "GET",
    idempotencyRequired: false,
  },
  countRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/count",
    method: "POST",
    idempotencyRequired: false,
  },
  getCellHistory: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/{rowId}/cells/{fieldId}/history",
    method: "GET",
    idempotencyRequired: false,
  },
  queryHistory: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/history/query",
    method: "POST",
    idempotencyRequired: false,
  },
  getMutation: {
    path: "/v1/orgs/{orgId}/mutations/{id}",
    method: "GET",
    idempotencyRequired: false,
  },
  previewImportRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/imports/preview",
    method: "POST",
    idempotencyRequired: true,
  },
  importRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/imports",
    method: "POST",
    idempotencyRequired: true,
  },
  exportRows: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/exports",
    method: "POST",
    idempotencyRequired: true,
  },
  exportView: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/view-exports",
    method: "POST",
    idempotencyRequired: true,
  },
  exportDatabase: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/exports",
    method: "POST",
    idempotencyRequired: true,
  },
  getArtifact: {
    path: "/v1/orgs/{orgId}/artifacts/{id}",
    method: "GET",
    idempotencyRequired: false,
  },
  listJobs: {
    path: "/v1/orgs/{orgId}/jobs",
    method: "GET",
    idempotencyRequired: false,
  },
  getJob: {
    path: "/v1/orgs/{orgId}/jobs/{id}",
    method: "GET",
    idempotencyRequired: false,
  },
  cancelJob: {
    path: "/v1/orgs/{orgId}/jobs/{id}/cancel",
    method: "POST",
    idempotencyRequired: true,
  },
  retryJob: {
    path: "/v1/orgs/{orgId}/jobs/{id}/retry",
    method: "POST",
    idempotencyRequired: true,
  },
  getUsage: {
    path: "/v1/orgs/{orgId}/usage",
    method: "GET",
    idempotencyRequired: false,
  },
  getViewPreferences: {
    path: "/v1/me/view-preferences/{tableId}",
    method: "GET",
    idempotencyRequired: false,
  },
  updateViewPreferences: {
    path: "/v1/me/view-preferences/{tableId}",
    method: "PUT",
    idempotencyRequired: true,
  },
  updateForeignKeyDisplayField: {
    path: "/v1/me/view-preferences/{tableId}/foreign-keys/{foreignKeyId}",
    method: "PUT",
    idempotencyRequired: true,
  },
  listSavedViews: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/views",
    method: "GET",
    idempotencyRequired: false,
  },
  getSavedView: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/views/{viewId}",
    method: "GET",
    idempotencyRequired: false,
  },
  createSavedView: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/views",
    method: "POST",
    idempotencyRequired: true,
  },
  updateSavedView: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/views/{viewId}",
    method: "PATCH",
    idempotencyRequired: true,
  },
  deleteSavedView: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/views/{viewId}",
    method: "DELETE",
    idempotencyRequired: true,
  },
  getDatabaseBackupPolicy: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backup-policy",
    method: "GET",
    idempotencyRequired: false,
  },
  saveDatabaseBackupPolicy: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backup-policy",
    method: "PUT",
    idempotencyRequired: true,
  },
  getBackupSchedule: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backup-schedule",
    method: "GET",
    idempotencyRequired: false,
  },
  saveBackupSchedule: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backup-schedule",
    method: "PUT",
    idempotencyRequired: true,
  },
  deleteBackupSchedule: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backup-schedule",
    method: "DELETE",
    idempotencyRequired: true,
  },
  previewBackupSchedule: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backup-schedule/preview",
    method: "POST",
    idempotencyRequired: false,
  },
  listDatabaseBackups: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backups",
    method: "GET",
    idempotencyRequired: false,
  },
  runDatabaseBackup: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backups",
    method: "POST",
    idempotencyRequired: true,
  },
  testBackupDestination: {
    path: "/v1/orgs/{orgId}/databases/{databaseId}/backup-schedule/test",
    method: "POST",
    idempotencyRequired: true,
  },
  previewDatabaseRestore: {
    path: "/v1/orgs/{orgId}/backups/{backupId}/restore-preview",
    method: "POST",
    idempotencyRequired: true,
  },
  restoreDatabaseBackup: {
    path: "/v1/orgs/{orgId}/backups/{backupId}/restore",
    method: "POST",
    idempotencyRequired: true,
  },
} as const;
export class RootsetClient {
  constructor(
    readonly baseUrl: string,
    readonly options: {
      bearer?: string;
      fetch?: typeof fetch;
      internal?: boolean;
    } = {},
  ) {}
  private async call(
    operationId: keyof typeof routes,
    input: object,
    call: CallOptions = {},
  ): Promise<unknown> {
    const operation = routes[operationId];
    const body = { ...input } as Record<string, unknown>;
    let path: string = operation.path;
    path = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = body[name];
      if (typeof value !== "string")
        throw new Error("Missing path parameter " + name);
      delete body[name];
      return encodeURIComponent(value);
    });
    if (this.options.internal) path = path.replace(/^\/v1/, "/api/internal/v1");
    const headers = new Headers({ Accept: "application/json" });
    if (this.options.bearer)
      headers.set("Authorization", "Bearer " + this.options.bearer);
    if (operation.idempotencyRequired) {
      if (!call.idempotencyKey) throw new Error("Idempotency-Key is required");
      headers.set("Idempotency-Key", call.idempotencyKey);
    }
    if (operationId === "deleteRow") {
      const rowId = (input as Record<string, unknown>).rowId;
      headers.set(
        "If-Match",
        '"' + String(rowId) + ":" + String(body.expectedVersion) + '"',
      );
    }
    const url = new URL(path, this.baseUrl);
    let encoded: string | undefined;
    if (operation.method === "GET") {
      for (const [name, value] of Object.entries(body))
        if (value !== undefined)
          url.searchParams.set(
            name,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
    } else {
      headers.set("Content-Type", "application/json");
      encoded = JSON.stringify(body);
    }
    const response = await (this.options.fetch ?? fetch)(url, {
      method: operation.method,
      headers,
      body: encoded,
      signal: call.signal,
      credentials: "include",
    });
    const result = (await response.json()) as unknown;
    if (!response.ok) {
      const error = new Error("Rootset request failed");
      Object.assign(error, { status: response.status, result });
      throw error;
    }
    return result;
  }
  getContext(
    input: getContextInput,
    options?: CallOptions,
  ): Promise<getContextOutput> {
    return this.call("getContext", input, options) as Promise<getContextOutput>;
  }
  getProfile(
    input: getProfileInput,
    options?: CallOptions,
  ): Promise<getProfileOutput> {
    return this.call("getProfile", input, options) as Promise<getProfileOutput>;
  }
  updateProfile(
    input: updateProfileInput,
    options?: CallOptions,
  ): Promise<updateProfileOutput> {
    return this.call(
      "updateProfile",
      input,
      options,
    ) as Promise<updateProfileOutput>;
  }
  getPreferences(
    input: getPreferencesInput,
    options?: CallOptions,
  ): Promise<getPreferencesOutput> {
    return this.call(
      "getPreferences",
      input,
      options,
    ) as Promise<getPreferencesOutput>;
  }
  updatePreferences(
    input: updatePreferencesInput,
    options?: CallOptions,
  ): Promise<updatePreferencesOutput> {
    return this.call(
      "updatePreferences",
      input,
      options,
    ) as Promise<updatePreferencesOutput>;
  }
  getPreferenceOptions(
    input: getPreferenceOptionsInput,
    options?: CallOptions,
  ): Promise<getPreferenceOptionsOutput> {
    return this.call(
      "getPreferenceOptions",
      input,
      options,
    ) as Promise<getPreferenceOptionsOutput>;
  }
  previewPreferences(
    input: previewPreferencesInput,
    options?: CallOptions,
  ): Promise<previewPreferencesOutput> {
    return this.call(
      "previewPreferences",
      input,
      options,
    ) as Promise<previewPreferencesOutput>;
  }
  listSessions(
    input: listSessionsInput,
    options?: CallOptions,
  ): Promise<listSessionsOutput> {
    return this.call(
      "listSessions",
      input,
      options,
    ) as Promise<listSessionsOutput>;
  }
  revokeSession(
    input: revokeSessionInput,
    options?: CallOptions,
  ): Promise<revokeSessionOutput> {
    return this.call(
      "revokeSession",
      input,
      options,
    ) as Promise<revokeSessionOutput>;
  }
  listConnections(
    input: listConnectionsInput,
    options?: CallOptions,
  ): Promise<listConnectionsOutput> {
    return this.call(
      "listConnections",
      input,
      options,
    ) as Promise<listConnectionsOutput>;
  }
  revokeConnection(
    input: revokeConnectionInput,
    options?: CallOptions,
  ): Promise<revokeConnectionOutput> {
    return this.call(
      "revokeConnection",
      input,
      options,
    ) as Promise<revokeConnectionOutput>;
  }
  getOrganisation(
    input: getOrganisationInput,
    options?: CallOptions,
  ): Promise<getOrganisationOutput> {
    return this.call(
      "getOrganisation",
      input,
      options,
    ) as Promise<getOrganisationOutput>;
  }
  updateOrganisation(
    input: updateOrganisationInput,
    options?: CallOptions,
  ): Promise<updateOrganisationOutput> {
    return this.call(
      "updateOrganisation",
      input,
      options,
    ) as Promise<updateOrganisationOutput>;
  }
  listMembers(
    input: listMembersInput,
    options?: CallOptions,
  ): Promise<listMembersOutput> {
    return this.call(
      "listMembers",
      input,
      options,
    ) as Promise<listMembersOutput>;
  }
  updateMember(
    input: updateMemberInput,
    options?: CallOptions,
  ): Promise<updateMemberOutput> {
    return this.call(
      "updateMember",
      input,
      options,
    ) as Promise<updateMemberOutput>;
  }
  removeMember(
    input: removeMemberInput,
    options?: CallOptions,
  ): Promise<removeMemberOutput> {
    return this.call(
      "removeMember",
      input,
      options,
    ) as Promise<removeMemberOutput>;
  }
  listInvitations(
    input: listInvitationsInput,
    options?: CallOptions,
  ): Promise<listInvitationsOutput> {
    return this.call(
      "listInvitations",
      input,
      options,
    ) as Promise<listInvitationsOutput>;
  }
  inviteMember(
    input: inviteMemberInput,
    options?: CallOptions,
  ): Promise<inviteMemberOutput> {
    return this.call(
      "inviteMember",
      input,
      options,
    ) as Promise<inviteMemberOutput>;
  }
  cancelInvitation(
    input: cancelInvitationInput,
    options?: CallOptions,
  ): Promise<cancelInvitationOutput> {
    return this.call(
      "cancelInvitation",
      input,
      options,
    ) as Promise<cancelInvitationOutput>;
  }
  listPersonalKeys(
    input: listPersonalKeysInput,
    options?: CallOptions,
  ): Promise<listPersonalKeysOutput> {
    return this.call(
      "listPersonalKeys",
      input,
      options,
    ) as Promise<listPersonalKeysOutput>;
  }
  createPersonalKey(
    input: createPersonalKeyInput,
    options?: CallOptions,
  ): Promise<createPersonalKeyOutput> {
    return this.call(
      "createPersonalKey",
      input,
      options,
    ) as Promise<createPersonalKeyOutput>;
  }
  rotatePersonalKey(
    input: rotatePersonalKeyInput,
    options?: CallOptions,
  ): Promise<rotatePersonalKeyOutput> {
    return this.call(
      "rotatePersonalKey",
      input,
      options,
    ) as Promise<rotatePersonalKeyOutput>;
  }
  revokePersonalKey(
    input: revokePersonalKeyInput,
    options?: CallOptions,
  ): Promise<revokePersonalKeyOutput> {
    return this.call(
      "revokePersonalKey",
      input,
      options,
    ) as Promise<revokePersonalKeyOutput>;
  }
  listTeamKeys(
    input: listTeamKeysInput,
    options?: CallOptions,
  ): Promise<listTeamKeysOutput> {
    return this.call(
      "listTeamKeys",
      input,
      options,
    ) as Promise<listTeamKeysOutput>;
  }
  createTeamKey(
    input: createTeamKeyInput,
    options?: CallOptions,
  ): Promise<createTeamKeyOutput> {
    return this.call(
      "createTeamKey",
      input,
      options,
    ) as Promise<createTeamKeyOutput>;
  }
  rotateTeamKey(
    input: rotateTeamKeyInput,
    options?: CallOptions,
  ): Promise<rotateTeamKeyOutput> {
    return this.call(
      "rotateTeamKey",
      input,
      options,
    ) as Promise<rotateTeamKeyOutput>;
  }
  revokeTeamKey(
    input: revokeTeamKeyInput,
    options?: CallOptions,
  ): Promise<revokeTeamKeyOutput> {
    return this.call(
      "revokeTeamKey",
      input,
      options,
    ) as Promise<revokeTeamKeyOutput>;
  }
  getSecurityStatus(
    input: getSecurityStatusInput,
    options?: CallOptions,
  ): Promise<getSecurityStatusOutput> {
    return this.call(
      "getSecurityStatus",
      input,
      options,
    ) as Promise<getSecurityStatusOutput>;
  }
  listDatabases(
    input: listDatabasesInput,
    options?: CallOptions,
  ): Promise<listDatabasesOutput> {
    return this.call(
      "listDatabases",
      input,
      options,
    ) as Promise<listDatabasesOutput>;
  }
  createDatabase(
    input: createDatabaseInput,
    options?: CallOptions,
  ): Promise<createDatabaseOutput> {
    return this.call(
      "createDatabase",
      input,
      options,
    ) as Promise<createDatabaseOutput>;
  }
  getDatabase(
    input: getDatabaseInput,
    options?: CallOptions,
  ): Promise<getDatabaseOutput> {
    return this.call(
      "getDatabase",
      input,
      options,
    ) as Promise<getDatabaseOutput>;
  }
  updateDatabase(
    input: updateDatabaseInput,
    options?: CallOptions,
  ): Promise<updateDatabaseOutput> {
    return this.call(
      "updateDatabase",
      input,
      options,
    ) as Promise<updateDatabaseOutput>;
  }
  deleteDatabase(
    input: deleteDatabaseInput,
    options?: CallOptions,
  ): Promise<deleteDatabaseOutput> {
    return this.call(
      "deleteDatabase",
      input,
      options,
    ) as Promise<deleteDatabaseOutput>;
  }
  listTables(
    input: listTablesInput,
    options?: CallOptions,
  ): Promise<listTablesOutput> {
    return this.call("listTables", input, options) as Promise<listTablesOutput>;
  }
  createTable(
    input: createTableInput,
    options?: CallOptions,
  ): Promise<createTableOutput> {
    return this.call(
      "createTable",
      input,
      options,
    ) as Promise<createTableOutput>;
  }
  getTable(
    input: getTableInput,
    options?: CallOptions,
  ): Promise<getTableOutput> {
    return this.call("getTable", input, options) as Promise<getTableOutput>;
  }
  updateTable(
    input: updateTableInput,
    options?: CallOptions,
  ): Promise<updateTableOutput> {
    return this.call(
      "updateTable",
      input,
      options,
    ) as Promise<updateTableOutput>;
  }
  deleteTable(
    input: deleteTableInput,
    options?: CallOptions,
  ): Promise<deleteTableOutput> {
    return this.call(
      "deleteTable",
      input,
      options,
    ) as Promise<deleteTableOutput>;
  }
  getTableSchema(
    input: getTableSchemaInput,
    options?: CallOptions,
  ): Promise<getTableSchemaOutput> {
    return this.call(
      "getTableSchema",
      input,
      options,
    ) as Promise<getTableSchemaOutput>;
  }
  listFields(
    input: listFieldsInput,
    options?: CallOptions,
  ): Promise<listFieldsOutput> {
    return this.call("listFields", input, options) as Promise<listFieldsOutput>;
  }
  createField(
    input: createFieldInput,
    options?: CallOptions,
  ): Promise<createFieldOutput> {
    return this.call(
      "createField",
      input,
      options,
    ) as Promise<createFieldOutput>;
  }
  updateField(
    input: updateFieldInput,
    options?: CallOptions,
  ): Promise<updateFieldOutput> {
    return this.call(
      "updateField",
      input,
      options,
    ) as Promise<updateFieldOutput>;
  }
  deleteField(
    input: deleteFieldInput,
    options?: CallOptions,
  ): Promise<deleteFieldOutput> {
    return this.call(
      "deleteField",
      input,
      options,
    ) as Promise<deleteFieldOutput>;
  }
  reorderFields(
    input: reorderFieldsInput,
    options?: CallOptions,
  ): Promise<reorderFieldsOutput> {
    return this.call(
      "reorderFields",
      input,
      options,
    ) as Promise<reorderFieldsOutput>;
  }
  previewSchemaChange(
    input: previewSchemaChangeInput,
    options?: CallOptions,
  ): Promise<previewSchemaChangeOutput> {
    return this.call(
      "previewSchemaChange",
      input,
      options,
    ) as Promise<previewSchemaChangeOutput>;
  }
  applySchemaChange(
    input: applySchemaChangeInput,
    options?: CallOptions,
  ): Promise<applySchemaChangeOutput> {
    return this.call(
      "applySchemaChange",
      input,
      options,
    ) as Promise<applySchemaChangeOutput>;
  }
  getSchemaOperation(
    input: getSchemaOperationInput,
    options?: CallOptions,
  ): Promise<getSchemaOperationOutput> {
    return this.call(
      "getSchemaOperation",
      input,
      options,
    ) as Promise<getSchemaOperationOutput>;
  }
  listUniqueRules(
    input: listUniqueRulesInput,
    options?: CallOptions,
  ): Promise<listUniqueRulesOutput> {
    return this.call(
      "listUniqueRules",
      input,
      options,
    ) as Promise<listUniqueRulesOutput>;
  }
  createUniqueRule(
    input: createUniqueRuleInput,
    options?: CallOptions,
  ): Promise<createUniqueRuleOutput> {
    return this.call(
      "createUniqueRule",
      input,
      options,
    ) as Promise<createUniqueRuleOutput>;
  }
  deleteUniqueRule(
    input: deleteUniqueRuleInput,
    options?: CallOptions,
  ): Promise<deleteUniqueRuleOutput> {
    return this.call(
      "deleteUniqueRule",
      input,
      options,
    ) as Promise<deleteUniqueRuleOutput>;
  }
  getRowRelationships(
    input: getRowRelationshipsInput,
    options?: CallOptions,
  ): Promise<getRowRelationshipsOutput> {
    return this.call(
      "getRowRelationships",
      input,
      options,
    ) as Promise<getRowRelationshipsOutput>;
  }
  getRelatedRowFilter(
    input: getRelatedRowFilterInput,
    options?: CallOptions,
  ): Promise<getRelatedRowFilterOutput> {
    return this.call(
      "getRelatedRowFilter",
      input,
      options,
    ) as Promise<getRelatedRowFilterOutput>;
  }
  listForeignKeys(
    input: listForeignKeysInput,
    options?: CallOptions,
  ): Promise<listForeignKeysOutput> {
    return this.call(
      "listForeignKeys",
      input,
      options,
    ) as Promise<listForeignKeysOutput>;
  }
  createForeignKey(
    input: createForeignKeyInput,
    options?: CallOptions,
  ): Promise<createForeignKeyOutput> {
    return this.call(
      "createForeignKey",
      input,
      options,
    ) as Promise<createForeignKeyOutput>;
  }
  deleteForeignKey(
    input: deleteForeignKeyInput,
    options?: CallOptions,
  ): Promise<deleteForeignKeyOutput> {
    return this.call(
      "deleteForeignKey",
      input,
      options,
    ) as Promise<deleteForeignKeyOutput>;
  }
  listRows(
    input: listRowsInput,
    options?: CallOptions,
  ): Promise<listRowsOutput> {
    return this.call("listRows", input, options) as Promise<listRowsOutput>;
  }
  queryRows(
    input: queryRowsInput,
    options?: CallOptions,
  ): Promise<queryRowsOutput> {
    return this.call("queryRows", input, options) as Promise<queryRowsOutput>;
  }
  getRow(input: getRowInput, options?: CallOptions): Promise<getRowOutput> {
    return this.call("getRow", input, options) as Promise<getRowOutput>;
  }
  createRow(
    input: createRowInput,
    options?: CallOptions,
  ): Promise<createRowOutput> {
    return this.call("createRow", input, options) as Promise<createRowOutput>;
  }
  listRowComments(
    input: listRowCommentsInput,
    options?: CallOptions,
  ): Promise<listRowCommentsOutput> {
    return this.call(
      "listRowComments",
      input,
      options,
    ) as Promise<listRowCommentsOutput>;
  }
  countRowComments(
    input: countRowCommentsInput,
    options?: CallOptions,
  ): Promise<countRowCommentsOutput> {
    return this.call(
      "countRowComments",
      input,
      options,
    ) as Promise<countRowCommentsOutput>;
  }
  createRowComment(
    input: createRowCommentInput,
    options?: CallOptions,
  ): Promise<createRowCommentOutput> {
    return this.call(
      "createRowComment",
      input,
      options,
    ) as Promise<createRowCommentOutput>;
  }
  deleteRowComment(
    input: deleteRowCommentInput,
    options?: CallOptions,
  ): Promise<deleteRowCommentOutput> {
    return this.call(
      "deleteRowComment",
      input,
      options,
    ) as Promise<deleteRowCommentOutput>;
  }
  updateRow(
    input: updateRowInput,
    options?: CallOptions,
  ): Promise<updateRowOutput> {
    return this.call("updateRow", input, options) as Promise<updateRowOutput>;
  }
  deleteRow(
    input: deleteRowInput,
    options?: CallOptions,
  ): Promise<deleteRowOutput> {
    return this.call("deleteRow", input, options) as Promise<deleteRowOutput>;
  }
  previewBulkRows(
    input: previewBulkRowsInput,
    options?: CallOptions,
  ): Promise<previewBulkRowsOutput> {
    return this.call(
      "previewBulkRows",
      input,
      options,
    ) as Promise<previewBulkRowsOutput>;
  }
  bulkRows(
    input: bulkRowsInput,
    options?: CallOptions,
  ): Promise<bulkRowsOutput> {
    return this.call("bulkRows", input, options) as Promise<bulkRowsOutput>;
  }
  mutateRows(
    input: mutateRowsInput,
    options?: CallOptions,
  ): Promise<mutateRowsOutput> {
    return this.call("mutateRows", input, options) as Promise<mutateRowsOutput>;
  }
  getTableStatistics(
    input: getTableStatisticsInput,
    options?: CallOptions,
  ): Promise<getTableStatisticsOutput> {
    return this.call(
      "getTableStatistics",
      input,
      options,
    ) as Promise<getTableStatisticsOutput>;
  }
  countRows(
    input: countRowsInput,
    options?: CallOptions,
  ): Promise<countRowsOutput> {
    return this.call("countRows", input, options) as Promise<countRowsOutput>;
  }
  getCellHistory(
    input: getCellHistoryInput,
    options?: CallOptions,
  ): Promise<getCellHistoryOutput> {
    return this.call(
      "getCellHistory",
      input,
      options,
    ) as Promise<getCellHistoryOutput>;
  }
  queryHistory(
    input: queryHistoryInput,
    options?: CallOptions,
  ): Promise<queryHistoryOutput> {
    return this.call(
      "queryHistory",
      input,
      options,
    ) as Promise<queryHistoryOutput>;
  }
  getMutation(
    input: getMutationInput,
    options?: CallOptions,
  ): Promise<getMutationOutput> {
    return this.call(
      "getMutation",
      input,
      options,
    ) as Promise<getMutationOutput>;
  }
  previewImportRows(
    input: previewImportRowsInput,
    options?: CallOptions,
  ): Promise<previewImportRowsOutput> {
    return this.call(
      "previewImportRows",
      input,
      options,
    ) as Promise<previewImportRowsOutput>;
  }
  importRows(
    input: importRowsInput,
    options?: CallOptions,
  ): Promise<importRowsOutput> {
    return this.call("importRows", input, options) as Promise<importRowsOutput>;
  }
  exportRows(
    input: exportRowsInput,
    options?: CallOptions,
  ): Promise<exportRowsOutput> {
    return this.call("exportRows", input, options) as Promise<exportRowsOutput>;
  }
  exportView(
    input: exportViewInput,
    options?: CallOptions,
  ): Promise<exportViewOutput> {
    return this.call("exportView", input, options) as Promise<exportViewOutput>;
  }
  exportDatabase(
    input: exportDatabaseInput,
    options?: CallOptions,
  ): Promise<exportDatabaseOutput> {
    return this.call(
      "exportDatabase",
      input,
      options,
    ) as Promise<exportDatabaseOutput>;
  }
  getArtifact(
    input: getArtifactInput,
    options?: CallOptions,
  ): Promise<getArtifactOutput> {
    return this.call(
      "getArtifact",
      input,
      options,
    ) as Promise<getArtifactOutput>;
  }
  listJobs(
    input: listJobsInput,
    options?: CallOptions,
  ): Promise<listJobsOutput> {
    return this.call("listJobs", input, options) as Promise<listJobsOutput>;
  }
  getJob(input: getJobInput, options?: CallOptions): Promise<getJobOutput> {
    return this.call("getJob", input, options) as Promise<getJobOutput>;
  }
  cancelJob(
    input: cancelJobInput,
    options?: CallOptions,
  ): Promise<cancelJobOutput> {
    return this.call("cancelJob", input, options) as Promise<cancelJobOutput>;
  }
  retryJob(
    input: retryJobInput,
    options?: CallOptions,
  ): Promise<retryJobOutput> {
    return this.call("retryJob", input, options) as Promise<retryJobOutput>;
  }
  getUsage(
    input: getUsageInput,
    options?: CallOptions,
  ): Promise<getUsageOutput> {
    return this.call("getUsage", input, options) as Promise<getUsageOutput>;
  }
  getViewPreferences(
    input: getViewPreferencesInput,
    options?: CallOptions,
  ): Promise<getViewPreferencesOutput> {
    return this.call(
      "getViewPreferences",
      input,
      options,
    ) as Promise<getViewPreferencesOutput>;
  }
  updateViewPreferences(
    input: updateViewPreferencesInput,
    options?: CallOptions,
  ): Promise<updateViewPreferencesOutput> {
    return this.call(
      "updateViewPreferences",
      input,
      options,
    ) as Promise<updateViewPreferencesOutput>;
  }
  updateForeignKeyDisplayField(
    input: updateForeignKeyDisplayFieldInput,
    options?: CallOptions,
  ): Promise<updateForeignKeyDisplayFieldOutput> {
    return this.call(
      "updateForeignKeyDisplayField",
      input,
      options,
    ) as Promise<updateForeignKeyDisplayFieldOutput>;
  }
  listSavedViews(
    input: listSavedViewsInput,
    options?: CallOptions,
  ): Promise<listSavedViewsOutput> {
    return this.call(
      "listSavedViews",
      input,
      options,
    ) as Promise<listSavedViewsOutput>;
  }
  getSavedView(
    input: getSavedViewInput,
    options?: CallOptions,
  ): Promise<getSavedViewOutput> {
    return this.call(
      "getSavedView",
      input,
      options,
    ) as Promise<getSavedViewOutput>;
  }
  createSavedView(
    input: createSavedViewInput,
    options?: CallOptions,
  ): Promise<createSavedViewOutput> {
    return this.call(
      "createSavedView",
      input,
      options,
    ) as Promise<createSavedViewOutput>;
  }
  updateSavedView(
    input: updateSavedViewInput,
    options?: CallOptions,
  ): Promise<updateSavedViewOutput> {
    return this.call(
      "updateSavedView",
      input,
      options,
    ) as Promise<updateSavedViewOutput>;
  }
  deleteSavedView(
    input: deleteSavedViewInput,
    options?: CallOptions,
  ): Promise<deleteSavedViewOutput> {
    return this.call(
      "deleteSavedView",
      input,
      options,
    ) as Promise<deleteSavedViewOutput>;
  }
  getDatabaseBackupPolicy(
    input: getDatabaseBackupPolicyInput,
    options?: CallOptions,
  ): Promise<getDatabaseBackupPolicyOutput> {
    return this.call(
      "getDatabaseBackupPolicy",
      input,
      options,
    ) as Promise<getDatabaseBackupPolicyOutput>;
  }
  saveDatabaseBackupPolicy(
    input: saveDatabaseBackupPolicyInput,
    options?: CallOptions,
  ): Promise<saveDatabaseBackupPolicyOutput> {
    return this.call(
      "saveDatabaseBackupPolicy",
      input,
      options,
    ) as Promise<saveDatabaseBackupPolicyOutput>;
  }
  getBackupSchedule(
    input: getBackupScheduleInput,
    options?: CallOptions,
  ): Promise<getBackupScheduleOutput> {
    return this.call(
      "getBackupSchedule",
      input,
      options,
    ) as Promise<getBackupScheduleOutput>;
  }
  saveBackupSchedule(
    input: saveBackupScheduleInput,
    options?: CallOptions,
  ): Promise<saveBackupScheduleOutput> {
    return this.call(
      "saveBackupSchedule",
      input,
      options,
    ) as Promise<saveBackupScheduleOutput>;
  }
  deleteBackupSchedule(
    input: deleteBackupScheduleInput,
    options?: CallOptions,
  ): Promise<deleteBackupScheduleOutput> {
    return this.call(
      "deleteBackupSchedule",
      input,
      options,
    ) as Promise<deleteBackupScheduleOutput>;
  }
  previewBackupSchedule(
    input: previewBackupScheduleInput,
    options?: CallOptions,
  ): Promise<previewBackupScheduleOutput> {
    return this.call(
      "previewBackupSchedule",
      input,
      options,
    ) as Promise<previewBackupScheduleOutput>;
  }
  listDatabaseBackups(
    input: listDatabaseBackupsInput,
    options?: CallOptions,
  ): Promise<listDatabaseBackupsOutput> {
    return this.call(
      "listDatabaseBackups",
      input,
      options,
    ) as Promise<listDatabaseBackupsOutput>;
  }
  runDatabaseBackup(
    input: runDatabaseBackupInput,
    options?: CallOptions,
  ): Promise<runDatabaseBackupOutput> {
    return this.call(
      "runDatabaseBackup",
      input,
      options,
    ) as Promise<runDatabaseBackupOutput>;
  }
  testBackupDestination(
    input: testBackupDestinationInput,
    options?: CallOptions,
  ): Promise<testBackupDestinationOutput> {
    return this.call(
      "testBackupDestination",
      input,
      options,
    ) as Promise<testBackupDestinationOutput>;
  }
  previewDatabaseRestore(
    input: previewDatabaseRestoreInput,
    options?: CallOptions,
  ): Promise<previewDatabaseRestoreOutput> {
    return this.call(
      "previewDatabaseRestore",
      input,
      options,
    ) as Promise<previewDatabaseRestoreOutput>;
  }
  restoreDatabaseBackup(
    input: restoreDatabaseBackupInput,
    options?: CallOptions,
  ): Promise<restoreDatabaseBackupOutput> {
    return this.call(
      "restoreDatabaseBackup",
      input,
      options,
    ) as Promise<restoreDatabaseBackupOutput>;
  }
}
