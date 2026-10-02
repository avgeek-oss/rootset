import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPool, type Pool } from "@rootset/database";

export const root = resolve(import.meta.dirname, "../..");
const configuration = resolve(root, ".env.test");
if (existsSync(configuration)) process.loadEnvFile(configuration);

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Integration prerequisite ${name} is missing; prepare isolated .env.test services.`,
    );
  return value;
}

export function testPools(): {
  owner: Pool;
  app: Pool;
  ddl: Pool;
  identity: Pool;
} {
  return {
    owner: createPool(required("ROOTSET_TEST_DATABASE_URL"), 4),
    app: createPool(required("ROOTSET_TEST_APP_DATABASE_URL"), 10),
    ddl: createPool(required("ROOTSET_TEST_DDL_DATABASE_URL"), 4),
    identity: createPool(required("ROOTSET_TEST_IDENTITY_DATABASE_URL"), 4),
  };
}

export async function assertPreparedDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ version: string; prepared: string | null }>(
    "SELECT current_setting('server_version') AS version, to_regclass('rootset_control.tables')::text AS prepared",
  );
  if (!result.rows[0]?.version.startsWith("18."))
    throw new Error("Integration suite requires actual PostgreSQL 18.");
  if (!result.rows[0]?.prepared)
    throw new Error(
      "Control migrations are not ready. Apply finalized migrations before this suite.",
    );
}

export async function closePools(
  pools: ReturnType<typeof testPools>,
): Promise<void> {
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
}

export function fixtureSecret(name: string): string {
  return required(name);
}
