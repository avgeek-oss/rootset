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
export async function isolatedDatabase(): Promise<IsolatedDatabase> {
  const source = new URL(fixtureSecret("ROOTSET_TEST_DATABASE_URL"));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname))
    throw new Error(
      "Disposable verification database creation requires a loopback PostgreSQL test service.",
    );
  const name = `rootset_verify_${newId().toLowerCase()}`;
  const admin = createPool(source.toString(), 1);
  // CREATE/DROP DATABASE can wait for the physical-backup checkpoint. This
  // affects only disposable-fixture administration, never application queries.
  await admin.query("SET statement_timeout='60s'");
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const target = (variable: string): string => {
    const url = new URL(fixtureSecret(variable));
    url.pathname = `/${name}`;
    return url.toString();
  };
  const owner = createPool(target("ROOTSET_TEST_DATABASE_URL"), 4),
    app = createPool(target("ROOTSET_TEST_APP_DATABASE_URL"), 4),
    ddl = createPool(target("ROOTSET_TEST_DDL_DATABASE_URL"), 4),
    identity = createPool(target("ROOTSET_TEST_IDENTITY_DATABASE_URL"), 4);
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
      appliedMigrations: await migrate(owner),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
