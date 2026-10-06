import { roleAllows } from "@rootset/access";
import { type Actor } from "@rootset/contracts";
import { withOrg, type Pool } from "@rootset/database";
export async function readUsage(pool: Pool, actor: Actor) {
  return withOrg(pool, actor.orgId, async (c) => {
    const visible = (
      await c.query<{
        id: string;
        database_id: string;
        row_count: string;
        schema_name: string;
        physical_name: string;
      }>(
        "SELECT t.id,t.database_id,t.row_count::text,d.schema_name,t.physical_name FROM rootset_control.tables t JOIN rootset_control.databases d ON d.id=t.database_id WHERE t.state IN ('active','maintenance') AND d.state='active'",
      )
    ).rows.filter(
      () =>
        roleAllows(actor.role, "rows:read") &&
        roleAllows(actor.role, "tables:read") &&
        (actor.kind !== "oauth" ||
          ["rows:read", "tables:read"].every((scope) =>
            actor.scopes.includes(scope),
          )),
    );
    const databaseIds = (
      await c.query<{ id: string }>(
        "SELECT id FROM rootset_control.databases WHERE state='active'",
      )
    ).rows
      .filter(
        () =>
          roleAllows(actor.role, "databases:read") &&
          (actor.kind !== "oauth" || actor.scopes.includes("databases:read")),
      )
      .map((d) => d.id);
    let dataBytes = 0,
      indexBytes = 0;
    for (const t of visible) {
      const size = (
        await c.query<{ data: string; indexes: string }>(
          "SELECT pg_table_size(to_regclass($1))::text data,pg_indexes_size(to_regclass($1))::text indexes",
          [`"${t.schema_name}"."${t.physical_name}"`],
        )
      ).rows[0];
      dataBytes += Number(size?.data ?? 0);
      indexBytes += Number(size?.indexes ?? 0);
    }
    const tableIds = visible.map((t) => t.id),
      history = (
        await c.query<{ bytes: string }>(
          "SELECT coalesce(sum(tuple_bytes),0)::text bytes FROM rootset_control.history_metrics WHERE table_id=ANY($1::text[])",
          [tableIds],
        )
      ).rows[0];
    const artifacts = (
      await c.query<{ bytes: string }>(
        "SELECT coalesce(sum(ciphertext_length),0)::text bytes FROM rootset_control.artifacts WHERE state NOT IN ('deleted','expired') AND (expires_at>now() OR purpose='backup') AND ((target_type='table' AND target_id=ANY($1::text[])) OR (target_type='database' AND target_id=ANY($2::text[])))",
        [tableIds, databaseIds],
      )
    ).rows[0];
    return {
      databases: databaseIds.length,
      tables: visible.length,
      rows: visible.reduce((sum, t) => sum + Number(t.row_count), 0),
      dataBytes,
      indexBytes,
      historyBytes: Number(history?.bytes ?? 0),
      artifactBytes: Number(artifacts?.bytes ?? 0),
    };
  });
}
