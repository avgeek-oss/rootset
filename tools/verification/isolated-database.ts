import { createPool, migrate, type Pool } from "@rootset/database";
import { newId } from "@rootset/contracts";
import { fixtureSecret } from "./environment.js";

export interface IsolatedDatabase {
  name: string;
  owner: Pool;
  app: Pool;
  ddl: Pool;
  identity: Pool;
  appliedMigrations: string[];
  close(): Promise<void>;
}

/** Creates only a uniquely named local verification database, preserving the shared fixture database. */
export async function isolatedDatabase(
  options: { migrationDirectory?: string } = {},
): Promise<IsolatedDatabase> {
  const source = new URL(fixtureSecret("ROOTSET_TEST_DATABASE_URL"));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname))
    throw new Error(
      "Disposable verification database creation requires a loopback PostgreSQL test service.",
    );
  const name = `rootset_verify_${newId().toLowerCase()}`;
  const target = new URL(source);
  target.pathname = `/${name}`;
  const admin = createPool(source.toString(), 1);
  try {
    await admin.query("SET statement_timeout='60s'");
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const owner = createPool(target.toString(), 4),
    app = createPool(target.toString(), 4),
    ddl = createPool(target.toString(), 4),
    identity = createPool(target.toString(), 4);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all([owner, app, ddl, identity].map((pool) => pool.end()));
    try {
      await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  };
  try {
    return {
      name,
      owner,
      app,
      ddl,
      identity,
      appliedMigrations: await migrate(owner, options.migrationDirectory),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
