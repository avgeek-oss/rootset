import { z } from "zod";
import { ulid } from "ulid";

export const limits = Object.freeze({
  maxRows: 5_000_000,
  maxFields: 200,
  rowBytes: 65_536,
  jsonDepth: 32,
  maxUniqueFields: 8,
  maxUniqueRules: 16,
  maxIndexes: 16,
  mutationBatch: 1_000,
  queryRows: 25_000,
  restDefaultRows: 5_000,
  mcpDefaultRows: 200,
  uiDefaultRows: 200,
  requestBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 10_000,
  restResultBytes: 8 * 1024 * 1024,
  mcpResultBytes: 1024 * 1024,
  queryTimeoutMs: 10_000,
  queryDepth: 8,
  queryPredicates: 100,
  querySorts: 8,
  cursorLifetimeMs: 60 * 60 * 1000,
  idempotencyLifetimeMs: 24 * 60 * 60 * 1000,
  textCharLimit: 4096,
  accessTokenLifetimeSeconds: 900,
  refreshInactivitySeconds: 7 * 86400,
  refreshAbsoluteSeconds: 30 * 86400,
  sessionLifetimeSeconds: 7 * 86400,
  recentAuthenticationSeconds: 300,
  apiKeyLifetimeSeconds: 90 * 86400,
  principalRequestsPerMinute: 120,
  concurrentReads: 10,
  concurrentMutations: 5,
});

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
function isJsonValue(value: unknown): value is JsonValue {
  const active = new Set<object>();
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [
    { value, depth: 0 },
  ];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.exit) {
      active.delete(current.value as object);
      continue;
    }
    const item = current.value;
    if (item === null || typeof item === "boolean" || typeof item === "string")
      continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (
      !item ||
      typeof item !== "object" ||
      current.depth >= 96 ||
      active.has(item) ||
      Object.getOwnPropertySymbols(item).length
    )
      return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    const keys = Object.keys(item);
    if (Array.isArray(item) && keys.length !== item.length) return false;
    if (Array.isArray(item))
      for (let index = 0; index < item.length; index++)
        if (!Object.hasOwn(item, index)) return false;
    active.add(item);
    pending.push({ value: item, depth: current.depth, exit: true });
    for (const child of Object.values(item))
      pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}
const jsonValueDescription = {
  description:
    "Any finite JSON value. Cell size/depth and typed numeric policies are enforced by the domain validator.",
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: {} },
  ],
};
/** Zod records discard __proto__; this validator preserves every user JSON key. */
export const JsonValueSchema = z
  .unknown()
  .refine(isJsonValue, "Expected a finite JSON value")
  .meta(jsonValueDescription) as z.ZodType<JsonValue>;

export function preservingRecordSchema<T>(
  keys: z.ZodString,
  values: z.ZodType<T>,
): z.ZodType<Record<string, T>> {
  const representation = z.toJSONSchema(z.record(keys, values), {
    io: "input",
    target: "draft-2020-12",
  });
  const metadata = { ...representation };
  delete metadata.$schema;
  return z
    .unknown()
    .transform((input, context) => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype &&
          Object.getPrototypeOf(input) !== null) ||
        Object.getOwnPropertySymbols(input).length
      ) {
        context.addIssue({ code: "custom", message: "Expected a JSON record" });
        return z.NEVER;
      }
      const output: Record<string, T> = Object.create(null) as Record<
        string,
        T
      >;
      for (const [key, value] of Object.entries(input)) {
        const checkedKey = keys.safeParse(key);
        const checkedValue = values.safeParse(value);
        if (!checkedKey.success || !checkedValue.success) {
          context.addIssue({
            code: "custom",
            message: "Invalid record key/value",
            path: [key],
          });
          continue;
        }
        Object.defineProperty(output, checkedKey.data, {
          value: checkedValue.data,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return output;
    })
    .meta(metadata) as z.ZodType<Record<string, T>>;
}

export const IdSchema = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i, "Expected a 26-character ULID")
  .transform((value) => value.toUpperCase());
export const VersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) => BigInt(value) <= 9223372036854775807n,
    "Version exceeds PostgreSQL bigint",
  );
export const SchemaVersionSchema = z.number().int().min(1).max(2147483647);
export const CanonicalUtcDateTimeSchema = z
  .string()
  .regex(
    /^(?!0000)\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/,
  )
  .refine((value) => {
    const instant = new Date(value);
    return (
      Number.isFinite(instant.getTime()) && instant.toISOString() === value
    );
  }, "Expected a canonical valid UTC instant");
