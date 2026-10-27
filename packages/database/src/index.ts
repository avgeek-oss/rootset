import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export { Pool };
export {
  withOrgRead,
  ReadCancelledError,
  ReadCancellationFailure,
} from "./read.js";
export type { PoolClient, QueryResultRow };
export type Queryable = Pool | PoolClient;

const baselineName = "0001_baseline.sql";
const previousReleaseBaseline =
  "4eb1bef6adf616d0c93b2165d39cd44655bb2640a29d4033e812cca11dcf8139";
const commentReleaseMigrations = new Map([
  [
    baselineName,
    "fffd4634da07c05545d925ea7e7e940257a2da180aa552a52243b95475015ebe",
  ],
  [
    "0002_mcp_role_revocation.sql",
    "381775803fc348664371f2b5209a0b734530b63f69905af4b3ba3355d3ae9932",
  ],
  [
    "0003_comment_deletion_log.sql",
    "5eecc1162012ca9a8cc4c1933a7047832190c567392a50c6575db80956620b99",
  ],
]);
async function definitions(directory: string) {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (
    files[0] !== baselineName ||
    files.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  )
    throw new Error(`Rootset migrations must start with ${baselineName}`);
  return Promise.all(
    files.map(async (name) => {
      const source = await readFile(`${directory}/${name}`, "utf8");
      return {
        name,
        source,
        digest: createHash("sha256").update(source).digest("hex"),
      };
    }),
  );
}

export async function migrationStatus(
  connection: Queryable,
  directory = fileURLToPath(new URL("../migrations/", import.meta.url)),
): Promise<{ complete: boolean; version: string }> {
  const expected = await definitions(directory);
  const applied = (
    await connection.query<{ name: string; digest: string }>(
      "SELECT name,digest FROM rootset_control.migrations ORDER BY name",
    )
  ).rows;
  const recorded = new Map(applied.map((row) => [row.name, row.digest]));
  return {
    complete:
      expected.length > 0 &&
      expected.length === applied.length &&
      expected.every((row) => recorded.get(row.name) === row.digest),
    version: applied.at(-1)?.name ?? "",
  };
}

export type PoolPurpose =
  "database" | "api" | "admission" | "ddl" | "identity" | "worker";

const connectionFailureCodes = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

export function createPool(
  connectionString: string,
  max = 10,
  purpose: PoolPurpose = "database",
  options: { connectionTimeoutMillis?: number } = {},
): Pool {
  // How long a request may wait for a pooled connection. Tests may inject a
  // shorter wait; production uses the default.
  const connectionTimeoutMillis = options.connectionTimeoutMillis ?? 5_000;
  if (
    !Number.isSafeInteger(connectionTimeoutMillis) ||
    connectionTimeoutMillis < 1
  )
    throw new Error("connectionTimeoutMillis must be a positive integer");
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis,
    application_name: "rootset",
    options:
      "-c timezone=UTC -c statement_timeout=10000 -c idle_in_transaction_session_timeout=30000",
  });
  const leased = new WeakSet<PoolClient>();
  const observe = (state: "idle" | "checked_out", error: Error) => {
    const code = (error as { code?: unknown }).code;
    console.error(
      JSON.stringify({
        level: "error",
        event: "postgres_pool_connection_failed",
        timestamp: new Date().toISOString(),
        pool: purpose,
        state,
        error_code:
          typeof code === "string" && connectionFailureCodes.has(code)
            ? code
            : "UNKNOWN",
        message:
          "PostgreSQL connection was lost; check database availability. Failed work remains failed; later checkouts can reconnect.",
      }),
    );
  };
  pool.on("error", (error) => observe("idle", error));
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      if (leased.has(client)) observe("checked_out", error);
    });
  });
  pool.on("acquire", (client) => leased.add(client));
  pool.on("release", (_error, client) => leased.delete(client));
  return pool;
}

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseWithError = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      releaseWithError = true;
    }
    throw error;
  } finally {
    client.release(releaseWithError);
  }
}

export async function withOrg<T>(
  pool: Pool,
  orgId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return transaction(pool, async (client) => {
    await client.query("SELECT set_config('rootset.org_id',$1,true)", [orgId]);
    return work(client);
  });
}

export async function migrate(
  pool: Pool,
  directory = fileURLToPath(new URL("../migrations/", import.meta.url)),
): Promise<string[]> {
  const expected = await definitions(directory);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('rootset:migrations'))",
    );
    await client.query("CREATE SCHEMA IF NOT EXISTS rootset_control");
    await client.query(
      "CREATE TABLE IF NOT EXISTS rootset_control.migrations (name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const existing = await client.query<{ name: string; digest: string }>(
      "SELECT name,digest FROM rootset_control.migrations",
    );
    if (
      existing.rows.some(
        (row) => !expected.some((definition) => definition.name === row.name),
      )
    )
      throw new Error(
        "This database uses an earlier prelaunch schema. Preserve it and use a fresh database for the V1 baseline.",
      );
    const upgradeComments =
      existing.rows.some(
        (row) =>
          row.name === baselineName && row.digest === previousReleaseBaseline,
      ) &&
      [...commentReleaseMigrations].every(([name, digest]) =>
        expected.some(
          (migration) => migration.name === name && migration.digest === digest,
        ),
      );
    for (const previous of existing.rows) {
      if (upgradeComments && previous.name === baselineName) continue;
      if (
        expected.find((migration) => migration.name === previous.name)
          ?.digest !== previous.digest
      )
        throw new Error(`Migration ${previous.name} changed after application`);
    }
    if (upgradeComments) {
      try {
        await client.query(
          await readFile(
            new URL("../upgrades/v0.1.4.sql", import.meta.url),
            "utf8",
          ),
        );
        applied.push(baselineName, "0003_comment_deletion_log.sql");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    for (const { name, source, digest } of expected) {
      const previous = await client.query<{ digest: string }>(
        "SELECT digest FROM rootset_control.migrations WHERE name=$1",
        [name],
      );
      if (previous.rowCount) {
        if (previous.rows[0]?.digest !== digest)
          throw new Error(`Migration ${name} changed after application`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL statement_timeout=0");
        await client.query(source);
        await client.query(
          "INSERT INTO rootset_control.migrations(name,digest) VALUES($1,$2)",
          [name, digest],
        );
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('rootset:migrations'))")
      .catch(() => undefined);
    client.release();
  }
}
