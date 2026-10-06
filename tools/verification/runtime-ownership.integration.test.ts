import assert from "node:assert/strict";
import { before, after } from "node:test";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { ErrorCodeSchema, newId, type Actor } from "@rootset/contracts";
import { EmailOutbox } from "../../packages/email/src/index.js";
import { TableStorage } from "../../packages/table-storage/src/index.js";
import {
  createPool,
  withOrg,
  type Pool,
  type PoolClient,
} from "@rootset/database";
import { OperationalObserver } from "../../packages/observability/src/index.js";
import { isolatedDatabase } from "./isolated-database.js";
import { verificationCase } from "./evidence.js";

let cluster: Awaited<ReturnType<typeof isolatedDatabase>>;
let storage: TableStorage;
let managedDatabaseId: string;
let managedTableId: string;
const orgId = newId(),
  peerOrgId = newId();
const actor: Actor = {
  kind: "session",
  id: newId(),
  userId: newId(),
  orgId,
  role: "admin",
  scopes: [],
};
before(async () => {
  cluster = await isolatedDatabase();
});
after(async () => {
  await cluster?.close();
});
async function denied(pool: Pool, sql: string, setup?: string) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    if (setup) await connection.query(setup);
    await assert.rejects(
      connection.query(sql),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "42501",
    );
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
}

verificationCase(
  {
    id: "OWNERSHIP-01",
    gates: ["V1-01", "V1-38"],
    scope:
      "Fresh baseline on an isolated PostgreSQL database rejects deployment/definer/system role escalation and protected function/table alterations",
  },
  async () => {
    assert.deepEqual(cluster.appliedMigrations, ["0001_baseline.sql"]);
    for (const role of [
      "rootset_owner",
      "rootset_identity_definer",
      "rootset_worker_definer",
      "rootset_metrics_definer",
      "pg_read_server_files",
      "pg_write_server_files",
      "pg_execute_server_program",
    ])
      await denied(cluster.ddl, `SET ROLE ${role}`);
    for (const role of [
      "rootset_managed_owner",
      "rootset_identity_definer",
      "rootset_metrics_definer",
    ])
      await denied(cluster.app, `SET ROLE ${role}`);
    for (const role of [
      "rootset_managed_owner",
      "rootset_identity_definer",
      "rootset_metrics_definer",
    ])
      await denied(cluster.identity, `SET ROLE ${role}`);
    await denied(cluster.ddl, "CREATE ROLE rootset_forbidden_super SUPERUSER");
    await denied(cluster.ddl, "COPY (SELECT 1) TO PROGRAM 'true'");
    await denied(
      cluster.ddl,
      "ALTER FUNCTION rootset_control.memberships_for_user(text) SET search_path=public",
    );
    await denied(
      cluster.ddl,
      "ALTER FUNCTION rootset_control.operator_metrics() SET search_path=public",
    );
    await denied(
      cluster.ddl,
      "ALTER TABLE rootset_control.api_keys ADD COLUMN forbidden boolean",
    );
    await denied(
      cluster.ddl,
      "CREATE FUNCTION rootset_control.forbidden() RETURNS text LANGUAGE sql AS 'SELECT current_user::text'",
    );
    await denied(cluster.app, "SELECT rootset_control.operator_metrics()");
    await denied(cluster.ddl, "SELECT rootset_control.operator_metrics()");
    await cluster.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
      [orgId, "Ownership fixture"],
    );
    storage = new TableStorage({
      pool: cluster.app,
      ddlPool: cluster.ddl,
      cursorSecret: "ownership-fixture-cursor-secret-0123456789",
    });
  },
);

