import assert from "node:assert/strict";
import { before, after } from "node:test";
import { newId, type Actor } from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import { TableStorage } from "../../packages/table-storage/src/index.js";
import { OperationalObserver } from "../../packages/observability/src/index.js";
import { isolatedDatabase } from "./isolated-database.js";
import { verificationCase } from "./evidence.js";
let db: Awaited<ReturnType<typeof isolatedDatabase>>;
const actor: Actor = {
  kind: "session",
  id: newId(),
  userId: newId(),
  orgId: newId(),
  role: "admin",
  scopes: [],
};
before(async () => {
  db = await isolatedDatabase();
  await db.owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Single-connection fixture')",
    [actor.orgId],
  );
});
after(async () => {
  await db?.close();
});
verificationCase(
  {
    id: "OWNERSHIP-01",
    gates: ["V1-01", "V1-38"],
    scope:
      "One ordinary database owner migrates and runs Rootset without additional database roles",
  },
  async () => {
    assert.deepEqual(db.appliedMigrations, [
      "0001_baseline.sql",
      "0002_mcp_role_revocation.sql",
      "0003_comment_deletion_log.sql",
      "0004_field_constraints.sql",
    ]);
    const role = (
      await db.app.query(
        "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    for (const pool of [db.owner, db.app, db.ddl, db.identity])
      assert.equal(
        (await pool.query("SELECT current_user")).rows[0].current_user,
        role.current_user,
      );
    await assert.rejects(
      db.app.query("CREATE ROLE rootset_forbidden_super SUPERUSER"),
    );
    await assert.rejects(db.app.query("COPY (SELECT 1) TO PROGRAM 'true'"));
  },
);
verificationCase(
  {
    id: "OWNERSHIP-02",
    gates: ["V1-10", "V1-20", "V1-38"],
    scope:
      "Single-connection native storage preserves typed edits, history, and explicit organisation isolation",
  },
  async () => {
    const storage = new TableStorage({
      pool: db.app,
      ddlPool: db.ddl,
      cursorSecret: "fixture-cursor-secret-longer-than-thirty-two-bytes",
    });
    const database = await storage.createDatabase(actor, {
      name: "One URL",
      idempotencyKey: newId(),
    });
    const table = await storage.createTable(actor, database.id, {
      name: "Rows",
      fields: [{ name: "CODE", type: "text", charLimit: 64 }],
      idempotencyKey: newId(),
    });
    const row = await storage.createRow(actor, table.id, { CODE: "001" });
    assert.equal(
      (await storage.getRow(actor, table.id, row.id)).values.CODE,
      "001",
    );
    const path = `"${table.schemaName}"."${table.physicalName}"`;
    await withOrg(db.app, newId(), async (connection) => {
      assert.equal(
        (await connection.query(`SELECT * FROM ${path}`)).rowCount,
        0,
      );
      assert.equal(
        (await connection.query(`UPDATE ${path} SET row_version=row_version+1`))
          .rowCount,
        0,
      );
    });
    assert.equal((await storage.getRow(actor, table.id, row.id)).version, "1");
    await assert.rejects(
      storage.getRow({ ...actor, orgId: newId() }, table.id, row.id),
    );
    const metrics = await new OperationalObserver({
      operatorPool: db.app,
      pools: { api: db.app },
    }).metrics();
    assert.ok(metrics.database);
    assert.equal(metrics.database.walDirectoryBytes, null);
  },
);
