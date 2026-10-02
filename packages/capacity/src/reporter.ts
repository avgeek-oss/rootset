import { readFile, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { transaction, type Pool } from "@rootset/database";

/** Run on the PostgreSQL host, as an OS user allowed to inspect its data/WAL/tablespaces. */
export async function reportPostgresFilesystem(
  pool: Pool,
): Promise<{ volumes: number; reported: true }> {
  return transaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE rootset_capacity_reporter");
    const checkpoint = (
      await client.query<{ checkpoint: unknown }>(
        "SELECT rootset_control.capacity_report_checkpoint() AS checkpoint",
      )
    ).rows[0]!.checkpoint;
    const metadata = (
      await client.query<{ started_at: Date; version: string }>(
        "SELECT pg_postmaster_start_time() started_at,current_setting('server_version_num') version",
      )
    ).rows[0]!;
    const paths = (
      await client.query<{ name: string; path: string }>(
        "SELECT * FROM rootset_control.capacity_storage_paths()",
      )
    ).rows;
    const data = paths.find((item) => item.name === "data");
    if (!data || !data.path.startsWith("/"))
      throw new Error(
        "An absolute PostgreSQL server data directory is required",
      );
    const [version, pid] = await Promise.all([
      readFile(resolve(data.path, "PG_VERSION"), "utf8"),
      readFile(resolve(data.path, "postmaster.pid"), "utf8"),
    ]);
    const started = Number(pid.split("\n")[2]);
    if (
      version.trim() !== String(Math.floor(Number(metadata.version) / 10000)) ||
      !Number.isSafeInteger(started) ||
      Math.abs(started - Math.floor(metadata.started_at.getTime() / 1000)) > 2
    )
      throw new Error(
        "The local data directory does not match the connected PostgreSQL server; run this reporter on the database host",
      );
    const volumes = await Promise.all(
      paths.map(async (item) => {
        const value = await statfs(item.path, { bigint: true });
        return {
          name: item.name,
          availableBytes: (value.bavail * value.bsize).toString(),
          totalBytes: (value.blocks * value.bsize).toString(),
        };
      }),
    );
    await client.query(
      "SELECT rootset_control.report_storage_capacity($1::jsonb,$2::jsonb)",
      [JSON.stringify(volumes), JSON.stringify(checkpoint)],
    );
    return { volumes: volumes.length, reported: true };
  });
}
