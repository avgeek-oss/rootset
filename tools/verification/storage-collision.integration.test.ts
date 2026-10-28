import assert from "node:assert/strict";
import { newId, type Actor } from "@rootset/contracts";
import { migrate } from "@rootset/database";
import { TableStorage } from "../../packages/table-storage/src/index.js";
import { fixtureSecret } from "./environment.js";
import { isolatedDatabase } from "./isolated-database.js";
import { verificationCase } from "./evidence.js";

verificationCase(
  {
    id: "STORAGE-COLLISION-01",
    gates: ["V1-01", "V1-18", "V1-38"],
    scope:
      "Fresh real PostgreSQL database migrates once; forced constant digest permits distinct wide tuples and serializes genuine concurrent duplicates with exact comparison",
  },
  async () => {
    const fixture = await isolatedDatabase();
    try {
      assert.deepEqual(fixture.appliedMigrations, [
        "0001_baseline.sql",
        "0002_mcp_role_revocation.sql",
        "0003_comment_deletion_log.sql",
        "0004_field_constraints.sql",
        "0005_integer_auto_increment.sql",
        "0006_foreign_keys.sql",
        "0007_database_backups.sql",
        "0008_backup_schedule_lifecycle.sql",
        "0009_import_requests.sql",
        "0010_saved_views.sql",
        "0011_database_restores.sql",
        "0012_backup_retention_alerts.sql",
        "0013_activity_job_events.sql",
        "0014_resource_data_changes.sql",
        "0015_workspaces.sql",
        "0016_assistant.sql",
      ]);
      assert.deepEqual(await migrate(fixture.owner), []);
      const orgId = newId();
      const actor: Actor = {
        kind: "session",
        id: `collision-fixture:${newId()}`,
        orgId,
        role: "admin",
        userId: newId(),
        scopes: [],
      };
      await fixture.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
        [orgId, "Collision fixture"],
      );
      const storage = new TableStorage({
        pool: fixture.app,
        ddlPool: fixture.ddl,
        cursorSecret: fixtureSecret("ROOTSET_SECRET"),
      });
      const database = await storage.createDatabase(actor, {
        name: "Forced digest collision",
      });
      const table = await storage.createTable(actor, database.id, {
        name: "Wide tuples",
        fields: [
          { name: "A", type: "text", charLimit: 20000 },
          { name: "B", type: "text", charLimit: 20000 },
        ],
      });
      await fixture.owner.query(
        "CREATE OR REPLACE FUNCTION rootset_control.unique_digest(tuple_arg text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT 'forced-collision' $$",
      );
      const rule = await storage.createUniqueRule(actor, table.id, {
        fieldIds: table.fields.map((field) => field.id),
        expectedSchemaVersion: 1,
        idempotencyKey: newId(),
      });
      assert.equal(rule.strategy, "registry");
      const a = await storage.createRow(actor, table.id, {
        A: "a".repeat(10000),
        B: "one",
      });
      const b = await storage.createRow(actor, table.id, {
        A: "b".repeat(10000),
        B: "two",
      });
      assert.notEqual(a.id, b.id);
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          storage.createRow(actor, table.id, {
            A: "c".repeat(10000),
            B: "three",
          }),
        ),
      );
      assert.equal(
        attempts.filter((attempt) => attempt.status === "fulfilled").length,
        1,
      );
      assert.equal(
        attempts.filter(
          (attempt) =>
            attempt.status === "rejected" &&
            attempt.reason.code === "UNIQUE_CONFLICT",
        ).length,
        4,
      );
      const changed = await storage.updateRow(
        actor,
        table.id,
        a.id,
        { B: "changed" },
        { expectedVersion: a.version },
      );
      await storage.createRow(actor, table.id, {
        A: "a".repeat(10000),
        B: "one",
      });
      await storage.deleteRow(actor, table.id, changed.id, {
        expectedVersion: changed.version,
      });
      const buckets = await fixture.owner.query(
        "SELECT digest,count(*)::int AS count FROM rootset_control.unique_entries WHERE rule_id=$1 GROUP BY digest",
        [rule.id],
      );
      assert.deepEqual(buckets.rows, [
        { digest: "forced-collision", count: 3 },
      ]);
      assert.equal((await storage.getTable(actor, table.id)).rowCount, 3);
      const conditional = await storage.createTable(actor, database.id, {
        name: "Conditional collision",
        fields: [
          { name: "CODE", type: "text", charLimit: 4000 },
          {
            name: "STATUS",
            type: "text",
            allowedValues: ["active", "ceased"],
            default: "ceased",
          },
        ],
      });
      const condition = {
        field: conditional.fields[1]!.id,
        op: "eq" as const,
        value: "active",
      };
      const conditionalRule = await storage.createUniqueRule(
        actor,
        conditional.id,
        {
          fieldIds: [conditional.fields[0]!.id],
          where: condition,
          expectedSchemaVersion: 1,
        },
      );
      const live = await storage.createRow(actor, conditional.id, {
        CODE: "same",
        STATUS: "active",
      });
      const historical = await storage.createRow(actor, conditional.id, {
        CODE: "same",
        STATUS: "ceased",
      });
      await storage.createRow(actor, conditional.id, {
        CODE: "same",
        STATUS: "ceased",
      });
      await storage.createRow(actor, conditional.id, {
        CODE: "different",
        STATUS: "active",
      });
      await assert.rejects(
        storage.updateRow(
          actor,
          conditional.id,
          historical.id,
          { STATUS: "active" },
          { expectedVersion: historical.version },
        ),
        { code: "UNIQUE_CONFLICT" },
      );
      await storage.updateRow(
        actor,
        conditional.id,
        live.id,
        { STATUS: "ceased" },
        { expectedVersion: live.version },
      );
      await storage.updateRow(
        actor,
        conditional.id,
        historical.id,
        { STATUS: "active" },
        { expectedVersion: historical.version },
      );
      const racing = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          storage.createRow(actor, conditional.id, {
            CODE: "raced",
            STATUS: "active",
          }),
        ),
      );
      assert.equal(
        racing.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        racing.filter(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "UNIQUE_CONFLICT",
        ).length,
        4,
      );
      assert.deepEqual(
        (
          await fixture.owner.query(
            "SELECT digest,count(*)::int AS count FROM rootset_control.unique_entries WHERE rule_id=$1 GROUP BY digest",
            [conditionalRule.id],
          )
        ).rows,
        [{ digest: "forced-collision", count: 3 }],
      );
    } finally {
      await fixture.close();
    }
  },
);
