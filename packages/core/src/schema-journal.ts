import {
  FieldDefinitionSchema,
  IdSchema,
  RootsetError,
  SchemaChangeSchema,
  SchemaJournalRequestSchema,
  SchemaOperationReportSchema,
  TableSchema,
  type SchemaJournalRequest,
  type SchemaOperationReport,
} from "@rootset/contracts";

export interface SchemaJournalMappingOptions {
  jobId?: string;
  /** Canonical public job input supplies arguments absent from older journals. */
  request?: Record<string, unknown>;
}

const fieldKeys = [
  "apiKey",
  "label",
  "type",
  "required",
  "default",
  "charLimit",
  "min",
  "max",
  "order",
] as const;
const tableKeys = [
  "id",
  "orgId",
  "databaseId",
  "name",
  "description",
  "schemaVersion",
  "rowCount",
  "state",
  "createdAt",
  "updatedAt",
] as const;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function pick(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key) && value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}
function instant(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}
function publicField(value: unknown): Record<string, unknown> {
  return pick(object(value), fieldKeys);
}
function identifier(value: unknown): string | undefined {
  const parsed = IdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function request(
  kind: string,
  stored: Record<string, unknown>,
  plan: Record<string, unknown>,
  original: Record<string, unknown>,
): SchemaJournalRequest {
  const changes = object(original.change);
  const fieldId = identifier(
    original.fieldId ?? changes.fieldId ?? stored.fieldId ?? plan.fieldId,
  );
  const suppliedField = Object.keys(object(original.field)).length
    ? original.field
    : changes.kind === "add_field"
      ? changes.field
      : changes.kind === "update_field"
        ? changes.changes
        : stored;
  let result: unknown;
  switch (kind) {
    case "database.create":
    case "database.update":
    case "table.update":
      result = { kind, ...pick(stored, ["name", "description"]) };
      break;
    case "database.delete":
    case "table.delete":
      result = { kind };
      break;
    case "table.create":
      result = {
        kind,
        ...pick(stored, ["name", "description"]),
        fields: Array.isArray(stored.fields)
          ? stored.fields.map(publicField)
          : [],
      };
      break;
    case "field.create":
      result = { kind, field: publicField(suppliedField) };
      break;
    case "field.update":
    case "field.convert": {
      const strategy = object(stored.conversion).strategy;
      const conversion =
        original.conversion ??
        changes.conversion ??
        (strategy === "strict"
          ? "lossless"
          : strategy === "stringify" || strategy === "parse"
            ? "explicit"
            : undefined);
      result = {
        kind,
        ...(fieldId ? { fieldId } : {}),
        changes: publicField(suppliedField),
        ...(kind === "field.convert" && conversion ? { conversion } : {}),
      };
      break;
    }
    case "field.delete":
      result = {
        kind,
        ...(fieldId ? { fieldId } : {}),
        removeDependencies:
          stored.removeDependencies === true ||
          changes.removeDependencies === true ||
          original.removeDependencies === true,
      };
      break;
    case "fields.reorder":
      result = {
        kind,
        fieldIds: stored.fieldIds ?? changes.fieldIds ?? original.fieldIds,
      };
      break;
    case "rule.create":
      result = { kind, ...pick(stored, ["fieldIds", "name"]) };
      break;
    case "rule.delete":
    case "index.delete": {
      const id = identifier(original.id ?? stored.id);
      result = { kind, ...(id ? { id } : {}) };
      break;
    }
    case "index.create":
      result = {
        kind,
        fieldIds:
          stored.fieldIds ??
          (stored.fieldId ? [stored.fieldId] : original.fieldIds),
        indexKind: stored.kind === "json" ? "jsonb" : stored.kind,
      };
      break;
    default:
      result = { kind: "unknown" };
  }
  return SchemaJournalRequestSchema.parse(result);
}

function canonicalChange(
  input: SchemaJournalRequest,
): SchemaOperationReport["change"] {
  switch (input.kind) {
    case "field.create":
      return SchemaChangeSchema.parse({
        kind: "add_field",
        field: input.field,
      });
    case "field.update":
    case "field.convert":
      return input.fieldId
        ? SchemaChangeSchema.parse({
            kind: "update_field",
            fieldId: input.fieldId,
            changes: input.changes,
            ...(input.kind === "field.convert" && input.conversion
              ? { conversion: input.conversion }
              : {}),
          })
        : undefined;
    case "field.delete":
      return input.fieldId
        ? {
            kind: "delete_field",
            fieldId: input.fieldId,
            removeDependencies: input.removeDependencies,
          }
        : undefined;
    case "fields.reorder":
      return { kind: "reorder_fields", fieldIds: input.fieldIds };
    default:
      return undefined;
  }
}

const phases: Readonly<Record<string, SchemaOperationReport["phase"]>> = {
  planned: "planned",
  running: "running",
  building: "running",
  staging: "running",
  staged: "running",
  committed: "committed",
  failed: "failed",
  historical: "historical",
};

/** Whitelists public schema metadata; never serialises physical DDL or context. */
export function mapSchemaJournal(
  record: Record<string, unknown>,
  options: SchemaJournalMappingOptions = {},
): SchemaOperationReport {
  try {
    const stored = object(record.after_definition);
    const plan = object(record.plan);
    if (typeof record.kind !== "string" || typeof record.state !== "string")
      throw new RootsetError(
        "INTERNAL_ERROR",
        "The schema journal is missing its operation state",
        500,
      );
    const kind = record.kind;
    const state = record.state;
    const businessRequest = request(kind, stored, plan, options.request ?? {});
    const change = canonicalChange(businessRequest);
    const source = object(record.before_definition);
    const before =
      record.before_definition === null ||
      record.before_definition === undefined
        ? null
        : {
            table: TableSchema.parse({
              ...pick(source, tableKeys),
              createdAt: instant(source.createdAt),
              updatedAt: instant(source.updatedAt),
            }),
            fields: Array.isArray(source.fields)
              ? source.fields.map((value) =>
                  FieldDefinitionSchema.parse({
                    ...publicField(value),
                    id: object(value).id,
                  }),
                )
              : [],
          };
    const failure = object(record.error);
    const rawCode =
      typeof failure.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(failure.code)
        ? failure.code
        : "SCHEMA_OPERATION_FAILED";
    return SchemaOperationReportSchema.parse({
      id: record.id,
      databaseId: record.database_id,
      tableId: record.table_id ?? null,
      kind,
      state,
      phase: phases[state] ?? "unknown",
      expectedSchemaVersion:
        record.expected_version === null ||
        record.expected_version === undefined
          ? null
          : Number(record.expected_version),
      request: businessRequest,
      before,
      ...(change ? { change } : {}),
      verification: {
        ...(typeof plan.transactional === "boolean"
          ? { transactional: plan.transactional }
          : {}),
        ...(identifier(plan.fieldId)
          ? { fieldId: identifier(plan.fieldId) }
          : {}),
        ...(identifier(plan.indexId)
          ? { indexId: identifier(plan.indexId) }
          : {}),
        ...(plan.nextField
          ? {
              nextField: FieldDefinitionSchema.parse({
                ...publicField(plan.nextField),
                id: object(plan.nextField).id,
              }),
            }
          : {}),
      },
      createdAt: instant(record.created_at),
      committedAt:
        record.committed_at === null || record.committed_at === undefined
          ? null
          : instant(record.committed_at),
      ...(record.error
        ? {
            error: {
              code: rawCode,
              message:
                rawCode === "RECOVERED_PRE_CUTOVER"
                  ? "The previous schema remains authoritative; this operation can be retried."
                  : "The schema operation did not complete. Inspect its job for the failure report.",
              ...(typeof failure.retryable === "boolean"
                ? { retryable: failure.retryable }
                : {}),
            },
          }
        : {}),
      ...(options.jobId ? { jobId: options.jobId } : {}),
    });
  } catch (error) {
    if (error instanceof RootsetError) throw error;
    throw new RootsetError(
      "INTERNAL_ERROR",
      "The schema journal contains invalid public metadata",
      500,
    );
  }
}
