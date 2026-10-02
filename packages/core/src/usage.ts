import { targetAllows } from "@rootset/access";
import { limits, type Actor } from "@rootset/contracts";
import { withOrg, type Pool } from "@rootset/database";
import type { CapacityService } from "@rootset/capacity";
export async function readUsage(
  pool: Pool,
  actor: Actor,
  capacity: CapacityService,
) {
  let storageQuotaBytes: string | null = null;
  let storageAdmission: {
    state:
      | "available"
      | "quota_exceeded"
      | "disk_pressure"
      | "report_stale"
      | "unavailable";
    reason: string | null;
  } = {
    state: "unavailable",
    reason: "Storage capacity status is unavailable",
  };
  try {
    const status = await capacity.status(undefined, actor.orgId);
    storageQuotaBytes = status.organisation?.quotaBytes ?? null;
    storageAdmission = status.admission;
  } catch {
    // Capacity failure cannot hide existing data or produce false admission.
  }
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
      (t) =>
        actor.scopes.includes("rows:read") &&
        actor.scopes.includes("tables:read") &&
        targetAllows(
          actor,
          { databaseId: t.database_id, tableId: t.id },
          "read",
        ),
    );
    const databaseIds = (
      await c.query<{ id: string }>(
        "SELECT id FROM rootset_control.databases WHERE state='active'",
      )
    ).rows
      .filter(
        (d) =>
          actor.scopes.includes("databases:read") &&
          (actor.unrestricted ||
            actor.targets.some((g) => !g.databaseId || g.databaseId === d.id)),
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
      storageQuotaBytes,
      storageAdmission,
      admissionAvailable:
        storageAdmission.state === "available" &&
        actor.scopes.includes("rows:write") &&
        visible.some(
          (t) =>
            Number(t.row_count) < limits.maxRows &&
            targetAllows(
              actor,
              { databaseId: t.database_id, tableId: t.id },
              "edit",
            ),
        ),
    };
  });
}
