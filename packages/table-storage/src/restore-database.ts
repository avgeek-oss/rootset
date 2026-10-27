import type { PoolClient } from "@rootset/database";
import {
  assertAllowedValuesBudget,
  assertFieldNames,
  assertRowBytes,
  FieldDefinitionSchema,
  IdSchema,
  RootsetError,
  validateValues,
  type Actor,
  type FieldDefinition,
  type ForeignKey,
  type JsonValue,
} from "@rootset/contracts";
import type { TableRecord, UniqueRule } from "./index.js";
import { fieldColumn } from "./query.js";
import {
  backupTimestamp,
  restoredId,
  restoreLimits,
  type RestoreSource,
} from "./restore.js";
import { restoreHistory } from "./restore-history.js";

export interface RestoreDatabaseInput {
  databaseId: string;
  name: string;
  backupId: string;
  checksum: string;
  snapshotAt: string;
  jobId: string;
}
export interface RestoreDatabaseResult {
  databaseId: string;
  sourceDatabaseId: string;
  sourceBackupId: string;
  snapshotAt: string;
  tableCount: number;
  rowCount: number;
  commentCount: number;
  historyEvents: number;
  mutationCount: number;
  viewCount: number;
  skippedPersonalViews: number;
}
export interface RestoreNative {
  createPhysical(c: PoolClient, t: TableRecord): Promise<void>;
  insertField(
    c: PoolClient,
    t: TableRecord,
    field: FieldDefinition,
    state: string,
  ): Promise<void>;
  buildRule(c: PoolClient, t: TableRecord, rule: UniqueRule): Promise<void>;
  buildForeignKey(
    c: PoolClient,
    source: TableRecord,
    target: TableRecord,
    key: ForeignKey,
  ): Promise<void>;
  installTrigger(c: PoolClient, t: TableRecord): Promise<void>;
  parameter(field: FieldDefinition, value: JsonValue): unknown;
  publish(c: PoolClient, result: RestoreDatabaseResult): Promise<void>;
  progress(
    stage: string,
    completed: number,
    total: number | null,
    unit: string,
  ): Promise<void>;
}
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const path = (table: TableRecord) =>
  `${q(table.schemaName)}.${q(table.physicalName)}`;
function invalid(message: string): never {
  throw new RootsetError(
    "VALIDATION_FAILED",
    `The backup cannot be restored: ${message}`,
  );
}

