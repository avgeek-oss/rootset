import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { newId, type Actor } from "@rootset/contracts";
import {
  createPool,
  migrate,
  migrationStatus,
  withOrg,
  type Pool,
} from "@rootset/database";
import { TableStorage } from "../../packages/table-storage/src/index.js";
import { fixtureSecret } from "./environment.js";

const migrationDirectory = new URL(
  "../../packages/database/migrations/",
  import.meta.url,
);
const bridge = await readFile(
  new URL("../../packages/database/upgrades/v0.1.4.sql", import.meta.url),
  "utf8",
);
const baseline = await readFile(
  new URL("0001_baseline.sql", migrationDirectory),
  "utf8",
);
const previousBaseline = baseline.slice(
  0,
  baseline.indexOf(
    "\nALTER TABLE rootset_control.tables ADD CONSTRAINT tables_org_id_id_key UNIQUE",
  ),
);
const sha256 = (source: string) =>
  createHash("sha256").update(source).digest("hex");

test("the upgrade bridge matches the exact released v0.1.2/v0.1.3 and v0.1.4 SQL", async () => {
  assert.equal(
    sha256(previousBaseline),
    "4eb1bef6adf616d0c93b2165d39cd44655bb2640a29d4033e812cca11dcf8139",
  );
  for (const [name, digest] of Object.entries({
    "0001_baseline.sql":
      "fffd4634da07c05545d925ea7e7e940257a2da180aa552a52243b95475015ebe",
    "0002_mcp_role_revocation.sql":
      "381775803fc348664371f2b5209a0b734530b63f69905af4b3ba3355d3ae9932",
    "0003_comment_deletion_log.sql":
      "5eecc1162012ca9a8cc4c1933a7047832190c567392a50c6575db80956620b99",
  })) {
    const sql = await readFile(new URL(name, migrationDirectory), "utf8");
    assert.equal(
      sha256(sql),
      digest,
      "Released migrations must remain unchanged; add a new migration instead",
    );
    assert.ok(bridge.includes(digest));
    if (name === "0003_comment_deletion_log.sql")
      assert.ok(bridge.includes(sql));
  }
  assert.ok(bridge.includes(baseline.slice(previousBaseline.length)));
});

