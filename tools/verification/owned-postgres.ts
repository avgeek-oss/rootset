import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createPool, migrate } from "@rootset/database";
import { newId } from "@rootset/contracts";
import { fixtureSecret, root } from "./environment.js";

const run = promisify(execFile);

/** Separate cluster: ownership tests must not alter roles used by another fixture. */
export async function ownedPostgres() {
  const id = newId().toLowerCase();
  const name = `rootset-ownership-${id}`;
  const directory = join(root, "verification/runtime-ownership", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const migrationDirectory = join(directory, "migrations");
  await mkdir(migrationDirectory, { mode: 0o700 });
  const migrationNames = (
    await readdir(join(root, "packages/database/migrations"))
  )
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationNames)
    await copyFile(
      join(root, "packages/database/migrations", file),
      join(migrationDirectory, file),
    );
  const source = new URL(fixtureSecret("ROOTSET_TEST_DATABASE_URL"));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(source.hostname));
  const env = {
    ...process.env,
    POSTGRES_USER: "rootset_owner",
    POSTGRES_PASSWORD: decodeURIComponent(source.password),
    POSTGRES_DB: "rootset",
  };
  await run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--label",
      "rootset.disposable=runtime-ownership",
      "--label",
      `rootset.verification-run=${process.env.ROOTSET_VERIFICATION_RUN ?? `standalone-${id}`}`,
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB",
      "postgres:18-alpine",
    ],
    { env },
  );
  const mapped = (
    await run("docker", ["port", name, "5432/tcp"])
  ).stdout.trim();
  const port = /127\.0\.0\.1:(\d+)/.exec(mapped)?.[1];
  assert.ok(port);
  const url = (variable: string) => {
    const value = new URL(fixtureSecret(variable));
    value.hostname = "127.0.0.1";
    value.port = port;
    value.pathname = "/rootset";
    return value.toString();
  };
  const owner = createPool(url("ROOTSET_TEST_DATABASE_URL"), 4);
  const app = createPool(url("ROOTSET_TEST_APP_DATABASE_URL"), 4);
  const ddl = createPool(url("ROOTSET_TEST_DDL_DATABASE_URL"), 4);
  const identity = createPool(url("ROOTSET_TEST_IDENTITY_DATABASE_URL"), 4);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([owner, app, ddl, identity].map((pool) => pool.end()));
    await run("docker", ["rm", "--force", name]);
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      try {
        await owner.query("SELECT 1");
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, "Owned PostgreSQL service did not become ready.");
    for (const [role, variable] of [
      ["rootset_app", "ROOTSET_TEST_APP_DATABASE_URL"],
      ["rootset_ddl", "ROOTSET_TEST_DDL_DATABASE_URL"],
      ["rootset_identity", "ROOTSET_TEST_IDENTITY_DATABASE_URL"],
    ] as const) {
      const password = decodeURIComponent(
        new URL(fixtureSecret(variable)).password,
      );
      const quoted = (
        await owner.query<{ value: string }>(
          "SELECT quote_literal($1) AS value",
          [password],
        )
      ).rows[0]!.value;
      await owner.query(
        `CREATE ROLE ${role} LOGIN PASSWORD ${quoted} NOSUPERUSER NOBYPASSRLS`,
      );
    }
    await owner.query("GRANT rootset_owner TO rootset_ddl");
    await owner.query("GRANT CREATE ON DATABASE rootset TO rootset_ddl");
    // Use an exact captured prefix to demonstrate and then remove the original
    // escalation path without mutating any other cluster's role memberships.
    const beforeDirectory = join(directory, "before-ownership");
    await mkdir(beforeDirectory, { mode: 0o700 });
    for (const file of migrationNames.filter((file) => file < "027_"))
      await copyFile(
        join(migrationDirectory, file),
        join(beforeDirectory, file),
      );
    await migrate(owner, beforeDirectory);
    const finalise = async () => {
      await owner.query("CREATE DATABASE rootset_peer");
      const peerUrl = new URL(url("ROOTSET_TEST_DATABASE_URL"));
      peerUrl.pathname = "/rootset_peer";
      const peerOwner = createPool(peerUrl.toString(), 2);
      try {
        await migrate(peerOwner, beforeDirectory);
        const results = await Promise.allSettled([
          migrate(owner, migrationDirectory),
          migrate(peerOwner, migrationDirectory),
        ]);
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
        return (results[0] as PromiseFulfilledResult<string[]>).value;
      } finally {
        await peerOwner.end();
      }
    };
    const reporterUpgrade = async () => {
      await owner.query("CREATE DATABASE rootset_reporter_upgrade");
      const value = new URL(url("ROOTSET_TEST_DATABASE_URL"));
      value.pathname = "/rootset_reporter_upgrade";
      const upgradeOwner = createPool(value.toString(), 2);
      const prefixDirectory = join(directory, "before-reporter");
      await mkdir(prefixDirectory, { mode: 0o700 });
      for (const file of migrationNames.filter((file) => file < "034_"))
        await copyFile(
          join(migrationDirectory, file),
          join(prefixDirectory, file),
        );
      try {
        await migrate(upgradeOwner, prefixDirectory);
        await upgradeOwner.query(
          "ALTER ROLE rootset_capacity_reporter SUPERUSER BYPASSRLS INHERIT; GRANT rootset_owner TO rootset_capacity_reporter; GRANT rootset_capacity_reporter TO rootset_app; GRANT SELECT ON rootset_control.api_keys TO rootset_capacity_reporter",
        );
        await migrate(upgradeOwner, migrationDirectory);
        const connection = await upgradeOwner.connect();
        try {
          await connection.query("BEGIN");
          await connection.query("SET LOCAL ROLE rootset_capacity_reporter");
          const paths = (
            await connection.query(
              "SELECT * FROM rootset_control.capacity_storage_paths()",
            )
          ).rows;
          const checkpoint = (
            await connection.query(
              "SELECT rootset_control.capacity_report_checkpoint() AS checkpoint",
            )
          ).rows[0]!.checkpoint;
          await connection.query(
            "SELECT rootset_control.report_storage_capacity($1::jsonb,$2::jsonb)",
            [
              JSON.stringify(
                paths.map((path) => ({
                  name: path.name,
                  availableBytes: "1",
                  totalBytes: "2",
                })),
              ),
              JSON.stringify(checkpoint),
            ],
          );
          await assert.rejects(
            connection.query(
              "SELECT secret_hash FROM rootset_control.api_keys",
            ),
            (error: unknown) =>
              !!error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "42501",
          );
          await connection.query("ROLLBACK");
          return {
            paths: paths.map((path) => path.name),
            checkpoint: typeof checkpoint.claimsBytes === "string",
          };
        } finally {
          await connection.query("ROLLBACK");
          connection.release();
        }
      } finally {
        await upgradeOwner.end();
      }
    };
    return {
      name,
      port: Number(port),
      directory,
      owner,
      app,
      ddl,
      identity,
      finalise,
      reporterUpgrade,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