export async function restoreDatabaseSnapshot(
  client: PoolClient,
  actor: Actor,
  input: RestoreDatabaseInput,
  source: RestoreSource,
  native: RestoreNative,
): Promise<RestoreDatabaseResult> {
  const databaseId = IdSchema.parse(input.databaseId),
    orgId = IdSchema.parse(actor.orgId),
    schemaName = `rsd_${databaseId.toLowerCase()}`;
  if (source.tables.length > restoreLimits.tables) invalid("too many tables");
  await source.check();
  const previous = await client.query<{
    result: RestoreDatabaseResult;
    source_backup_id: string;
    source_checksum: string;
    database_id: string;
  }>(
    "SELECT result,source_backup_id,source_checksum,database_id FROM rootset_control.restore_results WHERE job_id=$1 AND org_id=$2",
    [IdSchema.parse(input.jobId), orgId],
  );
  if (previous.rows[0]) {
    const receipt = previous.rows[0];
    if (
      receipt.source_backup_id !== input.backupId ||
      receipt.source_checksum !== input.checksum ||
      receipt.database_id !== databaseId ||
      receipt.result.sourceDatabaseId !== source.database.id
    )
      invalid("the committed restore does not match this request");
    return receipt.result;
  }
  await client.query("SET LOCAL statement_timeout='60s'");
  await client.query(
    "INSERT INTO rootset_control.databases(id,org_id,name,description,schema_name,workspace_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      databaseId,
      orgId,
      input.name,
      source.database.description,
      schemaName,
      actor.workspaceId ?? actor.orgId,
    ],
  );
  await client.query(`CREATE SCHEMA ${q(schemaName)}`);
  const tables = new Map<string, TableRecord>(),
    rules = new Map<string, UniqueRule>();
  for (const [index, original] of source.tables.entries()) {
    await source.check();
    const tableId = restoredId(databaseId, "table", original.id);
    const positions = new Map(
      original.allFields.map((field) => [field.id, field.position]),
    );
    const fields = original.fields.map((field) =>
      FieldDefinitionSchema.parse({
        ...field,
        id: restoredId(databaseId, "field", field.id),
        order: positions.get(field.id),
      }),
    );
    assertFieldNames(fields);
    assertAllowedValuesBudget(fields);
    const table: TableRecord = {
      id: tableId,
      orgId,
      databaseId,
      name: original.name,
      description: original.description,
      schemaName,
      physicalName: `rst_${tableId.toLowerCase()}`,
      generation: 1,
      schemaVersion: original.schemaVersion,
      rowCount: 0,
      state: original.state,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      fields,
    };
    tables.set(original.id, table);
    await client.query(
      "INSERT INTO rootset_control.tables(id,database_id,org_id,name,description,physical_name,schema_version,state,created_at,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        table.id,
        databaseId,
        orgId,
        table.name,
        table.description,
        table.physicalName,
        table.schemaVersion,
        table.state,
        backupTimestamp(original.createdAt),
        backupTimestamp(original.updatedAt),
        original.deletedAt === null
          ? null
          : backupTimestamp(original.deletedAt),
      ],
    );
    for (const originalField of original.allFields) {
      const field = FieldDefinitionSchema.parse({
        ...originalField.definition,
        id: restoredId(databaseId, "field", originalField.id),
        order: originalField.position,
      });
      await native.insertField(client, table, field, originalField.state);
      await client.query(
        "UPDATE rootset_control.fields SET created_at=$2,deleted_at=$3 WHERE id=$1",
        [
          field.id,
          backupTimestamp(originalField.createdAt),
          originalField.deletedAt === null
            ? null
            : backupTimestamp(originalField.deletedAt),
        ],
      );
    }
    if (original.state === "active") await native.createPhysical(client, table);
    await native.progress(
      "creating_tables",
      index + 1,
      source.tables.length,
      "tables",
    );
  }
  const totalRows = source.tables.reduce(
    (sum, table) => sum + table.rowCount,
    0,
  );
  let rowCount = 0;
  for (const original of source.tables) {
    if (original.state !== "active") continue;
    const table = tables.get(original.id)!;
    let tableRows = 0;
    for await (const batch of source.rows(original.id)) {
      await source.check();
      if (batch.length > restoreLimits.batchRows)
        invalid("record batch exceeds its row budget");
      const params: unknown[] = [];
      const tuples: string[] = [];
      let bytes = 0;
      for (const row of batch) {
        const named = Object.fromEntries(
          original.fields.map((field) => [field.name, row.values[field.id]]),
        );
        if (
          Object.keys(row.values).length !== original.fields.length ||
          original.fields.some((field) => !Object.hasOwn(row.values, field.id))
        )
          invalid("a record does not match its field definitions");
        const values = validateValues(table.fields, named, "create");
        assertRowBytes(table.fields, values);
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > restoreLimits.batchBytes)
          invalid("record batch exceeds its byte budget");
        const bound = [
          IdSchema.parse(row.id),
          orgId,
          row.version,
          backupTimestamp(row.createdAt),
          backupTimestamp(row.updatedAt),
          ...table.fields.map((field) =>
            native.parameter(field, values[field.name]!),
          ),
        ];
        tuples.push(
          `(${bound
            .map((value) => {
              params.push(value);
              return `$${params.length}`;
            })
            .join(",")})`,
        );
      }
      if (tuples.length)
        await client.query(
          `INSERT INTO ${path(table)} (row_id,org_id,row_version,created_at,updated_at${table.fields.length ? "," + table.fields.map((field) => q(fieldColumn(field))).join(",") : ""}) VALUES ${tuples.join(",")}`,
          params,
        );
      rowCount += batch.length;
      tableRows += batch.length;
      await native.progress("restoring_rows", rowCount, totalRows, "rows");
    }
    if (tableRows !== original.rowCount)
      invalid("record counts do not match the manifest");
    const count = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${path(table)}`,
    );
    if (BigInt(count.rows[0]!.count) !== BigInt(original.rowCount))
      invalid("staged records do not match the manifest");
    table.rowCount = original.rowCount;
    await client.query(
      "UPDATE rootset_control.tables SET row_count=$2,last_data_change_at=CASE WHEN $2::bigint>0 THEN clock_timestamp() ELSE NULL END WHERE id=$1",
      [table.id, table.rowCount],
    );
    for (const counter of original.counters) {
      const fieldId = restoredId(databaseId, "field", counter.fieldId),
        field = table.fields.find((field) => field.id === fieldId),
        next = BigInt(counter.nextValue);
      if (
        next < BigInt(Number.MIN_SAFE_INTEGER) ||
        next > BigInt(Number.MAX_SAFE_INTEGER) + 1n
      )
        invalid("a generated-ID counter is outside its supported range");
      if (field?.type === "integer" && field.autoIncrement) {
        const maximum = await client.query<{ maximum: string | null }>(
          `SELECT max(${q(fieldColumn(field))})::text AS maximum FROM ${path(table)}`,
        );
        const value = maximum.rows[0]!.maximum;
        if (
          next < BigInt(field.min ?? 1) ||
          (value !== null && next <= BigInt(value))
        )
          invalid("a generated-ID counter would reuse a stored value");
      }
      await client.query(
        "INSERT INTO rootset_control.integer_counters(field_id,table_id,org_id,next_value) VALUES($1,$2,$3,$4)",
        [fieldId, table.id, orgId, counter.nextValue],
      );
    }
    for (const originalRule of original.uniqueRules) {
      await source.check();
      const ruleId = restoredId(databaseId, "unique_rule", originalRule.id);
      const where = originalRule.where
        ? {
            ...originalRule.where,
            field: restoredId(databaseId, "field", originalRule.where.field),
          }
        : undefined;
      const rule: UniqueRule = {
        id: ruleId,
        tableId: table.id,
        name: originalRule.name,
        fieldIds: originalRule.fieldIds.map((id) =>
          restoredId(databaseId, "field", id),
        ),
        ...(where ? { where } : {}),
        strategy: originalRule.strategy,
        state: "active",
        physicalName:
          originalRule.strategy === "native"
            ? `rsu_${ruleId.toLowerCase()}`
            : null,
      };
      await client.query(
        "INSERT INTO rootset_control.unique_rules(id,table_id,org_id,name,field_ids,strategy,physical_name,state,condition) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8::jsonb)",
        [
          rule.id,
          table.id,
          orgId,
          rule.name,
          rule.fieldIds,
          rule.strategy,
          rule.physicalName,
          where ? JSON.stringify(where) : null,
        ],
      );
      await native.buildRule(client, table, rule);
      rules.set(originalRule.id, rule);
    }
  }
  let validated = 0;
  for (const original of source.tables) {
    if (original.state !== "active") continue;
    const table = tables.get(original.id)!;
    for (const originalKey of original.foreignKeys) {
      await source.check();
      const target =
          tables.get(originalKey.referencedTableId) ??
          invalid("missing foreign-key table"),
        rule =
          rules.get(originalKey.referencedRuleId) ??
          invalid("missing foreign-key unique rule");
      const key: ForeignKey = {
        id: restoredId(databaseId, "foreign_key", originalKey.id),
        tableId: table.id,
        fieldIds: originalKey.fieldIds.map((id) =>
          restoredId(databaseId, "field", id),
        ),
        referencedTableId: target.id,
        referencedTableName: target.name,
        referencedRuleId: rule.id,
        referencedFieldIds: originalKey.referencedFieldIds.map((id) =>
          restoredId(databaseId, "field", id),
        ),
        referencedFieldNames: originalKey.referencedFieldIds.map(
          (id) =>
            target.fields.find(
              (field) => field.id === restoredId(databaseId, "field", id),
            )!.name,
        ),
        state: "active",
      };
      await native.buildForeignKey(client, table, target, key);
    }
    await native.installTrigger(client, table);
    await native.progress(
      "validating_relationships",
      ++validated,
      source.tables.filter((table) => table.state === "active").length,
      "tables",
    );
  }
  const history = await restoreHistory(
    client,
    actor,
    databaseId,
    source,
    tables,
    native.progress,
  );
  await source.check();
  const result: RestoreDatabaseResult = {
    databaseId,
    sourceDatabaseId: source.database.id,
    sourceBackupId: input.backupId,
    snapshotAt: input.snapshotAt,
    tableCount: source.tables.filter((table) => table.state === "active")
      .length,
    rowCount,
    ...history,
  };
  await native.publish(client, result);
  await client.query(
    "INSERT INTO rootset_control.restore_results(job_id,org_id,source_backup_id,source_checksum,database_id,result) VALUES($1,$2,$3,$4,$5,$6)",
    [input.jobId, orgId, input.backupId, input.checksum, databaseId, result],
  );
  return result;
}
