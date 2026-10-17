import { createHash } from "node:crypto";
import type { PoolClient } from "@rootset/database";
import {
  assertFieldDefinitionLexemes,
  assertQueryLexemes,
  canonicalJson,
  FieldDefinitionSchema,
  IdSchema,
  RootsetError,
  SavedViewDefinitionSchema,
  VersionSchema,
  type Actor,
  type FilterNode,
} from "@rootset/contracts";
import type { TableRecord } from "./index.js";
import {
  backupTimestamp,
  restoredId,
  type RestoreHistoryRecord,
  type RestoreSource,
} from "./restore.js";

function invalid(message: string): never {
  throw new RootsetError(
    "VALIDATION_FAILED",
    `The backup cannot be restored: ${message}`,
  );
}
function id(value: unknown): string {
  const parsed = IdSchema.safeParse(value);
  return parsed.success ? parsed.data : invalid("invalid history identifier");
}
function text(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!empty && !value.length)
  )
    return invalid("invalid history text");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("invalid history object");
  return value as Record<string, unknown>;
}
function version(value: unknown): string {
  const parsed = VersionSchema.safeParse(value);
  return parsed.success ? parsed.data : invalid("invalid history revision");
}
function schemaVersion(value: unknown): number {
  const result = typeof value === "number" ? value : Number(version(value));
  if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647)
    return invalid("invalid history schema version");
  return result;
}
const json = (value: unknown) =>
  value === null ? null : canonicalJson(value, { maxDepth: 96 });
type TargetTable =
  | "mutations"
  | "row_comments"
  | "cell_changes"
  | "resource_history"
  | "saved_views";