export const ApiKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const FieldTypeSchema = z.enum([
  "text",
  "integer",
  "float",
  "boolean",
  "date",
  "time",
  "date-time",
  "json",
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;
export const RoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;
export const ResourceTargetSchema = z
  .strictObject({
    databaseId: IdSchema.optional(),
    tableId: IdSchema.optional(),
    level: z.enum(["read", "edit", "manage"]),
  })
  .refine(
    (target) => !target.tableId || !!target.databaseId,
    "Table target requires databaseId",
  );
export type ResourceTarget = z.infer<typeof ResourceTargetSchema>;
export const ActorSchema = z.strictObject({
  kind: z.enum(["session", "personal_key", "team_key", "oauth", "operator"]),
  id: z.string().min(1),
  orgId: IdSchema,
  userId: IdSchema.optional(),
  credentialId: IdSchema.optional(),
  clientId: z.string().optional(),
  role: RoleSchema,
  scopes: z.array(z.string()),
  targets: z.array(ResourceTargetSchema),
  unrestricted: z.boolean().optional(),
  operator: z.boolean().optional(),
  authenticatedAt: z.number().optional(),
  grantVersion: z.number().int().nonnegative().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const StorageErrorCodeSchema = z.enum([
  "STORAGE_ADMISSION_BUSY",
  "STORAGE_POLICY_CHANGED",
  "STORAGE_QUOTA_EXCEEDED",
  "STORAGE_DISK_PRESSURE",
  "STORAGE_REPORT_STALE",
  "STORAGE_RESERVATION_REQUIRED",
  "STORAGE_RESERVATION_EXCEEDED",
]);
export type StorageErrorCode = z.infer<typeof StorageErrorCodeSchema>;
export const storageErrorRecovery = {
  STORAGE_ADMISSION_BUSY: {
    status: 503,
    retryable: true,
    action: "retry_unchanged",
    guidance:
      "Retry the unchanged request after the active storage operation completes.",
  },
  STORAGE_POLICY_CHANGED: {
    status: 503,
    retryable: true,
    action: "retry_unchanged",
    guidance: "Retry the unchanged request under the current storage policy.",
  },
  STORAGE_QUOTA_EXCEEDED: {
    status: 503,
    retryable: false,
    action: "adjust_capacity",
    guidance:
      "Increase the applicable quota, remove retained data through approved maintenance, or reduce the operation size before retrying.",
  },
  STORAGE_DISK_PRESSURE: {
    status: 503,
    retryable: false,
    action: "restore_disk_headroom",
    guidance:
      "Restore PostgreSQL filesystem headroom through approved maintenance before retrying.",
  },
  STORAGE_REPORT_STALE: {
    status: 503,
    retryable: false,
    action: "restore_capacity_reporter",
    guidance:
      "Restore the database-host capacity reporter or revise the configured free-space policy before retrying.",
  },
  STORAGE_RESERVATION_REQUIRED: {
    status: 503,
    retryable: false,
    action: "contact_operator",
    guidance:
      "The write lacks its required transaction reservation; an operator must repair the admission integration.",
  },
  STORAGE_RESERVATION_EXCEEDED: {
    status: 503,
    retryable: false,
    action: "reduce_operation",
    guidance:
      "Use a smaller batch or sufficient reserved schema space before retrying.",
  },
} as const satisfies Record<
  StorageErrorCode,
  { status: 503; retryable: boolean; action: string; guidance: string }
>;
export const ErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "ACCESS_DENIED",
  "FORBIDDEN",
  "INSUFFICIENT_SCOPE",
  "PERSONAL_IDENTITY_REQUIRED",
  "OPERATOR_REQUIRED",
  "DELEGATION_EXCEEDS_AUTHORITY",
  "RESOURCE_NOT_FOUND",
  "ROW_VERSION_CONFLICT",
  "SCHEMA_VERSION_CONFLICT",
  "UNIQUE_CONFLICT",
  "ROW_SIZE_LIMIT",
  "ROW_LIMIT_REACHED",
  "PAYLOAD_TOO_LARGE",
  "REQUEST_TIMEOUT",
  "QUERY_TIMEOUT",
  "CURSOR_INVALID",
  "STEP_UP_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "JOB_FAILED",
  "RATE_LIMITED",
  "CAPACITY_LIMIT",
  "SCHEMA_MAINTENANCE",
  "BACKUP_UNVERIFIED",
  "ARTIFACT_EXPIRED",
  "CONFIGURATION_INVALID",
  "DEPENDENCY_UNAVAILABLE",
  ...StorageErrorCodeSchema.options,
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export class RootsetError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly details?: JsonValue;
  constructor(
    code: ErrorCode | string,
    message: string,
    status = 422,
    details?: JsonValue,
  ) {
    super(message);
    this.name = "RootsetError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
  toJSON(): { code: string; message: string; details?: JsonValue } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().meta({
      description:
        "Known domain codes are published in ErrorCode; unknown future codes remain valid.",
      "x-rootset-known-error-codes": ErrorCodeSchema.options,
    }),
    message: z.string(),
    requestId: z.string(),
    details: JsonValueSchema.optional(),
  }),
});
export function errorEnvelope(error: unknown, requestId: string) {
  return {
    error: {
      ...(error instanceof RootsetError
        ? error.toJSON()
        : {
            code: "INTERNAL_ERROR",
            message: "The operation could not be completed",
          }),
      requestId,
    },
  };
}
export function newId(): string {
  return ulid();
}

export interface FieldDefinition {
  id: string;
  apiKey: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: JsonValue;
  charLimit?: number;
  min?: number | string;
  max?: number | string;
  order?: number;
}
export const RowSchema = z.strictObject({
  id: IdSchema,
  version: VersionSchema,
  createdAt: CanonicalUtcDateTimeSchema,
  updatedAt: CanonicalUtcDateTimeSchema,
  values: z.record(ApiKeySchema, JsonValueSchema),
});
export type Row = z.infer<typeof RowSchema>;
export const PageSchema = z
  .strictObject({
    returned: z.number().int().nonnegative().max(limits.queryRows),
    requestedLimit: z.number().int().min(1).max(limits.queryRows),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    stopReason: z.enum(["row_limit", "byte_limit", "end"]),
    consistency: z.literal("live"),
  })
  .superRefine((page, context) => {
    if (page.returned > page.requestedLimit)
      context.addIssue({
        code: "custom",
        path: ["returned"],
        message: "Returned rows exceed the requested limit",
      });
    if (page.hasMore !== (page.nextCursor !== null))
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message:
          "A continuation cursor is required exactly when more rows exist",
      });
    if ((page.stopReason === "end") !== !page.hasMore)
      context.addIssue({
        code: "custom",
        path: ["stopReason"],
        message: "End-of-results and continuation must agree",
      });
  });
