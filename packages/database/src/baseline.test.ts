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
    const names = await pool.query(
      "SELECT table_name,character_maximum_length FROM information_schema.columns WHERE table_schema='rootset_control' AND column_name='name' AND table_name IN ('users','organisations','api_keys','auth_passkeys') ORDER BY table_name",
    );
    assert.equal(names.rowCount, 4);
    assert.ok(names.rows.every((row) => row.character_maximum_length === 120));
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
