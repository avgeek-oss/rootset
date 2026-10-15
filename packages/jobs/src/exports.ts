import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { stringify } from "csv-stringify/sync";
import {
  canonicalJson,
  RootsetError,
  type Actor,
  type FieldDefinition,
  type Row,
} from "@rootset/contracts";
import type { PoolClient } from "@rootset/database";
import type { StoragePort } from "./types.js";

export type ExportFormat = "csv" | "jsonl";

export async function* tableExportRows(
  fields: readonly FieldDefinition[],
  rows: AsyncIterable<Row[]>,
  format: ExportFormat,
  hooks: {
    check(): Promise<void>;
    afterBatch(): Promise<void>;
    onRows(count: number): void;
  },
): AsyncGenerator<string> {
  if (format === "csv") yield stringify([fields.map((field) => field.name)]);
  for await (const batch of rows) {
    await hooks.check();
    for (const row of batch) {
      if (format === "jsonl")
        yield `${canonicalJson(row.values, { maxDepth: 96 })}\n`;
      else
        yield stringify(
          [
            fields.map((field) => {
              const value = row.values[field.name];
              let text =
                value === null
                  ? "\\N"
                  : typeof value === "object"
                    ? canonicalJson(value)
                    : String(value);
              if (
                ["text", "uri", "url", "image"].includes(field.type) &&
                typeof value === "string" &&
                text.startsWith("\\")
              )
                text = `\\${text}`;
              return text;
            }),
          ],
          { quoted_empty: true },
        );
    }
    hooks.onRows(batch.length);
    await hooks.afterBatch();
  }
}

