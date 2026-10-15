import type { PoolClient } from "@rootset/database";
import { RootsetError, type Actor } from "@rootset/contracts";
import type { StoragePort } from "../types.js";
import type { BackupEntry, BackupManifest } from "./format.js";

const json = (value: unknown) =>
  (async function* () {
    yield JSON.stringify(value);
  })();
export async function databaseSnapshot(options: {
  client: PoolClient;
  storage: StoragePort;
  actor: Actor;
  databaseId: string;
  scheduledAt: string;
  rootsetVersion: string;
  check: () => Promise<void>;
  afterTable?: () => Promise<void>;
}) {
  const { client, actor, databaseId, check } = options;
  const database = (
    await client.query(
      "SELECT id,org_id,name,description,created_at::text AS created_at,updated_at::text AS updated_at,state FROM rootset_control.databases WHERE id=$1 AND org_id=$2",
      [databaseId, actor.orgId],
    )
  ).rows[0];
  if (!database || database.state !== "active")
    throw new RootsetError("RESOURCE_NOT_FOUND", "Database was not found", 404);
  const tables = (
    await client.query<{ id: string; state: string }>(
      "SELECT id,state FROM rootset_control.tables WHERE database_id=$1 AND state<>'deleted' ORDER BY id",
      [databaseId],
    )
  ).rows;
  if (tables.some((table) => table.state !== "active"))
    throw new RootsetError(
      "UPSTREAM_UNAVAILABLE",
      "A table is undergoing schema maintenance; the backup will be retried",
      503,
    );
  const snapshotAt = (
    await client.query<{ at: Date }>("SELECT transaction_timestamp() AS at")
  ).rows[0]!.at.toISOString();
  const manifest: BackupManifest = {
    format: "rootset.database-backup",
    formatVersion: 1,
    rootsetVersion: options.rootsetVersion,
    databaseId,
    orgId: actor.orgId,
    snapshotAt,
    scheduledAt: options.scheduledAt,
    tables: [],
    files: [],
  };
  const entries: BackupEntry[] = [
    { name: "database.json", content: json(database) },
  ];
  for (const [name, sql] of [
    [
      "migrations.json",
      "SELECT name,digest FROM rootset_control.migrations ORDER BY name",
    ],
    [
      "schedule.json",
      "SELECT bucket,prefix,cron,timezone,enabled FROM rootset_control.backup_schedules WHERE database_id=$1",
    ],
    [
      "catalog.json",
      "SELECT id,name,description,state,created_at::text AS created_at,updated_at::text AS updated_at,deleted_at::text AS deleted_at FROM rootset_control.tables WHERE database_id=$1 ORDER BY id",
    ],
  ]) {
    const result = await client.query(
      sql!,
      name === "migrations.json" ? [] : [databaseId],
    );
    entries.push({ name: name!, content: json(result.rows) });
  }
  for (const table of tables) {
    await check();
    const source = await options.storage.snapshotTable(
      actor,
      table.id,
      {},
      client,
      { preserveTimestampPrecision: true },
    );
    const base = `tables/${table.id}`;
    const descriptor = {
      id: table.id,
      name: source.table.name,
      schemaVersion: source.table.schemaVersion,
      rowCount: 0,
    };
    manifest.tables.push(descriptor);
    entries.push({
      name: `${base}/schema.json`,
      content: json({
        id: table.id,
        name: source.table.name,
        description: source.table.description,
        createdAt: source.table.createdAt,
        updatedAt: source.table.updatedAt,
        schemaVersion: source.table.schemaVersion,
        fields: source.table.fields,
      }),
    });
    for (const [file, sql] of [
      [
        "fields.json",
        "SELECT id,name,definition,position,state,created_at::text AS created_at,deleted_at::text AS deleted_at FROM rootset_control.fields WHERE table_id=$1 ORDER BY position,id",
      ],
      [
        "unique-rules.json",
        "SELECT id,name,field_ids,condition,strategy,state FROM rootset_control.unique_rules WHERE table_id=$1 AND state='active' ORDER BY id",
      ],
      [
        "foreign-keys.json",
        "SELECT id,field_ids,referenced_table_id,referenced_field_ids,referenced_rule_id,state FROM rootset_control.foreign_keys WHERE table_id=$1 AND state='active' ORDER BY id",
      ],
      [
        "counters.json",
        "SELECT field_id,next_value::text AS next_value FROM rootset_control.integer_counters WHERE table_id=$1 ORDER BY field_id",
      ],
    ]) {
      const result = await client.query(sql!, [table.id]);
      entries.push({ name: `${base}/${file}`, content: json(result.rows) });
    }
    async function* rows() {
      for await (const batch of source.rows) {
        await check();
        for (const row of batch) {
          descriptor.rowCount++;
          yield `${JSON.stringify({
            id: row.id,
            version: row.version,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            values: Object.fromEntries(
              source.table.fields.map((field) => [
                field.id,
                row.values[field.name] ?? null,
              ]),
            ),
          })}\n`;
        }
      }
      await options.afterTable?.();
    }
    entries.push({ name: `${base}/rows.ndjson`, content: rows() });
  }
  const logs = [
    {
      file: "comments.ndjson",
      sql: "SELECT r.*,r.created_at::text AS created_at,r.deleted_at::text AS deleted_at FROM rootset_control.row_comments r JOIN rootset_control.tables t ON t.id=r.table_id WHERE t.database_id=$1 AND r.id>$2 ORDER BY r.id LIMIT 500",
      key: "",
    },
    {
      file: "cell-changes.ndjson",
      sql: "SELECT r.*,r.changed_at::text AS changed_at FROM rootset_control.cell_changes r WHERE r.database_id=$1 AND r.id>$2::bigint ORDER BY r.id LIMIT 500",
      key: "0",
    },
    {
      file: "resource-history.ndjson",
      sql: "SELECT r.*,r.changed_at::text AS changed_at FROM rootset_control.resource_history r WHERE r.database_id=$1 AND r.id>$2::bigint ORDER BY r.id LIMIT 500",
      key: "0",
    },
    {
      file: "mutations.ndjson",
      sql: "SELECT r.id,r.table_id,r.schema_version,r.actor,r.context,r.committed_at::text AS committed_at FROM rootset_control.mutations r JOIN rootset_control.tables t ON t.id=r.table_id WHERE t.database_id=$1 AND r.id>$2 ORDER BY r.id LIMIT 500",
      key: "",
    },
  ];
  for (const log of logs) {
    async function* rows() {
      let key = log.key;
      for (;;) {
        await check();
        const result = await client.query(log.sql, [databaseId, key]);
        if (!result.rows.length) return;
        for (const raw of result.rows) {
          const row = { ...raw };
          if (row.actor && typeof row.actor === "object") {
            const attribution = row.actor as Actor;
            row.actor = {
              kind: attribution.kind,
              id: attribution.userId ?? attribution.id,
              ...(attribution.userId ? { userId: attribution.userId } : {}),
            };
          }
          yield `${JSON.stringify(row)}\n`;
        }
        key = String(result.rows.at(-1)!.id);
      }
    }
    entries.push({ name: `history/${log.file}`, content: rows() });
  }
  return { entries, manifest };
}
