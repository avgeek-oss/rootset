import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPool, migrate, migrationStatus } from "./index.js";

const source = process.env.ROOTSET_TEST_DATABASE_URL;
test(
  "fresh baseline is repeatable, enforces singleton and roles, and preserves incompatible prelaunch databases",
  { skip: !source },
  async (t) => {
    const url = new URL(source!);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    const name = `rootset_baseline_${randomBytes(8).toString("hex")}`;
    const admin = createPool(url.toString(), 1);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    url.pathname = `/${name}`;
    const pool = createPool(url.toString(), 1);
    const directory = await mkdtemp(join(tmpdir(), "rootset-baseline-"));
    t.after(async () => {
      await pool.end();
      try {
        await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
      await rm(directory, { recursive: true, force: true });
    });
    assert.deepEqual(await migrate(pool), ["0001_baseline.sql"]);
    assert.deepEqual(await migrate(pool), []);
    assert.deepEqual(await migrationStatus(pool), {
      complete: true,
      version: "0001_baseline.sql",
    });
    await pool.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES('00000000000000000000000001','Rootset')",
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES('00000000000000000000000002','Second')",
      ),
      { code: "23505" },
    );
    await assert.rejects(
      pool.query("UPDATE rootset_control.organisations SET singleton=false"),
      { code: "23514" },
    );
    await pool.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES('00000000000000000000000003','Admin','admin@example.test',true)",
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES('00000000000000000000000004','00000000000000000000000001','00000000000000000000000003','owner')",
      ),
      { code: "23514" },
    );
    await pool.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES('00000000000000000000000004','00000000000000000000000001','00000000000000000000000003','admin')",
    );
    const absent = await pool.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='rootset_control' AND ((table_name='organisations' AND column_name IN('description','state','quota_bytes')) OR (table_name='memberships' AND column_name IN('state','restricted')) OR (table_name='api_keys' AND column_name IN('owner_kind','scopes','targets','unrestricted')) OR (table_name='users' AND column_name='disabled') OR (table_name='fields' AND column_name IN('api_key','label')))",
    );
    assert.equal(absent.rowCount, 0);
    const removed = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='rootset_control' AND tablename IN('resource_grants','operator_bindings','account_audit','capacity_organisation_quotas','capacity_policy','capacity_reports','capacity_reservations','installation_settings','installation_settings_audit','backup_policies','backup_occurrences')",
    );
    assert.equal(removed.rowCount, 0);
    const sql = await readFile(
      new URL("../migrations/0001_baseline.sql", import.meta.url),
      "utf8",
    );
    await writeFile(
      join(directory, "0001_baseline.sql"),
      `${sql}\n-- edited before release\n`,
    );
    await assert.rejects(migrate(pool, directory), /changed after application/);
    await pool.query(
      "UPDATE rootset_control.migrations SET name='001_identity.sql'",
    );
    await assert.rejects(migrate(pool), /earlier prelaunch schema/);
    assert.equal(
      (await pool.query("SELECT name FROM rootset_control.organisations"))
        .rows[0].name,
      "Rootset",
    );
  },
);
