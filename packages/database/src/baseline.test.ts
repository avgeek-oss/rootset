import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dateFormatOptions,
  timeFormatOptions,
} from "../../contracts/src/date-time-preferences";
import {
  Pool,
  createPool,
  migrate,
  migrationStatus,
  withOrg,
} from "./index.js";

const source = process.env.ROOTSET_TEST_DATABASE_URL;
test(
  "V1-28 baseline upgrades are repeatable, enforce singleton and roles, and preserves incompatible prelaunch databases",
  { skip: !source },
  async (t) => {
    const url = new URL(source!);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    const name = `rootset_baseline_${randomBytes(8).toString("hex")}`;
    const admin = new Pool({ connectionString: url.toString(), max: 1 });
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
    const sql = await readFile(
      new URL("../migrations/0001_baseline.sql", import.meta.url),
      "utf8",
    );
    await writeFile(join(directory, "0001_baseline.sql"), sql);
    assert.deepEqual(await migrate(pool, directory), ["0001_baseline.sql"]);
    assert.deepEqual(await migrationStatus(pool), {
      complete: false,
      version: "0001_baseline.sql",
    });
    await pool.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES('00000000000000000000000001','Rootset')",
    );
    await withOrg(pool, "00000000000000000000000001", async (client) => {
      await client.query(
        "INSERT INTO rootset_control.databases(id,org_id,name,schema_name) VALUES('00000000000000000000000010','00000000000000000000000001','Existing database','rsd_00000000000000000000000010')",
      );
      await client.query(
        "INSERT INTO rootset_control.tables(id,database_id,org_id,name,physical_name) VALUES('00000000000000000000000011','00000000000000000000000010','00000000000000000000000001','Existing table','rst_00000000000000000000000011')",
      );
      await client.query(
        "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_name_snapshot,actor,body) VALUES('00000000000000000000000012','00000000000000000000000001','00000000000000000000000011','00000000000000000000000013','Existing author','{}','Existing comment')",
      );
    });
    await withOrg(pool, "00000000000000000000000001", async (client) => {
      await client.query(
        "INSERT INTO rootset_control.unique_rules(id,table_id,org_id,name,field_ids,strategy,state) VALUES('00000000000000000000000021','00000000000000000000000011','00000000000000000000000001','Existing rule',ARRAY['00000000000000000000000022'],'registry','active')",
      );
      await client.query(
        "INSERT INTO rootset_control.unique_entries(rule_id,row_id,digest,tuple) VALUES('00000000000000000000000021','00000000000000000000000013','original-digest','original-tuple')",
      );
    });
    assert.deepEqual(await migrate(pool), [
      "0002_mcp_role_revocation.sql",
      "0003_comment_deletion_log.sql",
      "0004_field_constraints.sql",
      "0005_integer_auto_increment.sql",
      "0006_foreign_keys.sql",
      "0007_database_backups.sql",
      "0008_backup_schedule_lifecycle.sql",
      "0009_import_requests.sql",
      "0010_saved_views.sql",
    ]);
    await withOrg(pool, "00000000000000000000000001", async (client) => {
      assert.deepEqual(
        (
          await client.query(
            "SELECT body,deleted_at FROM rootset_control.row_comments",
          )
        ).rows,
        [{ body: "Existing comment", deleted_at: null }],
      );
    });
    await withOrg(pool, "00000000000000000000000001", async (client) => {
      assert.deepEqual(
        (
          await client.query(
            "SELECT name,state,strategy,condition FROM rootset_control.unique_rules",
          )
        ).rows,
        [
          {
            name: "Existing rule",
            state: "active",
            strategy: "registry",
            condition: null,
          },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT digest,tuple FROM rootset_control.unique_entries",
          )
        ).rows,
        [{ digest: "original-digest", tuple: "original-tuple" }],
      );
    });
    for (const relation of ["indexes", "import_batches", "import_rejections"])
      assert.equal(
        (
          await pool.query("SELECT to_regclass($1) AS relation", [
            `rootset_control.${relation}`,
          ])
        ).rows[0].relation,
        null,
      );
    assert.deepEqual(await migrate(pool), []);
    assert.deepEqual(await migrationStatus(pool), {
      complete: true,
      version: "0010_saved_views.sql",
    });
    const names = await pool.query(
      "SELECT table_name,character_maximum_length FROM information_schema.columns WHERE table_schema='rootset_control' AND column_name='name' AND table_name IN ('users','organisations','api_keys','auth_passkeys') ORDER BY table_name",
    );
    assert.equal(names.rowCount, 4);
    assert.ok(names.rows.every((row) => row.character_maximum_length === 120));
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
    await pool.query(
      "INSERT INTO rootset_control.user_preferences(user_id) VALUES('00000000000000000000000003')",
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT date_format,time_format,timezone FROM rootset_control.user_preferences",
        )
      ).rows[0],
      {
        date_format: "day-short-month-year",
        time_format: "24-hour",
        timezone: "UTC",
      },
    );
    for (const date of dateFormatOptions)
      for (const time of timeFormatOptions)
        await pool.query(
          "UPDATE rootset_control.user_preferences SET date_format=$1,time_format=$2",
          [date.id, time.id],
        );
    const previousPreferences = (
      await pool.query("SELECT * FROM rootset_control.user_preferences")
    ).rows[0];
    for (const value of ["YYYY-MM-DD", "constructor", "unknown"])
      await assert.rejects(
        pool.query(
          "UPDATE rootset_control.user_preferences SET date_format=$1",
          [value],
        ),
        { code: "23514" },
      );
    for (const value of ["24h", "12h", "unknown"])
      await assert.rejects(
        pool.query(
          "UPDATE rootset_control.user_preferences SET time_format=$1",
          [value],
        ),
        { code: "23514" },
      );
    assert.deepEqual(
      (await pool.query("SELECT * FROM rootset_control.user_preferences"))
        .rows[0],
      previousPreferences,
    );
    for (const table of ["users", "organisations"] as const) {
      const previous = (
        await pool.query(`SELECT name FROM rootset_control.${table}`)
      ).rows[0].name;
      await pool.query(`UPDATE rootset_control.${table} SET name=$1`, [
        "N".repeat(120),
      ]);
      await assert.rejects(
        pool.query(`UPDATE rootset_control.${table} SET name=$1`, [
          "N".repeat(121),
        ]),
        { code: "22001" },
      );
      assert.equal(
        (await pool.query(`SELECT name FROM rootset_control.${table}`)).rows[0]
          .name,
        "N".repeat(120),
      );
      await pool.query(`UPDATE rootset_control.${table} SET name=$1`, [
        previous,
      ]);
    }
    await assert.rejects(
      pool.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES('00000000000000000000000004','00000000000000000000000001','00000000000000000000000003','owner')",
      ),
      { code: "23514" },
    );
    await pool.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES('00000000000000000000000004','00000000000000000000000001','00000000000000000000000003','admin')",
    );
    await assert.rejects(
      pool.query("UPDATE rootset_control.memberships SET role='editor'"),
      { code: "23514" },
    );
    await pool.query("UPDATE rootset_control.memberships SET role='member'");
    assert.equal(
      (await pool.query("SELECT role FROM rootset_control.memberships")).rows[0]
        .role,
      "member",
    );
    await pool.query("UPDATE rootset_control.memberships SET role='admin'");
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege(current_user,'rootset_control.migrations','SELECT') allowed",
        )
      ).rows[0].allowed,
      true,
    );
    const absent = await pool.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='rootset_control' AND ((table_name='organisations' AND column_name IN('description','state','quota_bytes')) OR (table_name='memberships' AND column_name IN('state','restricted')) OR (table_name='api_keys' AND column_name IN('owner_kind','scopes','targets','unrestricted')) OR (table_name='users' AND column_name='disabled') OR (table_name='fields' AND column_name IN('api_key','label')))",
    );
    assert.equal(absent.rowCount, 0);
    const removed = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='rootset_control' AND tablename IN('resource_grants','operator_bindings','account_audit','capacity_organisation_quotas','capacity_policy','capacity_reports','capacity_reservations','installation_settings','installation_settings_audit','backup_policies','backup_occurrences','backups','restore_provenance','restore_publications','restore_write_barriers','notification_events','notification_receipts')",
    );
    assert.equal(removed.rowCount, 0);

    await writeFile(
      join(directory, "0001_baseline.sql"),
      `${sql}\n-- edited before release\n`,
    );
    for (const name of [
      "0002_mcp_role_revocation.sql",
      "0003_comment_deletion_log.sql",
      "0004_field_constraints.sql",
      "0005_integer_auto_increment.sql",
      "0006_foreign_keys.sql",
      "0007_database_backups.sql",
      "0008_backup_schedule_lifecycle.sql",
      "0009_import_requests.sql",
      "0010_saved_views.sql",
    ])
      await writeFile(
        join(directory, name),
        await readFile(new URL(`../migrations/${name}`, import.meta.url)),
      );
    await assert.rejects(migrate(pool, directory), /changed after application/);
    await pool.query(
      "UPDATE rootset_control.migrations SET name='001_identity.sql' WHERE name='0001_baseline.sql'",
    );
    await assert.rejects(migrate(pool), /earlier prelaunch schema/);
    assert.equal(
      (await pool.query("SELECT name FROM rootset_control.organisations"))
        .rows[0].name,
      "Rootset",
    );
  },
);