export const QueryResultSchema = z
  .strictObject({
    data: z.array(RowSchema).max(limits.queryRows),
    schemaVersion: SchemaVersionSchema,
    page: PageSchema,
  })
  .superRefine((result, context) => {
    if (result.data.length !== result.page.returned)
      context.addIssue({
        code: "custom",
        path: ["page", "returned"],
        message: "Returned count must match the complete row array",
      });
  });
export type QueryResult = z.infer<typeof QueryResultSchema>;

export const JobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "partially_completed",
]);
export const JobSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  kind: z.string(),
  operationId: z.string(),
  state: JobStateSchema,
  stage: z.string().optional(),
  databaseId: IdSchema.optional(),
  tableId: IdSchema.optional(),
  progress: z
    .strictObject({
      completed: z.number().nonnegative(),
      total: z.number().nonnegative().optional(),
      unit: z.string().optional(),
    })
    .optional(),
  createdAt: CanonicalUtcDateTimeSchema,
  updatedAt: CanonicalUtcDateTimeSchema,
  result: JsonValueSchema.optional(),
  error: ErrorEnvelopeSchema.shape.error.optional(),
  checkpoint: JsonValueSchema.optional(),
  attempt: z.number().int().nonnegative().optional(),
});
export type Job = z.infer<typeof JobSchema>;
export const JobAcceptedSchema = z.strictObject({
  jobId: IdSchema,
  state: JobStateSchema,
  statusUrl: z.string(),
});

export const PreferencesSchema = z.strictObject({
  timezone: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Expected an IANA timezone"),
  locale: z
    .string()
    .min(2)
    .max(64)
    .refine((value) => {
      try {
        return Intl.getCanonicalLocales(value).length === 1;
      } catch {
        return false;
      }
    }, "Expected a BCP 47 locale"),
  dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]),
  timeFormat: z.enum(["12h", "24h"]),
  theme: z.enum(["system", "light", "dark"]),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
export const ViewPreferencesSchema = z.strictObject({
  columnOrder: z.array(IdSchema).max(limits.maxFields),
  columnWidths: z.record(z.string(), z.number().min(40).max(2000)),
  frozenColumns: z.number().int().min(0).max(limits.maxFields),
  hiddenColumns: z.array(IdSchema).max(limits.maxFields),
  query: JsonValueSchema.optional(),
});