verificationCase(
  {
    id: "OWNERSHIP-02",
    gates: ["V1-10", "V1-20", "V1-38"],
    scope:
      "Managed non-bypass native ownership preserves actual row/history writes and RLS outside the sole organisation; DDL cannot attach an escalating trigger to privileged identity write targets or read credential columns through a native view",
  },
  async () => {
    const database = await storage.createDatabase(actor, {
      name: "Managed storage",
      idempotencyKey: newId(),
    });
    const table = await storage.createTable(actor, database.id, {
      name: "Native table",
      fields: [{ name: "CODE", type: "text", charLimit: 64 }],
      idempotencyKey: newId(),
    });
    managedDatabaseId = database.id;
    managedTableId = table.id;
    const row = await storage.createRow(actor, table.id, { CODE: "001" });
    assert.equal(row.version, "1");
    assert.equal(
      (
        await storage.cellHistory(
          actor,
          table.id,
          row.id,
          table.fields[0]!.id,
          { limit: 200 },
        )
      ).data.length,
      1,
    );
    const ownership = (
      await cluster.owner.query(
        "SELECT r.rolname,r.rolsuper,r.rolbypassrls,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relname=$2",
        [table.schemaName, table.physicalName],
      )
    ).rows[0]!;
    assert.deepEqual(ownership, {
      rolname: "rootset_managed_owner",
      rolsuper: false,
      rolbypassrls: false,
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    const peerDatabase = await storage.createDatabase(actor, {
      name: "Peer",
      idempotencyKey: newId(),
    });
    const peerTable = await storage.createTable(actor, peerDatabase.id, {
      name: "Peer native",
      fields: [{ name: "CODE", type: "text" }],
      idempotencyKey: newId(),
    });
    await storage.createRow(actor, peerTable.id, {
      CODE: "peer-private-value",
    });
    await withOrg(cluster.ddl, peerOrgId, async (connection) => {
      await connection.query("SET LOCAL ROLE rootset_managed_owner");
      const peerRows = await connection.query(
        `SELECT row_id FROM "${peerTable.schemaName}"."${peerTable.physicalName}"`,
      );
      assert.equal(peerRows.rowCount, 0);
    });
    const schema = `"${table.schemaName}"`;
    await denied(
      cluster.app,
      `ALTER TABLE ${schema}."${table.physicalName}" DISABLE TRIGGER ALL`,
    );
    await denied(
      cluster.app,
      "UPDATE rootset_control.cell_changes SET new_value='null'::jsonb",
    );
    await denied(cluster.app, "DELETE FROM rootset_control.cell_changes");
    await denied(
      cluster.ddl,
      `SELECT * FROM ${schema}.forbidden_credentials`,
      `CREATE VIEW ${schema}.forbidden_credentials AS SELECT secret_hash FROM rootset_control.api_keys`,
    );
    await denied(
      cluster.ddl,
      `CREATE TRIGGER forbidden_identity_trigger AFTER UPDATE ON rootset_control.users FOR EACH ROW EXECUTE FUNCTION rootset_control.enforce_row()`,
    );
  },
);

verificationCase(
  {
    id: "OBSERVABILITY-01",
    gates: ["V1-30"],
    scope:
      "Actual identity-role operator function aggregates the single organisation despite forced RLS; normal API/DDL roles cannot invoke it, and structured request metrics/logs redact extra input while reporting timeout/admission failures",
  },
  async () => {
    const logs: string[] = [];
    const observer = new OperationalObserver({
      operatorPool: cluster.identity,
      pools: { api: cluster.app, ddl: cluster.ddl, identity: cluster.identity },
      log: (record) => logs.push(record),
    });
    observer.record({
      requestId: newId(),
      operationId: "queryRows",
      status: 408,
      durationMs: 10002,
      errorCode: "QUERY_TIMEOUT",
      ...{
        url: "https://secret.invalid/?token=do-not-log",
        authorization: "Bearer do-not-log",
        values: { secret: "do-not-log" },
      },
    });
    observer.record({
      requestId: newId(),
      operationId: "createRow",
      status: 503,
      durationMs: 12,
      errorCode: "DEPENDENCY_UNAVAILABLE",
    });
    observer.record({
      requestId: newId(),
      operationId: "createRow",
      status: 422,
      durationMs: 4,
      errorCode: ErrorCodeSchema.parse("ROW_LIMIT_REACHED"),
    });
    const result = await observer.metrics();
    assert.equal(result.databaseStatus, "healthy");
    assert.equal(result.database!.storage.activeDatabases, 2);
    assert.equal(result.database!.storage.activeTables, 2);
    assert.equal(result.database!.storage.liveRows, "2");
    assert.equal(result.database!.storage.historyEvents, "2");
    assert.ok(BigInt(result.database!.storage.historyBytes) > 0n);
    assert.ok(BigInt(result.database!.walDirectoryBytes) > 0n);
    assert.equal(result.requests.total, 3);
    assert.equal(result.requests.timeouts, 1);
    assert.equal(result.requests.rowLimitRejections, 1);
    assert.equal(
      logs.some((log) => log.includes("do-not-log")),
      false,
    );
    assert.equal(
      result.signals.some((signal) => signal.code === "WORKER_STALE"),
      true,
    );
    assert.equal(
      result.signals.some(
        (signal) => signal.code === "BACKUP_RECOVERY_POINT_MISSING",
      ),
      true,
    );
  },
);

verificationCase(
  {
    id: "OBSERVABILITY-02",
    gates: ["V1-26", "V1-30"],
    scope:
      "Actual application and bounded two-connection admission pool saturation and SMTP connection failure plus persisted expired job lease, old queue, degraded worker and failed schema states produce installation signals while another application read remains usable",
  },
  async () => {
    const pool = cluster.app;
    const held = await Promise.all(
      Array.from({ length: pool.options.max ?? 4 }, () => pool.connect()),
    );
    const waiting = pool.connect();
    const admission = createPool(pool.options.connectionString!, 2);
    const admissionHeld: PoolClient[] = [];
    let admissionWaiting: Promise<PoolClient> | undefined;
    const observer = new OperationalObserver({
      operatorPool: cluster.identity,
      pools: {
        api: pool,
        ddl: cluster.ddl,
        identity: cluster.identity,
        admission,
      },
      log: () => {},
    });
    try {
      for (let index = 0; index < 2; index++)
        admissionHeld.push(await admission.connect());
      assert.equal(
        (await admissionHeld[0]!.query("SELECT current_user AS role")).rows[0]!
          .role,
        "rootset_app",
      );
      admissionWaiting = admission.connect();
      const saturated = await observer.metrics();
      assert.ok(saturated.pools.api!.waiting > 0);
      assert.deepEqual(saturated.pools.admission, {
        total: 2,
        idle: 0,
        waiting: 1,
        maximum: 2,
      });
      assert.equal(
        saturated.signals.some((signal) => signal.code === "POOL_SATURATED"),
        true,
      );
      assert.ok(
        saturated.signals.some(
          (signal) =>
            signal.code === "POOL_SATURATED" &&
            signal.message.startsWith("admission pool"),
        ),
      );
    } finally {
      held.forEach((connection) => connection.release());
      (await waiting).release();
      admissionHeld.forEach((connection) => connection.release());
      if (admissionWaiting) (await admissionWaiting).release();
      await admission.end();
    }
    const smtp = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      smtp.once("error", reject);
      smtp.listen(0, "127.0.0.1", resolve);
    });
    const address = smtp.address();
    assert.ok(address && typeof address === "object");
    const outbox = new EmailOutbox(cluster.identity, {
      baseURL: "http://127.0.0.1:4300",
      encryptionKeys: { fixture: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "fixture",
      smtp: {
        host: "127.0.0.1",
        port: address.port,
        secure: false,
        from: "rootset@example.test",
      },
    });
    let emailId: string | undefined;
    try {
      emailId = await outbox.enqueue(cluster.identity, {
        to: "fixture@example.test",
        template: "account-verification",
        payload: { url: "http://127.0.0.1:4300/fixture-verification" },
        dedupeKey: newId(),
      });
      assert.equal(await outbox.deliverNext(), true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        smtp.close((error) => (error ? reject(error) : resolve())),
      );
    }
    assert.deepEqual(
      (
        await cluster.owner.query(
          "SELECT state,attempts,last_error FROM rootset_control.email_outbox WHERE id=$1",
          [emailId],
        )
      ).rows[0],
      {
        state: "pending",
        attempts: 1,
        last_error: "SMTP delivery failed",
      },
    );
    for (const state of ["queued", "running"])
      await cluster.owner.query(
        "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key,state,attempt,created_at,lease_until) VALUES($1,$2,'backup','createBackup',$3::jsonb,$4,'database',$5,'{}','fixture',$6,$7,2,now()-interval '2 minutes',now()-interval '1 minute')",
        [
          newId(),
          orgId,
          JSON.stringify(actor),
          actor.id,
          managedDatabaseId,
          newId(),
          state,
        ],
      );
    await cluster.owner.query(
      "INSERT INTO rootset_control.schema_operations(id,org_id,database_id,table_id,idempotency_key,input_hash,kind,state) VALUES($1,$2,$3,$4,$5,'fixture','addField','failed')",
      [newId(), orgId, managedDatabaseId, managedTableId, newId()],
    );
    await cluster.owner.query(
      "INSERT INTO rootset_control.worker_heartbeats(id,state,heartbeat_at) VALUES($1,'degraded',now()),($2,'ready',now()-interval '2 minutes')",
      [newId(), newId()],
    );
    const signal = await observer.metrics();
    assert.equal(
      signal.signals.some((item) => item.code === "EMAIL_DELIVERY_RETRYING"),
      true,
    );
    for (const signalCode of [
      "JOB_BACKLOG",
      "JOB_LEASE_EXPIRED",
      "WORKER_STALE",
      "WORKER_DEGRADED",
      "SCHEMA_JOB_FAILED",
    ])
      assert.ok(
        signal.signals.some((item) => item.code === signalCode),
        signalCode,
      );
    assert.equal(signal.database!.jobs.expiredLeases, 1);
    assert.equal(signal.database!.schema.failed, 1);
    const databases = await storage.listDatabases(actor);
    assert.equal(databases.length, 2);
    const unavailable = new OperationalObserver({
      operatorPool: cluster.app,
      pools: { api: cluster.app },
      log: () => {},
    });
    const unknown = await unavailable.metrics();
    assert.equal(unknown.databaseStatus, "unavailable");
    assert.equal(unknown.database, null);
    assert.equal(
      unknown.signals.some(
        (item) => item.code === "DATABASE_METRICS_UNAVAILABLE",
      ),
      true,
    );
  },
);

verificationCase(
  {
    id: "OWNERSHIP-04",
    gates: ["V1-10", "V1-24", "V1-38"],
    scope:
      "Actual restricted identity login can insert/read/update approved job-control records only in its current organisation; reads and updates outside the sole organisation return no rows, mismatched-context inserts and organisation reassignment fail RLS, and DELETE remains denied on all three control tables",
  },
  async () => {
    const fixtures = [
      { org: orgId, database: managedDatabaseId, table: managedTableId },
    ];
    const records: Record<string, string[]> = {};
    const insert = async (
      pool: Pool,
      contextOrg: string,
      target: (typeof fixtures)[number],
      table: string,
      id: string,
      jobId: string,
    ) =>
      withOrg(pool, contextOrg, (connection) => {
        const args = [id, target.org, target.database];
        switch (table) {
          case "jobs":
            return connection.query(
              "INSERT INTO rootset_control.jobs(id,org_id,target_id,kind,operation_id,actor,requester_id,target_type,input,input_digest,idempotency_key) VALUES($1,$2,$3,'backup','createBackup','{}','qa-identity-ownership','database','{}','qa-identity-ownership',$4)",
              [...args, id],
            );
          case "backups":
            return connection.query(
              "INSERT INTO rootset_control.backups(id,org_id,database_id,job_id,state) VALUES($1,$2,$3,$4,'queued')",
              [...args, jobId],
            );
          case "history_retention_policies":
            return connection.query(
              "INSERT INTO rootset_control.history_retention_policies(id,org_id,database_id,table_id,actor,retention_days,cron) VALUES($1,$2,$3,$4,'{}',365,'0 0 * * *')",
              [...args, target.table],
            );
          default:
            throw new Error("Unexpected QA control table.");
        }
      });
    for (const [index, target] of fixtures.entries()) {
      const jobId = newId();
      for (const table of ["jobs", "backups", "history_retention_policies"]) {
        const id = table === "jobs" ? jobId : newId();
        (records[table] ??= [])[index] = id;
        await insert(cluster.identity, target.org, target, table, id, jobId);
        await withOrg(cluster.identity, target.org, async (connection) => {
          assert.equal(
            (
              await connection.query(
                `SELECT id FROM rootset_control.${table} WHERE id=$1`,
                [id],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await connection.query(
                `UPDATE rootset_control.${table} SET updated_at=now() WHERE id=$1 RETURNING id`,
                [id],
              )
            ).rowCount,
            1,
          );
        });
      }
    }
    for (const table of Object.keys(records)) {
      const id = records[table]![0]!;
      await withOrg(cluster.identity, peerOrgId, async (connection) => {
        assert.equal(
          (
            await connection.query(
              `SELECT id FROM rootset_control.${table} WHERE id=$1`,
              [id],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await connection.query(
              `UPDATE rootset_control.${table} SET updated_at=now() WHERE id=$1 RETURNING id`,
              [id],
            )
          ).rowCount,
          0,
        );
      });
      await assert.rejects(
        insert(
          cluster.identity,
          peerOrgId,
          fixtures[0]!,
          table,
          newId(),
          records.jobs![0]!,
        ),
        (error: unknown) =>
          !!error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "42501",
      );
      await denied(
        cluster.identity,
        `UPDATE rootset_control.${table} SET org_id='${peerOrgId}' WHERE id='${id}'`,
        `SET LOCAL rootset.org_id='${orgId}'`,
      );
      await denied(
        cluster.identity,
        `DELETE FROM rootset_control.${table}`,
        `SET LOCAL rootset.org_id='${orgId}'`,
      );
      assert.equal(
        (
          await cluster.owner.query(
            `SELECT id FROM rootset_control.${table} WHERE id=$1 AND org_id=$2`,
            [id, orgId],
          )
        ).rowCount,
        1,
      );
    }
  },
);