export async function databaseExport(options: {
  client: PoolClient;
  storage: StoragePort;
  actor: Actor;
  databaseId: string;
  rootsetVersion: string;
  format: ExportFormat;
  check(): Promise<void>;
  afterBatch(): Promise<void>;
  afterTable(): Promise<void>;
  onTable(completed: number, total: number): Promise<void>;
}) {
  const { client, actor, databaseId, format } = options;
  const database = (
    await client.query(
      "SELECT id,name,description,created_at,updated_at FROM rootset_control.databases WHERE id=$1 AND org_id=$2 AND state='active'",
      [databaseId, actor.orgId],
    )
  ).rows[0];
  if (!database)
    throw new RootsetError("RESOURCE_NOT_FOUND", "Database was not found", 404);
  const catalogue = (
    await client.query<{
      id: string;
      name: string;
      schema_version: number;
      state: string;
    }>(
      "SELECT id,name,schema_version,state FROM rootset_control.tables WHERE database_id=$1 AND state<>'deleted' ORDER BY id",
      [databaseId],
    )
  ).rows;
  if (catalogue.some((table) => table.state !== "active"))
    throw new RootsetError(
      "SCHEMA_MAINTENANCE",
      "Wait for table maintenance to finish, then retry the database export.",
      409,
    );
  const snapshotAt = (
    await client.query<{ at: Date }>("SELECT transaction_timestamp() AS at")
  ).rows[0]!.at.toISOString();
  const manifest = {
    format: "rootset.database-export",
    formatVersion: 1,
    rootsetVersion: options.rootsetVersion,
    databaseId,
    snapshotAt,
    dataFormat: format,
    rowCount: 0,
    tables: catalogue.map((table) => ({
      id: table.id,
      name: table.name,
      schemaVersion: Number(table.schema_version),
      rowCount: 0,
      schema: `tables/${table.id}/schema.json`,
      data: `tables/${table.id}/data.${format}`,
    })),
    files: [] as { name: string; bytes: number; sha256: string }[],
  };
  const zip = new ZipFile();
  // yazl returns a Node PassThrough, but declares only NodeJS.ReadableStream.
  const stream = zip.outputStream as Readable;
  const sources: Readable[] = [];
  const json = (value: unknown) =>
    (async function* () {
      yield JSON.stringify(value);
    })();
  function add(name: string, content: AsyncIterable<string>) {
    async function* checked() {
      await options.check();
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of content) {
        hash.update(chunk);
        bytes += Buffer.byteLength(chunk);
        yield chunk;
      }
      manifest.files.push({ name, bytes, sha256: hash.digest("hex") });
    }
    const source = Readable.from(checked());
    source.on("error", (error) => stream.destroy(error));
    sources.push(source);
    zip.addReadStream(source, name, { forceZip64Format: true });
  }
  add(
    "database.json",
    json({
      id: database.id,
      name: database.name,
      description: database.description,
      createdAt: database.created_at.toISOString(),
      updatedAt: database.updated_at.toISOString(),
    }),
  );
  add(
    "README.txt",
    (async function* () {
      yield "Rootset database export, format version 1.\nEach table folder contains schema.json and data.csv or data.jsonl.\nTable folders use stable table IDs; manifest.json maps them to table names and records file checksums.\nCSV is UTF-8 with a header row. An unescaped \\N means NULL; text beginning with a backslash has an extra leading backslash. Empty text is quoted. JSONL preserves JSON types and NULL directly.\nSchemas include field definitions, active unique rules and foreign keys. This is a data export, not an installation backup; accounts, credentials, comments and retained history are excluded.\n";
    })(),
  );
  for (const [index, descriptor] of manifest.tables.entries()) {
    let source: ReturnType<StoragePort["snapshotTable"]> | undefined;
    const table = () =>
      (source ??= options.storage.snapshotTable(
        actor,
        descriptor.id,
        {},
        client,
      ));
    add(
      descriptor.schema,
      (async function* () {
        const { table: definition } = await table();
        const rules = (
          await client.query(
            "SELECT id,field_ids,condition,strategy FROM rootset_control.unique_rules WHERE table_id=$1 AND state='active' ORDER BY id",
            [descriptor.id],
          )
        ).rows;
        const foreignKeys = (
          await client.query(
            "SELECT k.id,k.field_ids,k.referenced_table_id,k.referenced_rule_id,k.referenced_field_ids,t.name AS referenced_table_name,ARRAY(SELECT f.name FROM unnest(k.referenced_field_ids) WITH ORDINALITY ids(id,position) JOIN rootset_control.fields f ON f.id=ids.id ORDER BY ids.position) AS referenced_field_names FROM rootset_control.foreign_keys k JOIN rootset_control.tables t ON t.id=k.referenced_table_id WHERE k.table_id=$1 AND k.state='active' ORDER BY k.id",
            [descriptor.id],
          )
        ).rows;
        yield JSON.stringify({
          table: {
            id: definition.id,
            databaseId,
            name: definition.name,
            description: definition.description,
            schemaVersion: definition.schemaVersion,
            createdAt: definition.createdAt,
            updatedAt: definition.updatedAt,
          },
          fields: definition.fields,
          uniqueRules: rules.map((rule) => ({
            id: rule.id,
            tableId: descriptor.id,
            fieldIds: rule.field_ids,
            ...(rule.condition ? { where: rule.condition } : {}),
            nullPolicy: "distinct",
            strategy: rule.strategy,
            state: "active",
          })),
          foreignKeys: foreignKeys.map((rule) => ({
            id: rule.id,
            tableId: descriptor.id,
            fieldIds: rule.field_ids,
            referencedTableId: rule.referenced_table_id,
            referencedTableName: rule.referenced_table_name,
            referencedRuleId: rule.referenced_rule_id,
            referencedFieldIds: rule.referenced_field_ids,
            referencedFieldNames: rule.referenced_field_names,
            state: "active",
          })),
        });
      })(),
    );
    add(
      descriptor.data,
      (async function* () {
        try {
          const snapshot = await table();
          yield* tableExportRows(snapshot.table.fields, snapshot.rows, format, {
            check: options.check,
            afterBatch: options.afterBatch,
            onRows(count) {
              descriptor.rowCount += count;
              manifest.rowCount += count;
            },
          });
          await options.onTable(index + 1, manifest.tables.length);
          await options.afterTable();
        } finally {
          source = undefined;
        }
      })(),
    );
  }
  const finalManifest = Readable.from(
    (async function* () {
      await options.check();
      yield JSON.stringify(manifest);
    })(),
  );
  sources.push(finalManifest);
  finalManifest.on("error", (error) => stream.destroy(error));
  zip.addReadStream(finalManifest, "manifest.json", { forceZip64Format: true });
  zip.on("error", (error) => stream.destroy(error));
  stream.once("close", () => {
    for (const source of sources) source.destroy();
  });
  zip.end({ forceZip64Format: true, comment: "" });
  return { stream, manifest };
}
