import { open as openZip, type Entry, type ZipFile } from "yauzl";
import type { Readable } from "node:stream";
import {
  assertAllowedValuesBudget,
  assertFieldNames,
  assertRowBytes,
  assertFieldDefinitionLexemes,
  assertQueryLexemes,
  assertValueLexemes,
  canonicalJson,
  decodeJsonBytes,
  FieldDefinitionSchema,
  IdSchema,
  limits,
  RootsetError,
  validateUniqueRuleCondition,
  validateValues,
  VersionSchema,
  type JsonValue,
  type NumberLexeme,
} from "@rootset/contracts";
import {
  backupTimestamp,
  restoreLimits,
  type RestoreField,
  type RestoreForeignKey,
  type RestoreHistoryKind,
  type RestoreHistoryRecord,
  type RestoreRow,
  type RestoreSource,
  type RestoreTable,
  type RestoreUniqueRule,
} from "@rootset/table-storage";
import {
  backupArchiveEntries,
  inspectBackupArchive,
  type BackupManifest,
} from "./format.js";

function invalid(message: string): never {
  throw new RootsetError(
    "VALIDATION_FAILED",
    `The backup cannot be restored: ${message}`,
  );
}
function identifier(value: unknown): string {
  const result = IdSchema.safeParse(value);
  return result.success ? result.data : invalid("invalid resource identifier");
}
function definition(value: unknown) {
  const result = FieldDefinitionSchema.safeParse(value);
  return result.success ? result.data : invalid("invalid field definition");
}
function version(value: unknown): string {
  const result = VersionSchema.safeParse(value);
  return result.success ? result.data : invalid("invalid record version");
}
function numericIdentity(value: string): string {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value)!;
  const fraction = parts[3] ?? "";
  const digits = `${parts[2]}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const trailing = digits.match(/0*$/)![0].length;
  const exponent = Number(parts[4] ?? 0) - fraction.length + trailing;
  return `${parts[1]}${digits.slice(0, digits.length - trailing)}e${exponent}`;
}
function losslessNumbers(numbers: readonly NumberLexeme[]): void {
  for (const number of numbers)
    if (
      numericIdentity(number.lexeme) !==
      numericIdentity(JSON.stringify(number.value))
    )
      invalid("a number cannot be decoded without losing precision");
}
function object(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("expected a metadata object");
  return value as Record<string, JsonValue>;
}
function array(value: unknown, maximum: number): JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum)
    return invalid("metadata exceeds its item budget");
  return value;
}
function text(value: unknown, maximum: number, nonempty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (nonempty && !value.length)
  )
    return invalid("invalid metadata text");
  return value;
}
function integer(value: unknown, maximum: number, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalid("invalid metadata count or version");
  return value;
}
function ids(value: unknown, maximum: number): string[] {
  const result = array(value, maximum).map((value) => identifier(value));
  if (!result.length || new Set(result).size !== result.length)
    return invalid("invalid field mapping");
  return result;
}
const historyFiles: Record<RestoreHistoryKind, string> = {
  comments: "history/comments.ndjson",
  mutations: "history/mutations.ndjson",
  "cell-changes": "history/cell-changes.ndjson",
  "resource-history": "history/resource-history.ndjson",
  views: "history/saved-views.ndjson",
};
export interface RestoreArchive {
  source: RestoreSource;
  manifest: BackupManifest;
  close(): void;
}

class ArchiveReader {
  private metadataBytes = 0;
  constructor(
    readonly zip: ZipFile,
    readonly entries: Map<string, Entry>,
    readonly check: () => Promise<void>,
  ) {}
  async stream(name: string): Promise<Readable> {
    const entry =
      this.entries.get(name) ?? invalid("a required file is missing");
    await this.check();
    return new Promise((resolve, reject) =>
      this.zip.openReadStream(entry, (error, stream) =>
        error ? reject(error) : resolve(stream!),
      ),
    );
  }
  async json(
    name: string,
  ): Promise<{ value: JsonValue; numbers: NumberLexeme[] }> {
    const entry =
      this.entries.get(name) ?? invalid("a required metadata file is missing");
    if (entry.uncompressedSize > restoreLimits.metadataFileBytes)
      return invalid("a metadata file exceeds 8 MiB");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of await this.stream(name)) {
      bytes += chunk.length;
      this.metadataBytes += chunk.length;
      if (
        bytes > restoreLimits.metadataFileBytes ||
        this.metadataBytes > restoreLimits.metadataBytes
      )
        return invalid("metadata exceeds the 64 MiB restore budget");
      chunks.push(Buffer.from(chunk));
    }
    const numbers: NumberLexeme[] = [];
    const value = decodeJsonBytes(Buffer.concat(chunks), {
      maxBytes: restoreLimits.metadataFileBytes,
      maxDepth: 96,
      safeIntegers: false,
      onNumber: (number) => numbers.push(number),
    });
    losslessNumbers(numbers);
    for (const number of numbers) {
      const leaf = String(number.path.at(-1));
      if (
        !number.path.includes("default") &&
        [
          "position",
          "order",
          "schemaVersion",
          "rowCount",
          "bytes",
          "formatVersion",
        ].includes(leaf) &&
        (!number.integer || !number.safeInteger)
      )
        invalid("metadata integers must be lossless");
    }
    return { value, numbers };
  }
  async *lines(
    name: string,
    maximum: number,
  ): AsyncGenerator<{
    value: JsonValue;
    numbers: NumberLexeme[];
    bytes: number;
  }> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const parse = () => {
      if (!bytes) return invalid("an NDJSON file contains a blank record");
      const numbers: NumberLexeme[] = [];
      const value = decodeJsonBytes(Buffer.concat(chunks, bytes), {
        maxBytes: maximum,
        maxDepth: 96,
        safeIntegers: false,
        onNumber: (number) => numbers.push(number),
      });
      losslessNumbers(numbers);
      const result = { value, numbers, bytes };
      chunks.length = 0;
      bytes = 0;
      return result;
    };
    for await (const value of await this.stream(name)) {
      const chunk = Buffer.from(value);
      let position = 0;
      while (position < chunk.length) {
        const newline = chunk.indexOf(10, position);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(position, end);
        bytes += part.length;
        if (bytes > maximum)
          return invalid("an NDJSON record exceeds its byte budget");
        chunks.push(part);
        position = end + 1;
        if (newline !== -1) yield parse();
      }
    }
    if (bytes) yield parse();
  }
  async *history(
    kind: RestoreHistoryKind,
  ): AsyncGenerator<RestoreHistoryRecord[]> {
    if (kind === "views" && !this.entries.has(historyFiles.views)) return;
    let batch: RestoreHistoryRecord[] = [];
    let bytes = 0;
    for await (const line of this.lines(
      historyFiles[kind],
      restoreLimits.historyLineBytes,
    )) {
      if (
        batch.length &&
        (batch.length >= restoreLimits.batchRows ||
          bytes + line.bytes > restoreLimits.batchBytes)
      ) {
        await this.check();
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push({ value: object(line.value), numbers: line.numbers });
      bytes += line.bytes;
    }
    if (batch.length) {
      await this.check();
      yield batch;
    }
  }
  async *rows(table: RestoreTable): AsyncGenerator<RestoreRow[]> {
    let batch: RestoreRow[] = [];
    let bytes = 0,
      count = 0;
    const fieldIds = new Set(table.fields.map((field) => field.id));
    for await (const line of this.lines(
      `tables/${table.id}/rows.ndjson`,
      restoreLimits.rowLineBytes,
    )) {
      const raw = object(line.value);
      if (
        Object.keys(raw).some(
          (key) =>
            !["id", "version", "createdAt", "updatedAt", "values"].includes(
              key,
            ),
        )
      )
        invalid("record metadata contains unsupported fields");
      const rawValues = object(raw.values);
      const values: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(rawValues)) {
        const fieldId = identifier(key);
        if (!fieldIds.has(fieldId) || Object.hasOwn(values, fieldId))
          invalid("a record contains unknown or repeated field identifiers");
        values[fieldId] = value;
      }
      if (Object.keys(values).length !== fieldIds.size)
        invalid("a record is missing fields");
      assertValueLexemes(table.fields, line.numbers);
      const named = Object.fromEntries(
        table.fields.map((field) => [field.name, values[field.id]]),
      );
      assertRowBytes(
        table.fields,
        validateValues(table.fields, named, "create"),
      );
      const row: RestoreRow = {
        id: identifier(raw.id),
        version: version(raw.version),
        createdAt: backupTimestamp(raw.createdAt),
        updatedAt: backupTimestamp(raw.updatedAt),
        values,
      };
      if (++count > table.rowCount)
        invalid("record counts do not match the manifest");
      if (
        batch.length &&
        (batch.length >= restoreLimits.batchRows ||
          bytes + line.bytes > restoreLimits.batchBytes)
      ) {
        await this.check();
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push(row);
      bytes += line.bytes;
    }
    if (count !== table.rowCount)
      invalid("record counts do not match the manifest");
    if (batch.length) {
      await this.check();
      yield batch;
    }
  }
}

export async function openRestoreArchive(options: {
  path: string;
  orgId: string;
  databaseId: string;
  maximumBytes: number;
  migrations: ReadonlyMap<string, string>;
  check(): Promise<void>;
}): Promise<RestoreArchive> {
  await inspectBackupArchive(options.path, options.maximumBytes, {
    maxEntries: restoreLimits.archiveEntries,
    check: options.check,
  });
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    openZip(
      options.path,
      { lazyEntries: true, autoClose: false },
      (error, value) => (error ? reject(error) : resolve(value!)),
    ),
  );
  try {
    const entries = new Map<string, Entry>();
    for await (const entry of backupArchiveEntries(zip)) {
      if (
        entries.size >= restoreLimits.archiveEntries ||
        entries.has(entry.fileName)
      )
        invalid("too many or repeated archive entries");
      entries.set(entry.fileName, entry);
    }
    const reader = new ArchiveReader(zip, entries, options.check);
    const rawManifest = object((await reader.json("manifest.json")).value);
    if (
      rawManifest.format !== "rootset.database-backup" ||
      rawManifest.formatVersion !== 1
    )
      invalid("unsupported package format");
    const sourceId = identifier(rawManifest.databaseId),
      orgId = identifier(rawManifest.orgId);
    if (sourceId !== options.databaseId || orgId !== options.orgId)
      invalid("the package does not belong to this backup");
    backupTimestamp(rawManifest.snapshotAt);
    backupTimestamp(rawManifest.scheduledAt);
    text(rawManifest.rootsetVersion, 100, true);
    const descriptors = new Map<
      string,
      { id: string; name: string; schemaVersion: number; rowCount: number }
    >();
    for (const value of array(rawManifest.tables, restoreLimits.tables)) {
      const table = object(value),
        id = identifier(table.id);
      if (descriptors.has(id)) invalid("repeated table identifiers");
      descriptors.set(id, {
        id,
        name: text(table.name, 200, true),
        schemaVersion: integer(table.schemaVersion, 2147483647, 1),
        rowCount: integer(table.rowCount, 5_000_000),
      });
    }
    const migrations = array(
      (await reader.json("migrations.json")).value,
      1000,
    );
    if (!migrations.length) invalid("migration provenance is missing");
    const migrationNames = new Set<string>();
    for (const value of migrations) {
      const row = object(value),
        name = text(row.name, 200, true),
        digest = text(row.digest, 64, true);
      if (migrationNames.has(name) || options.migrations.get(name) !== digest)
        invalid("the package requires unsupported schema migrations");
      migrationNames.add(name);
    }
    const database = object((await reader.json("database.json")).value);
    if (
      identifier(database.id) !== sourceId ||
      identifier(database.org_id) !== orgId ||
      database.state !== "active"
    )
      invalid("database metadata does not match the package");
    backupTimestamp(database.created_at);
    backupTimestamp(database.updated_at);
    const databaseInfo = {
      id: sourceId,
      name: text(database.name, 200, true),
      description: text(database.description, 4096),
    };
    const catalog = array(
      (await reader.json("catalog.json")).value,
      restoreLimits.tables,
    );
    const expected = new Set([
      "manifest.json",
      "database.json",
      "migrations.json",
      "schedule.json",
      "catalog.json",
      ...Object.values(historyFiles).filter(
        (name) => name !== historyFiles.views,
      ),
    ]);
    if (entries.has(historyFiles.views)) expected.add(historyFiles.views);
    await reader.json("schedule.json");
    const tables: RestoreTable[] = [];
    const seenTables = new Set<string>(),
      seenFields = new Set<string>(),
      seenRules = new Set<string>(),
      seenKeys = new Set<string>();
    for (const value of catalog) {
      const entry = object(value),
        id = identifier(entry.id);
      if (seenTables.has(id)) invalid("repeated catalog identifiers");
      seenTables.add(id);
      if (entry.state !== "active" && entry.state !== "deleted")
        invalid("the catalog contains unfinished table maintenance");
      const table: RestoreTable = {
        id,
        name: text(entry.name, 200, true),
        description: text(entry.description, 4096),
        state: entry.state,
        schemaVersion: 1,
        rowCount: 0,
        createdAt: backupTimestamp(entry.created_at),
        updatedAt: backupTimestamp(entry.updated_at),
        deletedAt:
          entry.deleted_at === null ? null : backupTimestamp(entry.deleted_at),
        fields: [],
        allFields: [],
        uniqueRules: [],
        foreignKeys: [],
        counters: [],
      };
      tables.push(table);
      if (table.state === "deleted") {
        if (descriptors.has(id)) invalid("a deleted table has active data");
        continue;
      }
      const descriptor =
        descriptors.get(id) ??
        invalid("a catalog table is missing from the manifest");
      table.schemaVersion = descriptor.schemaVersion;
      table.rowCount = descriptor.rowCount;
      const base = `tables/${id}`;
      for (const name of [
        "schema.json",
        "fields.json",
        "unique-rules.json",
        "foreign-keys.json",
        "counters.json",
        "rows.ndjson",
      ])
        expected.add(`${base}/${name}`);
      const schemaFile = await reader.json(`${base}/schema.json`),
        schema = object(schemaFile.value);
      if (
        identifier(schema.id) !== id ||
        schema.name !== table.name ||
        descriptor.name !== table.name ||
        schema.description !== table.description ||
        schema.schemaVersion !== table.schemaVersion
      )
        invalid("table schemas disagree with the catalog");
      if (
        Date.parse(backupTimestamp(schema.createdAt)) !==
          Date.parse(table.createdAt) ||
        Date.parse(backupTimestamp(schema.updatedAt)) !==
          Date.parse(table.updatedAt)
      )
        invalid("table timestamps disagree with the catalog");
      const schemaFields = array(schema.fields, limits.maxFields).map(
        (value, index) => {
          const field = definition(value);
          assertFieldDefinitionLexemes(field, schemaFile.numbers, [
            "fields",
            index,
          ]);
          return field;
        },
      );
      const fieldFile = await reader.json(`${base}/fields.json`);
      for (const [index, value] of array(fieldFile.value, 100_000).entries()) {
        const raw = object(value),
          fieldDefinition = definition(raw.definition),
          fid = identifier(raw.id);
        assertFieldDefinitionLexemes(fieldDefinition, fieldFile.numbers, [
          index,
          "definition",
        ]);
        if (
          seenFields.has(fid) ||
          fieldDefinition.id !== fid ||
          fieldDefinition.name !== raw.name
        )
          invalid("field metadata is inconsistent");
        seenFields.add(fid);
        if (raw.state !== "active" && raw.state !== "deleted")
          invalid("field maintenance is incomplete");
        const field: RestoreField = {
          id: fid,
          name: fieldDefinition.name,
          definition: fieldDefinition,
          position: integer(raw.position, 2147483647),
          state: raw.state,
          createdAt: backupTimestamp(raw.created_at),
          deletedAt:
            raw.deleted_at === null ? null : backupTimestamp(raw.deleted_at),
        };
        table.allFields.push(field);
      }
      const active = table.allFields
        .filter((field) => field.state === "active")
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      if (
        active.length !== schemaFields.length ||
        new Set(active.map((field) => field.position)).size !== active.length ||
        active.some(
          (field, index) =>
            canonicalJson(field.definition) !==
            canonicalJson(schemaFields[index]),
        )
      )
        invalid("active field definitions disagree with the schema");
      table.fields = active.map((field) => field.definition);
      assertFieldNames(table.fields);
      assertAllowedValuesBudget(table.fields);
      const ruleFile = await reader.json(`${base}/unique-rules.json`);
      for (const [index, value] of array(
        ruleFile.value,
        limits.maxUniqueRules,
      ).entries()) {
        const raw = object(value),
          rid = identifier(raw.id),
          fieldIds = ids(raw.field_ids, limits.maxUniqueFields);
        if (
          seenRules.has(rid) ||
          raw.state !== "active" ||
          !["native", "registry"].includes(String(raw.strategy))
        )
          invalid("invalid unique-rule metadata");
        seenRules.add(rid);
        if (
          fieldIds.some(
            (fid) =>
              !table.fields.some(
                (field) => field.id === fid && field.type !== "json",
              ),
          )
        )
          invalid("a unique rule refers to a missing scalar field");
        const where = validateUniqueRuleCondition(
          raw.condition === null ? undefined : raw.condition,
          table.fields,
        );
        if (where)
          assertQueryLexemes(
            table.fields,
            { where },
            ruleFile.numbers
              .filter(
                (number) =>
                  number.path[0] === index && number.path[1] === "condition",
              )
              .map((number) => ({
                ...number,
                path: ["query", "where", ...number.path.slice(2)],
              })),
          );
        const rule: RestoreUniqueRule = {
          id: rid,
          name: text(raw.name, 1024, true),
          fieldIds,
          strategy: raw.strategy as RestoreUniqueRule["strategy"],
          ...(where ? { where } : {}),
        };
        table.uniqueRules.push(rule);
      }
      for (const value of array(
        (await reader.json(`${base}/foreign-keys.json`)).value,
        limits.maxForeignKeys,
      )) {
        const raw = object(value),
          kid = identifier(raw.id);
        if (seenKeys.has(kid) || raw.state !== "active")
          invalid("invalid foreign-key metadata");
        seenKeys.add(kid);
        const key: RestoreForeignKey = {
          id: kid,
          fieldIds: ids(raw.field_ids, limits.maxUniqueFields),
          referencedFieldIds: ids(
            raw.referenced_field_ids,
            limits.maxUniqueFields,
          ),
          referencedTableId: identifier(raw.referenced_table_id),
          referencedRuleId: identifier(raw.referenced_rule_id),
        };
        table.foreignKeys.push(key);
      }
      for (const value of array(
        (await reader.json(`${base}/counters.json`)).value,
        table.allFields.length,
      )) {
        const raw = object(value),
          fid = identifier(raw.field_id),
          next = text(raw.next_value, 21, true);
        if (
          !/^-?\d{1,20}$/.test(next) ||
          table.counters.some((counter) => counter.fieldId === fid) ||
          !table.allFields.some((field) => field.id === fid)
        )
          invalid("invalid generated-ID counter");
        const nextValue = BigInt(next);
        if (
          nextValue < BigInt(Number.MIN_SAFE_INTEGER) ||
          nextValue > BigInt(Number.MAX_SAFE_INTEGER) + 1n
        )
          invalid("a generated-ID counter is outside its supported range");
        table.counters.push({ fieldId: fid, nextValue: nextValue.toString() });
      }
      if (
        table.fields.some(
          (field) =>
            field.type === "integer" &&
            field.autoIncrement &&
            !table.counters.some((counter) => counter.fieldId === field.id),
        )
      )
        invalid("a generated-ID counter is missing");
    }
    if (
      descriptors.size !==
      tables.filter((table) => table.state === "active").length
    )
      invalid("the manifest contains tables absent from the catalog");
    const byId = new Map(tables.map((table) => [table.id, table]));
    for (const table of tables)
      for (const key of table.foreignKeys) {
        const target = byId.get(key.referencedTableId),
          rule = target?.uniqueRules.find(
            (rule) => rule.id === key.referencedRuleId,
          );
        if (
          !target ||
          target.state !== "active" ||
          !rule ||
          rule.where ||
          canonicalJson(rule.fieldIds) !==
            canonicalJson(key.referencedFieldIds) ||
          key.fieldIds.length !== key.referencedFieldIds.length
        )
          invalid(
            "a foreign-key target is missing or not unconditionally unique",
          );
        for (const [index, fid] of key.fieldIds.entries()) {
          const sourceField = table.fields.find((field) => field.id === fid),
            targetField = target.fields.find(
              (field) => field.id === key.referencedFieldIds[index],
            );
          if (
            !sourceField ||
            !targetField ||
            sourceField.type === "json" ||
            sourceField.type !== targetField.type
          )
            invalid("foreign-key field types do not match");
        }
      }
    if (
      entries.size !== expected.size ||
      [...entries.keys()].some((name) => !expected.has(name))
    )
      invalid("the package has missing or unsupported entries");
    for (const name of expected)
      if (!entries.has(name)) invalid("a required archive entry is missing");
    const manifest = rawManifest as unknown as BackupManifest;
    return {
      manifest,
      source: {
        database: databaseInfo,
        tables,
        check: options.check,
        rows(tableId) {
          const table = byId.get(tableId);
          if (!table || table.state !== "active")
            return invalid("unknown data table");
          return reader.rows(table);
        },
        history: (kind) => reader.history(kind),
      },
      close: () => zip.close(),
    };
  } catch (error) {
    zip.close();
    throw error;
  }
}
