import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertMigrationLedger,
  candidateMigrationInventory,
} from "./migration-inventory.mjs";

export async function verifyReleasedUpgrade({ root, compose, inputSQL }) {
  const baseline = await readFile(
    resolve(root, "packages/database/migrations/0001_baseline.sql"),
    "utf8",
  );
  const previous = baseline.slice(
    0,
    baseline.indexOf(
      "\nALTER TABLE rootset_control.tables ADD CONSTRAINT tables_org_id_id_key UNIQUE",
    ),
  );
  const digest = createHash("sha256").update(previous).digest("hex");
  assert.equal(
    digest,
    "4eb1bef6adf616d0c93b2165d39cd44655bb2640a29d4033e812cca11dcf8139",
  );
  const roleMigration = await readFile(
    resolve(root, "packages/database/migrations/0002_mcp_role_revocation.sql"),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(roleMigration).digest("hex"),
    "381775803fc348664371f2b5209a0b734530b63f69905af4b3ba3355d3ae9932",
  );
  const database = "rootset_release_upgrade";
  compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE DATABASE ${database} OWNER rootset`,
  );
  const query = (sql) => JSON.parse(inputSQL(database, sql));
  inputSQL(
    database,
    `BEGIN;
${previous}
CREATE TABLE rootset_control.migrations(name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO rootset_control.migrations(name,digest) VALUES ('0001_baseline.sql','${digest}');
${roleMigration}
INSERT INTO rootset_control.migrations(name,digest) VALUES ('0002_mcp_role_revocation.sql','381775803fc348664371f2b5209a0b734530b63f69905af4b3ba3355d3ae9932');
INSERT INTO rootset_control.organisations(id,name) VALUES('00000000000000000000000001','Existing workspace');
INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES('00000000000000000000000002','Existing user','existing@example.test',true);
INSERT INTO rootset_control.auth_accounts(id,user_id,account_id,provider_id,password) VALUES('00000000000000000000000003','00000000000000000000000002','00000000000000000000000002','credential','fixture-preserved-password');
CREATE SCHEMA rsd_upgrade_proof;
CREATE TABLE rsd_upgrade_proof.rows(id integer PRIMARY KEY, data jsonb NOT NULL);
INSERT INTO rsd_upgrade_proof.rows SELECT n, jsonb_build_object('value',n,'unicode','தமிழ் ✈️') FROM generate_series(1,100) n;
COMMIT;`,
  );
  const preserved = () =>
    query(
      "SELECT json_build_object('users',(SELECT json_agg(u ORDER BY id) FROM rootset_control.users u),'accounts',(SELECT json_agg(a ORDER BY id) FROM rootset_control.auth_accounts a),'organisations',(SELECT json_agg(o ORDER BY id) FROM rootset_control.organisations o),'rows',(SELECT json_agg(r ORDER BY id) FROM rsd_upgrade_proof.rows r))",
    );
  const ledger = () =>
    query(
      "SELECT json_agg(json_build_object('name',name,'digest',digest) ORDER BY name) FROM rootset_control.migrations",
    );
  const original = preserved();
  const originalLedger = query(
    "SELECT jsonb_agg(to_jsonb(m) ORDER BY name) FROM rootset_control.migrations m",
  );
  const inventory = await candidateMigrationInventory(root);
  for (const service of ["api", "worker", "api"]) {
    compose(
      "exec",
      "-T",
      service,
      "node",
      "--input-type=module",
      "-e",
      `const url=new URL(process.env.ROOTSET_DATABASE_URL);url.pathname='/${database}';process.env.ROOTSET_DATABASE_URL=url.toString();await import('./dist/migrate.mjs');`,
    );
    assert.deepEqual(preserved(), original);
    assertMigrationLedger(ledger(), inventory);
  }
  assert.deepEqual(
    query(
      "SELECT previous_migrations FROM rootset_control.migration_repairs WHERE name='v0.1.4-row-comments'",
    ),
    originalLedger,
  );
  assert.deepEqual(
    query(
      "SELECT json_build_object('rls',relrowsecurity,'forced',relforcerowsecurity,'deletionLog',EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='rootset_control.row_comments'::regclass AND attname='deleted_at')) FROM pg_class WHERE oid='rootset_control.row_comments'::regclass",
    ),
    { rls: true, forced: true, deletionLog: true },
  );
  return {
    sourceVersions: ["0.1.2", "0.1.3"],
    baselineSha256: digest,
    preservedRows: 100,
    apiAndWorkerMigrations: true,
    repeatable: true,
    originalLedgerPreserved: true,
  };
}
