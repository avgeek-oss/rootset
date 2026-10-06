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
  const target = (variable: string): string => {
    const url = new URL(fixtureSecret(variable));
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.port !== source.port
    )
      throw new Error(
        "All verification role URLs must use the same loopback PostgreSQL port.",
      );
    url.pathname = `/${name}`;
    return url.toString();
  };
  const urls = {
    owner: target("ROOTSET_TEST_DATABASE_URL"),
    app: target("ROOTSET_TEST_APP_DATABASE_URL"),
    ddl: target("ROOTSET_TEST_DDL_DATABASE_URL"),
    identity: target("ROOTSET_TEST_IDENTITY_DATABASE_URL"),
  };
  const admin = createPool(source.toString(), 1);
  try {
    await admin.query("SET statement_timeout='60s'");
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const owner = createPool(urls.owner, 4),
    app = createPool(urls.app, 4),
    ddl = createPool(urls.ddl, 4),
    identity = createPool(urls.identity, 4);
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
