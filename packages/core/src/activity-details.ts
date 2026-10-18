import { canonicalJson, limits, type JsonValue } from "@rootset/contracts";

type ObjectValue = Record<string, unknown>;
type Details = Record<string, JsonValue>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const objects = (value: unknown): ObjectValue[] =>
  Array.isArray(value) ? value.slice(0, limits.maxFields).map(object) : [];
const text = (value: string) =>
  value.length > 512 ? `${value.slice(0, 512)}…` : value;

function pick(value: unknown, keys: string[]): Details {
  const source = object(value);
  return Object.fromEntries(
    keys.flatMap<[string, JsonValue]>((key) => {
      const item = source[key];
      return item === null ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item))
        ? [[key, item]]
        : typeof item === "string"
          ? [[key, text(item)]]
          : [];
    }),
  );
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, limits.maxFields)
        .map(text)
    : [];
}
function field(value: unknown): Details {
  return pick(value, [
    "id",
    "name",
    "type",
    "required",
    "autoIncrement",
    "min",
    "max",
    "charLimit",
  ]);
}
function fieldReferences(ids: unknown, fields: ObjectValue[]): JsonValue[] {
  return strings(ids).map((id) =>
    pick(fields.find((item) => item.id === id) ?? { id }, ["id", "name"]),
  );
}
function changes(before: unknown, after: unknown, keys: string[]): Details {
  const oldValues = object(before),
    newValues = object(after);
  const a = pick(before, keys),
    b = pick(after, keys);
  return Object.fromEntries(
    keys
      .filter(
        (key) =>
          canonicalJson(oldValues[key] ?? null) !==
          canonicalJson(newValues[key] ?? null),
      )
      .map((key) => [key, { before: a[key] ?? null, after: b[key] ?? null }]),
  );
}

const fieldAttributes = [
  "name",
  "type",
  "required",
  "autoIncrement",
  "default",
  "min",
  "max",
  "charLimit",
  "allowedValues",
];

/** Public audit context is an allowlist, never a serialization of stored snapshots. */
export function resourceActivityDetails(
  operation: string,
  beforeValue: unknown,
  afterValue: unknown,
): Details {
  const before = object(beforeValue),
    after = object(afterValue);
  const oldFields = objects(before.fields),
    newFields = objects(after.fields);
  if (operation === "fields.reorder") {
    return {
      fieldOrder: {
        before: oldFields.map((item) => text(String(item.name))),
        after: newFields.map((item) => text(String(item.name))),
      },
    };
  }
  if (operation.startsWith("field.")) {
    // Conversions retain the field itself; other field events retain the table.
    const old = before.type ? [before] : oldFields;
    const next = after.type ? [after] : newFields;
    const ids = new Set([...old, ...next].map((item) => item.id));
    return {
      fields: [...ids].flatMap((id) => {
        const a = old.find((item) => item.id === id);
        const b = next.find((item) => item.id === id);
        const attributes = fieldAttributes.filter(
          (key) =>
            canonicalJson(a?.[key] ?? null) !== canonicalJson(b?.[key] ?? null),
        );
        return !a || !b || attributes.length
          ? [
              {
                before: a ? field(a) : null,
                after: b ? field(b) : null,
                changedAttributes: attributes,
              },
            ]
          : [];
      }),
    };
  }
  if (operation.startsWith("rule.") || operation.startsWith("foreign-key.")) {
    const relation = operation.startsWith("foreign-key.");
    const key = relation ? "relations" : "rules";
    const a = objects(before[key]),
      b = objects(after[key]);
    if (!Array.isArray(before[key]) || !Array.isArray(after[key]))
      return {
        note: "Additional context was not recorded for this older event.",
      };
    const changed = operation.endsWith("create")
      ? b.filter((item) => !a.some((old) => old.id === item.id))
      : a.filter((item) => !b.some((next) => next.id === item.id));
    return {
      [key]: changed.map((item) => ({
        ...pick(item, [
          "id",
          "name",
          "referencedTableId",
          "referencedTableName",
        ]),
        fields: fieldReferences(
          item.fieldIds,
          operation.endsWith("create") ? newFields : oldFields,
        ),
        ...(relation
          ? { referencedFields: strings(item.referencedFieldNames) }
          : {
              conditional: !!item.where,
            }),
      })),
    };
  }
  if (operation.startsWith("database.backup_schedule."))
    return {
      before:
        beforeValue === null
          ? null
          : pick(before, ["bucket", "prefix", "cron", "timezone"]),
      after:
        afterValue === null
          ? null
          : pick(after, ["bucket", "prefix", "cron", "timezone"]),
    };
  if (operation === "database.backup_policy.update")
    return {
      changes: changes(before, after, [
        "retentionCount",
        "overdueGraceMinutes",
      ]),
    };
  if (operation === "database.backup.prune")
    return { changes: changes(before, after, ["storageState"]) };
  if (operation === "database.restore")
    return pick(after, [
      "sourceDatabaseId",
      "sourceBackupId",
      "snapshotAt",
      "tableCount",
      "rowCount",
      "includeHistory",
    ]);
  if (operation.endsWith(".update"))
    return { changes: changes(before, after, ["name", "description"]) };
  const snapshot = operation.endsWith(".delete") ? before : after;
  return {
    ...pick(snapshot, ["name", "description"]),
    ...(operation.startsWith("table.")
      ? {
          fields: objects(snapshot.fields).map(field),
          ...pick(snapshot, ["rowCount"]),
        }
      : {}),
  };
}

export function jobActivityDetails(
  inputValue: unknown,
  jobId: string,
  state: string,
  attempt: number,
): Details {
  const input = object(inputValue);
  const change = object(input.change);
  const query = object(input.query);
  return {
    jobId,
    status: state === "queued" ? "requested" : state,
    attempt,
    request: {
      ...pick(input, [
        "name",
        "type",
        "required",
        "autoIncrement",
        "fileName",
        "format",
        "viewId",
        "previewJobId",
        "backupId",
        "sourceDatabaseId",
        "fieldId",
        "ruleId",
        "referencedTableId",
        "includeHistory",
        "bucket",
        "prefix",
        "cron",
        "timezone",
      ]),
      ...(Array.isArray(input.fieldIds)
        ? { fieldIds: strings(input.fieldIds) }
        : {}),
      ...(Array.isArray(input.fields)
        ? { fields: objects(input.fields).map(field) }
        : {}),
      ...(input.field ? { field: field(input.field) } : {}),
      ...(Array.isArray(input.mapping)
        ? {
            mapping: objects(input.mapping).map((item) =>
              pick(item, ["source", "fieldId"]),
            ),
          }
        : {}),
      ...(input.changes
        ? {
            changedAttributes: fieldAttributes.filter((key) =>
              Object.hasOwn(object(input.changes), key),
            ),
          }
        : {}),
      ...(input.change
        ? {
            change: {
              ...pick(change, ["kind", "fieldId"]),
              ...(change.field ? { field: field(change.field) } : {}),
              ...(Array.isArray(change.fieldIds)
                ? { fieldIds: strings(change.fieldIds) }
                : {}),
              ...(change.changes
                ? {
                    changedAttributes: fieldAttributes.filter((key) =>
                      Object.hasOwn(object(change.changes), key),
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(input.query
        ? {
            filtered: !!query.where,
            sorted: Array.isArray(query.orderBy) && query.orderBy.length > 0,
            ...(Array.isArray(query.select)
              ? { fields: strings(query.select) }
              : {}),
          }
        : {}),
    },
  };
}