async function fixture(t: TestContext) {
  const url = new URL(fixtureSecret("ROOTSET_TEST_DATABASE_URL"));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const name = `rootset_upgrade_${newId().toLowerCase()}`;
  const admin = createPool(url.toString(), 1);
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 4);
  const directory = await mkdtemp(
    join(tmpdir(), "rootset-released-migrations-"),
  );
  t.after(async () => {
    await pool.end();
    try {
      await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await writeFile(join(directory, "0001_baseline.sql"), previousBaseline);
  await writeFile(
    join(directory, "0002_mcp_role_revocation.sql"),
    await readFile(new URL("0002_mcp_role_revocation.sql", migrationDirectory)),
  );
  assert.deepEqual(await migrate(pool, directory), [
    "0001_baseline.sql",
    "0002_mcp_role_revocation.sql",
  ]);
  const actor: Actor = {
    id: newId(),
    orgId: newId(),
    kind: "operator",
    role: "admin",
    scopes: ["*"],
  };
  await pool.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Upgrade proof')",
    [actor.orgId],
  );
  const user = newId();
  await pool.query(
    "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Existing user','upgrade@example.test',true)",
    [user],
  );
  await pool.query(
    "INSERT INTO rootset_control.auth_accounts(id,user_id,account_id,provider_id,password) VALUES($1,$2,$3,'credential','fixture-password-hash-preserved')",
    [newId(), user, user],
  );
  await pool.query(
    "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at) VALUES($1,$2,'fixture-session-token-preserved',now()+interval '1 day')",
    [newId(), user],
  );
  await pool.query(
    "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')",
    [newId(), actor.orgId, user],
  );
  await withOrg(pool, actor.orgId, (client) =>
    client.query(
      "INSERT INTO rootset_control.api_keys(id,org_id,user_id,scope,access,include_admin,name,secret_hash,prefix) VALUES($1,$2,$3,'personal','edit',false,'Existing key','fixture-key-hash-preserved','fixture')",
      [newId(), actor.orgId, user],
    ),
  );
  const storage = new TableStorage({
    pool,
    ddlPool: pool,
    cursorSecret: "upgrade-fixture-secret-at-least-thirty-two-characters",
  });
  const database = await storage.createDatabase(actor, {
    name: "Existing database",
  });
  const table = await storage.createTable(actor, database.id, {
    name: "Existing table",
    fields: [{ name: "payload", type: "json" }],
  });
  const rows = await storage.mutateRows(actor, table.id, {
    idempotencyKey: "upgrade-fixture",
    operations: Array.from({ length: 100 }, (_, i) => ({
      kind: "create" as const,
      values: {
        payload: { i, unicode: "தமிழ் ✈️", nested: [null, true, 12.5] },
      },
    })),
  });
  return { pool, actor, storage, table, rows: rows.rows };
}

async function snapshot(pool: Pool, orgId: string, tables?: string[]) {
  return withOrg(pool, orgId, async (client) => {
    tables ??= (
      await client.query<{ relation: string }>(
        "SELECT quote_ident(schemaname)||'.'||quote_ident(tablename) AS relation FROM pg_tables WHERE schemaname='rootset_control' OR schemaname LIKE 'rsd_%' ORDER BY 1",
      )
    ).rows.map((row) => row.relation);
    const rows: Record<string, unknown> = {};
    for (const relation of tables)
      rows[relation] = (
        await client.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) AS rows FROM ${relation} r`,
        )
      ).rows[0].rows;
    return { tables, rows };
  });
}

async function runBridge(pool: Pool, sql = bridge) {
  const client = await pool.connect();
  try {
    await client.query(sql);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

for (const mode of ["SQL bridge", "migration runner"])
  test(`${mode}: v0.1.2/v0.1.3 upgrade preserves all existing rows, identity, credentials, metadata and history`, async (t) => {
    const { pool, actor, storage, table, rows } = await fixture(t);
    assert.equal((await migrationStatus(pool)).complete, false);
    const before = await snapshot(pool, actor.orgId);
    if (mode === "SQL bridge") {
      await runBridge(pool);
      assert.deepEqual(await migrate(pool), [
        "0004_field_constraints.sql",
        "0005_integer_auto_increment.sql",
        "0006_foreign_keys.sql",
        "0007_database_backups.sql",
        "0008_backup_schedule_lifecycle.sql",
      ]);
    } else
      assert.deepEqual(await migrate(pool), [
        "0001_baseline.sql",
        "0003_comment_deletion_log.sql",
        "0004_field_constraints.sql",
        "0005_integer_auto_increment.sql",
        "0006_foreign_keys.sql",
        "0007_database_backups.sql",
        "0008_backup_schedule_lifecycle.sql",
      ]);
    const preservedTables = before.tables.filter(
      (name) => name !== "rootset_control.migrations",
    );
    const after = await snapshot(pool, actor.orgId, preservedTables);
    for (const name of preservedTables)
      assert.deepEqual(after.rows[name], before.rows[name], name);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT previous_migrations FROM rootset_control.migration_repairs",
        )
      ).rows[0].previous_migrations,
      before.rows["rootset_control.migrations"],
    );
    assert.deepEqual(await migrationStatus(pool), {
      complete: true,
      version: "0008_backup_schedule_lifecycle.sql",
    });
    assert.deepEqual(await migrate(pool), []);
    for (const row of rows) {
      const actual = await storage.getRow(actor, table.id, row.id);
      assert.deepEqual(actual.values, row.values);
      assert.equal(actual.hasComments, false);
    }
    const comment = newId();
    await withOrg(pool, actor.orgId, (client) =>
      client.query(
        "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_name_snapshot,actor,body) VALUES($1,$2,$3,$4,'Author','{}','First comment after upgrade')",
        [comment, actor.orgId, table.id, rows[0]!.id],
      ),
    );
    assert.equal(
      (await storage.getRow(actor, table.id, rows[0]!.id)).hasComments,
      true,
    );
    assert.equal(
      (
        await withOrg(pool, newId(), (client) =>
          client.query("SELECT * FROM rootset_control.row_comments"),
        )
      ).rowCount,
      0,
      "Comment RLS must remain enabled",
    );
    await withOrg(pool, actor.orgId, (client) =>
      client.query(
        "UPDATE rootset_control.row_comments SET body='',deleted_at=clock_timestamp() WHERE id=$1",
        [comment],
      ),
    );
    assert.equal(
      (
        await withOrg(pool, actor.orgId, (client) =>
          client.query(
            "UPDATE rootset_control.row_comments SET body='Restored',deleted_at=NULL WHERE id=$1",
            [comment],
          ),
        )
      ).rowCount,
      0,
    );
    const upgraded = await snapshot(pool, actor.orgId);
    await Promise.all([
      assert.rejects(runBridge(pool), /unmodified Rootset/),
      assert.rejects(runBridge(pool), /unmodified Rootset/),
    ]);
    assert.deepEqual(await migrate(pool), []);
    assert.deepEqual(
      await snapshot(pool, actor.orgId),
      upgraded,
      "The retired bridge must refuse a newer ledger without changing data or comments",
    );
  });

test("unknown migration hashes and ledger entries leave the database untouched", async (t) => {
  const { pool, actor } = await fixture(t);
  await pool.query(
    "UPDATE rootset_control.migrations SET digest='unknown' WHERE name='0002_mcp_role_revocation.sql'",
  );
  const before = await snapshot(pool, actor.orgId);
  await assert.rejects(runBridge(pool), /unmodified Rootset/);
  await assert.rejects(migrate(pool), /changed after application/);
  assert.deepEqual(await snapshot(pool, actor.orgId), before);
  await pool.query(
    "UPDATE rootset_control.migrations SET digest='381775803fc348664371f2b5209a0b734530b63f69905af4b3ba3355d3ae9932' WHERE name='0002_mcp_role_revocation.sql'",
  );
  await pool.query(
    "INSERT INTO rootset_control.migrations(name,digest) VALUES('0000_unknown.sql','unknown')",
  );
  const unexpected = await snapshot(pool, actor.orgId);
  await assert.rejects(runBridge(pool), /unmodified Rootset/);
  await assert.rejects(migrate(pool), /earlier prelaunch schema/);
  assert.deepEqual(await snapshot(pool, actor.orgId), unexpected);
});

test("concurrent migration hooks apply the compatibility upgrade only once", async (t) => {
  const { pool, actor } = await fixture(t);
  const before = await snapshot(pool, actor.orgId);
  const results = await Promise.all([migrate(pool), migrate(pool)]);
  assert.deepEqual(results.map((names) => names.length).sort(), [0, 7]);
  assert.equal(
    (await pool.query("SELECT count(*) FROM rootset_control.migration_repairs"))
      .rows[0].count,
    "1",
  );
  const tables = before.tables.filter(
    (name) => name !== "rootset_control.migrations",
  );
  const after = await snapshot(pool, actor.orgId, tables);
  for (const name of tables)
    assert.deepEqual(after.rows[name], before.rows[name]);
  assert.equal((await migrationStatus(pool)).complete, true);
});

test("a conflicting comments table is preserved and blocks reconciliation", async (t) => {
  const { pool, actor } = await fixture(t);
  await pool.query(
    "CREATE TABLE rootset_control.row_comments(body text); INSERT INTO rootset_control.row_comments VALUES('Preserve this unexpected data')",
  );
  const before = await snapshot(pool, actor.orgId);
  await assert.rejects(migrate(pool), /Comments schema conflicts/);
  assert.deepEqual(await snapshot(pool, actor.orgId), before);
});

test("a failure after schema creation rolls back all DDL, data and ledger changes", async (t) => {
  const { pool, actor } = await fixture(t);
  await pool.query(
    "CREATE FUNCTION rootset_control.protect_comment_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
  );
  const before = await snapshot(pool, actor.orgId);
  await assert.rejects(runBridge(pool), /already exists/);
  await assert.rejects(migrate(pool), /already exists/);
  assert.deepEqual(await snapshot(pool, actor.orgId), before);
  assert.equal(
    (
      await pool.query(
        "SELECT to_regclass('rootset_control.row_comments') AS comments, to_regclass('rootset_control.migration_repairs') AS repairs",
      )
    ).rows[0].comments,
    null,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM pg_constraint WHERE conname='tables_org_id_id_key'",
      )
    ).rows[0].count,
    "0",
  );
  await pool.query("DROP FUNCTION rootset_control.protect_comment_log()");
  await runBridge(pool);
  assert.deepEqual(await migrate(pool), [
    "0004_field_constraints.sql",
    "0005_integer_auto_increment.sql",
    "0006_foreign_keys.sql",
    "0007_database_backups.sql",
    "0008_backup_schedule_lifecycle.sql",
  ]);
  assert.equal((await migrationStatus(pool)).complete, true);
});