async function insert(
  client: PoolClient,
  table: TargetTable,
  columns: readonly string[],
  rows: unknown[][],
) {
  if (!rows.length) return;
  const params: unknown[] = [];
  const tuples = rows.map(
    (row) =>
      `(${row
        .map((value) => {
          params.push(value);
          return `$${params.length}`;
        })
        .join(",")})`,
  );
  await client.query(
    `INSERT INTO rootset_control.${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`,
    params,
  );
}
function origin(
  record: Record<string, unknown>,
  source: RestoreSource,
  actor: Actor,
) {
  if (record.org_id !== undefined && id(record.org_id) !== actor.orgId)
    invalid("history belongs to another organisation");
  if (
    record.database_id !== undefined &&
    id(record.database_id) !== source.database.id
  )
    invalid("history belongs to another database");
  object(record.actor);
  object(record.context ?? {});
}
async function knownUsers(
  client: PoolClient,
  records: readonly RestoreHistoryRecord[],
  key: string,
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      records.flatMap((record) =>
        record.value[key] === null ? [] : [id(record.value[key])],
      ),
    ),
  ];
  if (!ids.length) return new Set();
  return new Set(
    (
      await client.query<{ id: string }>(
        "SELECT id FROM rootset_control.users WHERE id=ANY($1::varchar[])",
        [ids],
      )
    ).rows.map((row) => row.id),
  );
}
export async function restoreHistory(
  client: PoolClient,
  actor: Actor,
  databaseId: string,
  source: RestoreSource,
  tables: ReadonlyMap<string, TableRecord>,
  progress: (
    stage: string,
    completed: number,
    total: number | null,
    unit: string,
  ) => Promise<void>,
) {
  const tableFor = (value: unknown) =>
    tables.get(id(value)) ?? invalid("history refers to an unknown table");
  const knownFields = new Set(
    source.tables.flatMap((table) => table.allFields.map((field) => field.id)),
  );
  const knownRules = new Set(
    source.tables.flatMap((table) => table.uniqueRules.map((rule) => rule.id)),
  );
  const knownKeys = new Set(
    source.tables.flatMap((table) => table.foreignKeys.map((key) => key.id)),
  );
  let mutationCount = 0,
    commentCount = 0,
    cellCount = 0,
    resourceCount = 0,
    viewCount = 0,
    skippedPersonalViews = 0;
  const advanced = () =>
    progress(
      "restoring_history",
      mutationCount + commentCount + cellCount + resourceCount + viewCount,
      null,
      "entries",
    );
  for await (const batch of source.history("mutations")) {
    await source.check();
    const rows = batch.map(({ value: record }) => {
      origin(record, source, actor);
      const originalId = id(record.id),
        table = tableFor(record.table_id);
      const hash = createHash("sha256")
        .update(`rootset.restore.mutation\0${databaseId}\0${originalId}`)
        .digest("hex");
      return [
        restoredId(databaseId, "mutation", originalId),
        actor.orgId,
        table.id,
        null,
        hash,
        json(object(record.actor)),
        json(object(record.context)),
        schemaVersion(record.schema_version),
        null,
        backupTimestamp(record.committed_at),
      ];
    });
    await insert(
      client,
      "mutations",
      [
        "id",
        "org_id",
        "table_id",
        "idempotency_key",
        "input_hash",
        "actor",
        "context",
        "schema_version",
        "outcome",
        "committed_at",
      ],
      rows,
    );
    mutationCount += rows.length;
    await advanced();
  }
  for await (const batch of source.history("comments")) {
    await source.check();
    const authors = await knownUsers(client, batch, "author_user_id");
    const rows = batch.map(({ value: record }) => {
      origin(record, source, actor);
      const table = tableFor(record.table_id),
        author =
          record.author_user_id === null ? null : id(record.author_user_id),
        deleted =
          record.deleted_at === null
            ? null
            : backupTimestamp(record.deleted_at);
      const body = text(record.body, 4096, Boolean(deleted));
      if ((deleted && body !== "") || (!deleted && !body.trim()))
        invalid("invalid comment deletion state");
      return [
        restoredId(databaseId, "comment", id(record.id)),
        actor.orgId,
        table.id,
        id(record.row_id),
        author && authors.has(author) ? author : null,
        text(record.author_name_snapshot, 120),
        json(object(record.actor)),
        body,
        backupTimestamp(record.created_at),
        deleted,
      ];
    });
    await insert(
      client,
      "row_comments",
      [
        "id",
        "org_id",
        "table_id",
        "row_id",
        "author_user_id",
        "author_name_snapshot",
        "actor",
        "body",
        "created_at",
        "deleted_at",
      ],
      rows,
    );
    commentCount += rows.length;
    await advanced();
  }
  for await (const batch of source.history("cell-changes")) {
    await source.check();
    const rows = batch.map(({ value: record, numbers }) => {
      origin(record, source, actor);
      version(record.id);
      const table = tableFor(record.table_id),
        fieldId = id(record.field_id);
      const parsed = FieldDefinitionSchema.safeParse(record.field_definition);
      if (!parsed.success || parsed.data.id !== fieldId)
        invalid("invalid historical field definition");
      const definition = parsed.data;
      assertFieldDefinitionLexemes(definition, numbers, ["field_definition"]);
      const operation = text(record.operation, 32);
      if (
        ![
          "insert",
          "create",
          "update",
          "delete",
          "conversion",
          "repair",
        ].includes(operation)
      )
        invalid("unsupported cell-history operation");
      return [
        actor.orgId,
        databaseId,
        table.id,
        id(record.row_id),
        restoredId(databaseId, "field", fieldId),
        restoredId(databaseId, "mutation", id(record.mutation_id)),
        json(record.old_value),
        json(record.new_value),
        json({ ...definition, id: restoredId(databaseId, "field", fieldId) }),
        record.old_version === null ? null : version(record.old_version),
        record.new_version === null ? null : version(record.new_version),
        operation,
        json(object(record.actor)),
        json(object(record.context)),
        backupTimestamp(record.changed_at),
        restoredId(databaseId, "history", id(record.public_id)),
      ];
    });
    await insert(
      client,
      "cell_changes",
      [
        "org_id",
        "database_id",
        "table_id",
        "row_id",
        "field_id",
        "mutation_id",
        "old_value",
        "new_value",
        "field_definition",
        "old_version",
        "new_version",
        "operation",
        "actor",
        "context",
        "changed_at",
        "public_id",
      ],
      rows,
    );
    cellCount += rows.length;
    await advanced();
  }
  for await (const batch of source.history("resource-history")) {
    await source.check();
    const rows = batch.map(({ value: record }) => {
      origin(record, source, actor);
      version(record.id);
      const table = record.table_id === null ? null : tableFor(record.table_id),
        operation = text(record.operation, 128),
        originalId = id(record.resource_id);
      const resourceId =
        originalId === source.database.id
          ? databaseId
          : tables.has(originalId)
            ? tables.get(originalId)!.id
            : knownFields.has(originalId) || operation.startsWith("field.")
              ? restoredId(databaseId, "field", originalId)
              : knownRules.has(originalId) || operation.startsWith("rule.")
                ? restoredId(databaseId, "unique_rule", originalId)
                : knownKeys.has(originalId) ||
                    operation.startsWith("foreign_key.")
                  ? restoredId(databaseId, "foreign_key", originalId)
                  : operation.startsWith("view.")
                    ? restoredId(databaseId, "view", originalId)
                    : originalId;
      return [
        actor.orgId,
        databaseId,
        table?.id ?? null,
        resourceId,
        operation,
        json(record.before_value),
        json(record.after_value),
        json(object(record.actor)),
        json(object(record.context)),
        backupTimestamp(record.changed_at),
      ];
    });
    await insert(
      client,
      "resource_history",
      [
        "org_id",
        "database_id",
        "table_id",
        "resource_id",
        "operation",
        "before_value",
        "after_value",
        "actor",
        "context",
        "changed_at",
      ],
      rows,
    );
    resourceCount += rows.length;
    await advanced();
  }
  for await (const batch of source.history("views")) {
    await source.check();
    const owners = await knownUsers(client, batch, "owner_user_id");
    const rows = [];
    for (const { value: record, numbers } of batch) {
      if (id(record.org_id) !== actor.orgId)
        invalid("a saved view belongs to another organisation");
      const originalTableId = id(record.table_id),
        table = tableFor(originalTableId),
        original = source.tables.find((table) => table.id === originalTableId)!;
      if (record.visibility !== "personal" && record.visibility !== "shared")
        invalid("invalid saved-view visibility");
      const owner =
        record.owner_user_id === null ? null : id(record.owner_user_id);
      if (record.visibility === "personal" && (!owner || !owners.has(owner))) {
        skippedPersonalViews++;
        continue;
      }
      const parsed = SavedViewDefinitionSchema.safeParse(record.definition);
      if (!parsed.success) invalid("invalid saved-view definition");
      const definition = parsed.data;
      assertQueryLexemes(original.fields, definition.query, numbers, [
        "definition",
        "query",
      ]);
      const mapField = (value: string) => {
        const field = original.allFields.find(
          (field) => field.id === value || field.name === value,
        );
        const parsed = IdSchema.safeParse(value);
        return field
          ? restoredId(databaseId, "field", field.id)
          : parsed.success
            ? restoredId(databaseId, "field", parsed.data)
            : value;
      };
      const where = (node: FilterNode): FilterNode =>
        "field" in node
          ? { ...node, field: mapField(node.field) }
          : "and" in node
            ? { and: node.and.map(where) }
            : { or: node.or.map(where) };
      const restored = {
        ...definition,
        columnOrder: definition.columnOrder.map(mapField),
        hiddenColumns: definition.hiddenColumns.map(mapField),
        columnWidths: Object.fromEntries(
          Object.entries(definition.columnWidths).map(([key, value]) => [
            mapField(key),
            value,
          ]),
        ),
        query: {
          ...(definition.query.where
            ? { where: where(definition.query.where) }
            : {}),
          ...(definition.query.orderBy
            ? {
                orderBy: definition.query.orderBy.map((sort) => ({
                  ...sort,
                  field: mapField(sort.field),
                })),
              }
            : {}),
        },
      };
      rows.push([
        restoredId(databaseId, "view", id(record.id)),
        actor.orgId,
        table.id,
        owner && owners.has(owner) ? owner : null,
        text(record.owner_name_snapshot, 1024),
        text(record.name, 120),
        record.visibility,
        json(restored),
        schemaVersion(record.schema_version),
        version(record.version),
        backupTimestamp(record.created_at),
        backupTimestamp(record.updated_at),
        record.deleted_at === null ? null : backupTimestamp(record.deleted_at),
      ]);
    }
    await insert(
      client,
      "saved_views",
      [
        "id",
        "org_id",
        "table_id",
        "owner_user_id",
        "owner_name_snapshot",
        "name",
        "visibility",
        "definition",
        "schema_version",
        "version",
        "created_at",
        "updated_at",
        "deleted_at",
      ],
      rows,
    );
    viewCount += rows.length;
    await advanced();
  }
  const actual = await client.query<{ cells: string; resources: string }>(
    "SELECT (SELECT count(*)::text FROM rootset_control.cell_changes WHERE database_id=$1) AS cells,(SELECT count(*)::text FROM rootset_control.resource_history WHERE database_id=$1) AS resources",
    [databaseId],
  );
  if (
    BigInt(actual.rows[0]!.cells) !== BigInt(cellCount) ||
    BigInt(actual.rows[0]!.resources) !== BigInt(resourceCount)
  )
    invalid("retained-history counts changed during restoration");
  return {
    commentCount,
    mutationCount,
    historyEvents: cellCount + resourceCount,
    viewCount,
    skippedPersonalViews,
  };
}
