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
import { ownedPostgres } from "./owned-postgres.js";
import { verificationCase } from "./evidence.js";

let cluster: Awaited<ReturnType<typeof ownedPostgres>>;
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
  role: "owner",
  scopes: ["*"],
  targets: [],
  unrestricted: true,
};
before(async () => {
  cluster = await ownedPostgres();
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
    gates: ["DEV-05", "DB-05"],
    scope:
      "Separate real PostgreSQL cluster reproduces original DDL SET ROLE superuser path, applies forward ownership migrations concurrently in two databases, then rejects deployment/definer/system role escalation and protected-function/table alterations",
  },
  async () => {
    const legacyOrg = newId(),
      droppedDatabase = newId(),
      retainedDatabase = newId(),
      retainedTable = newId(),
      droppedTable = newId();
    const droppedSchema = `rsd_${droppedDatabase.toLowerCase()}`;
    const retainedSchema = `rsd_${retainedDatabase.toLowerCase()}`;
    const retainedPhysical = `rst_${retainedTable.toLowerCase()}`;
    const droppedPhysical = `rst_${droppedTable.toLowerCase()}`;
    await cluster.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Retained upgrade fixture')",
      [legacyOrg],
    );
    await cluster.owner.query(
      "INSERT INTO rootset_control.databases(id,org_id,name,schema_name,state) VALUES($1,$2,'Physically deleted',$3,'deleted'),($4,$2,'Retained physical data',$5,'deleted')",
      [
        droppedDatabase,
        legacyOrg,
        droppedSchema,
        retainedDatabase,
        retainedSchema,
      ],
    );
    await cluster.owner.query(
      `CREATE SCHEMA "${droppedSchema}"; DROP SCHEMA "${droppedSchema}"; CREATE SCHEMA "${retainedSchema}"; CREATE TABLE "${retainedSchema}"."${retainedPhysical}"(row_id varchar(26),org_id varchar(26),value text); CREATE TABLE "${retainedSchema}"."${droppedPhysical}"(row_id varchar(26)); DROP TABLE "${retainedSchema}"."${droppedPhysical}"`,
    );
    await cluster.owner.query(
      `INSERT INTO "${retainedSchema}"."${retainedPhysical}" VALUES($1,$2,'preserved-upgrade-row')`,
      [newId(), legacyOrg],
    );
    await cluster.owner.query(
      "INSERT INTO rootset_control.tables(id,database_id,org_id,name,physical_name,state,row_count) VALUES($1,$2,$3,'Retained physical table',$4,'deleted',1),($5,$2,$3,'Dropped physical table',$6,'deleted',0)",
      [
        retainedTable,
        retainedDatabase,
        legacyOrg,
        retainedPhysical,
        droppedTable,
        droppedPhysical,
      ],
    );
    await cluster.owner.query(
      "CREATE TABLE rootset_control.cell_changes_upgrade_fixture PARTITION OF rootset_control.cell_changes FOR VALUES FROM ('2020-01-01') TO ('2020-02-01'); CREATE TABLE rootset_control.cell_changes_dropped_fixture PARTITION OF rootset_control.cell_changes FOR VALUES FROM ('2021-01-01') TO ('2021-02-01'); DROP TABLE rootset_control.cell_changes_dropped_fixture",
    );
    await withOrg(cluster.owner, legacyOrg, (connection) =>
      connection.query(
        "INSERT INTO rootset_control.cell_changes(org_id,database_id,table_id,row_id,field_id,mutation_id,old_value,new_value,field_definition,new_version,operation,actor,context,changed_at) VALUES($1,$2,$3,$4,$5,$6,NULL,'\"retained-cell\"'::jsonb,'{}',1,'create','{}','{}','2020-01-02T00:00:00Z')",
        [legacyOrg, retainedDatabase, retainedTable, newId(), newId(), newId()],
      ),
    );
    const prior = await cluster.ddl.connect();
    try {
      await prior.query("SET ROLE rootset_owner");
      assert.equal(
        (
          await prior.query(
            "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0]!.rolsuper,
        true,
      );
      await prior.query("RESET ROLE");
    } finally {
      prior.release();
    }
    const applied = await cluster.finalise();
    assert.ok(applied.includes("027_runtime_ownership.sql"));
    assert.ok(applied.includes("028_operator_metrics.sql"));
    assert.deepEqual(
      (
        await cluster.owner.query(
          `SELECT value FROM "${retainedSchema}"."${retainedPhysical}"`,
        )
      ).rows,
      [{ value: "preserved-upgrade-row" }],
    );
    assert.equal(
      (
        await cluster.owner.query(
          "SELECT count(*)::integer AS count FROM rootset_control.cell_changes_upgrade_fixture",
        )
      ).rows[0]!.count,
      1,
    );
    assert.equal(
      (
        await cluster.owner.query(
          "SELECT relforcerowsecurity FROM pg_class WHERE oid='rootset_control.cell_changes_upgrade_fixture'::regclass",
        )
      ).rows[0]!.relforcerowsecurity,
      true,
    );
    for (const role of [
      "rootset_owner",
      "rootset_identity_definer",
      "rootset_worker_definer",
      "rootset_capacity_definer",
      "rootset_metrics_definer",
      "pg_read_server_files",
      "pg_write_server_files",
      "pg_execute_server_program",
    ])
      await denied(cluster.ddl, `SET ROLE ${role}`);
    for (const role of [
      "rootset_managed_owner",
      "rootset_identity_definer",
      "rootset_capacity_definer",
      "rootset_metrics_definer",
    ])
      await denied(cluster.app, `SET ROLE ${role}`);
    for (const role of [
      "rootset_managed_owner",
      "rootset_identity_definer",
      "rootset_capacity_definer",
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
      "ALTER FUNCTION rootset_control.configure_capacity(jsonb) SET search_path=public",
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
      "ALTER TABLE rootset_control.capacity_settings ADD COLUMN forbidden boolean",
    );
    await denied(
      cluster.ddl,
      "CREATE FUNCTION rootset_control.forbidden() RETURNS text LANGUAGE sql AS 'SELECT current_user::text'",
    );
    await denied(cluster.app, "SELECT rootset_control.operator_metrics()");
    await denied(cluster.ddl, "SELECT rootset_control.operator_metrics()");
    await cluster.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2),($3,$4)",
      [orgId, "Ownership fixture", peerOrgId, "Peer ownership fixture"],
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
    gates: ["DB-02", "DB-05", "AUD-04"],
    scope:
      "Managed non-bypass native ownership preserves actual row/history writes and peer RLS; DDL cannot attach an escalating trigger to privileged identity/capacity write targets or read credential columns through a native view",
  },
  async () => {
    const database = await storage.createDatabase(actor, {
      name: "Managed storage",
      idempotencyKey: newId(),
    });
    const table = await storage.createTable(actor, database.id, {
      name: "Native table",
      fields: [{ apiKey: "CODE", label: "Code", type: "text", charLimit: 64 }],
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
    const peer = { ...actor, orgId: peerOrgId };
    const peerDatabase = await storage.createDatabase(peer, {
      name: "Peer",
      idempotencyKey: newId(),
    });
    const peerTable = await storage.createTable(peer, peerDatabase.id, {
      name: "Peer native",
      fields: [{ apiKey: "CODE", label: "Code", type: "text" }],
      idempotencyKey: newId(),
    });
    await storage.createRow(peer, peerTable.id, { CODE: "peer-private-value" });
    await withOrg(cluster.ddl, orgId, async (connection) => {
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
      `CREATE TRIGGER forbidden_capacity_trigger AFTER UPDATE ON rootset_control.capacity_settings FOR EACH ROW EXECUTE FUNCTION rootset_control.enforce_row()`,
    );
    await denied(
      cluster.ddl,
      `CREATE TRIGGER forbidden_identity_trigger AFTER UPDATE ON rootset_control.users FOR EACH ROW EXECUTE FUNCTION rootset_control.enforce_row()`,
    );
  },
);

verificationCase(
  {
    id: "OWNERSHIP-03",
    gates: ["DEV-05", "DB-05", "OPS-03", "OPS-06"],
    scope:
      "Fresh concurrent upgrades create the previously absent reporter role; a separate populated-prefix upgrade strips unsafe existing reporter super/bypass/membership/credential grants while preserving only the actual fixed report functions",
  },
  async () => {
    const result = await cluster.reporterUpgrade();
    assert.ok(result.paths.includes("data") && result.paths.includes("wal"));
    assert.equal(result.checkpoint, true);
    const role = (
      await cluster.owner.query(
        "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit FROM pg_roles WHERE rolname='rootset_capacity_reporter'",
      )
    ).rows[0];
    assert.deepEqual(role, {
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: false,
    });
    assert.equal(
      (
        await cluster.owner.query(
          "SELECT count(*)::integer AS count FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='rootset_capacity_reporter'",
        )
      ).rows[0]!.count,
      0,
    );
    await denied(cluster.ddl, "SET ROLE rootset_capacity_reporter");
    await denied(cluster.app, "SET ROLE rootset_capacity_reporter");
    await denied(cluster.identity, "SET ROLE rootset_capacity_reporter");
  },
);

verificationCase(
  {
    id: "OBSERVABILITY-01",
    gates: ["OPS-05", "OPS-06", "API-10"],
    scope:
      "Actual identity-role operator function aggregates two organisations despite forced RLS; normal API/DDL roles cannot invoke it, and structured request metrics/logs redact extra input while reporting timeout/admission failures",
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
      errorCode: "STORAGE_DISK_PRESSURE",
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
    assert.equal(result.database!.storage.historyEvents, "3");
    assert.ok(BigInt(result.database!.storage.historyBytes) > 0n);
    assert.ok(BigInt(result.database!.walDirectoryBytes) > 0n);
    assert.equal(result.requests.total, 3);
    assert.equal(result.requests.timeouts, 1);
    assert.equal(result.requests.rowLimitRejections, 1);
    assert.equal(result.requests.storageAdmissionRejections, 1);
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
    gates: ["OPS-06", "JOB-05"],
    scope:
      "Actual application and bounded two-connection admission pool saturation and SMTP connection failure plus persisted expired job lease, old queue, degraded worker and failed schema states produce operator signals while another application read remains usable",
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
    const emailId = await outbox.enqueue(cluster.identity, {
      to: "fixture@example.test",
      template: "installation-test",
      payload: { details: "Operational fixture delivery" },
      dedupeKey: newId(),
    });
    try {
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
    assert.equal(databases.length, 1);
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
    gates: ["DB-02", "DB-05", "MCP-11", "JOB-01"],
    scope:
      "Actual restricted identity login can insert/read/update approved job-control records only in its current organisation; peer reads and updates return no rows, peer inserts and organisation reassignment fail RLS, and DELETE remains denied on all four control tables",
  },
  async () => {
    const peer = { ...actor, orgId: peerOrgId };
    const peerDatabase = (await storage.listDatabases(peer))[0]!;
    const peerTable = (await storage.listTables(peer, peerDatabase.id))[0]!;
    const fixtures = [
      { org: orgId, database: managedDatabaseId, table: managedTableId },
      { org: peerOrgId, database: peerDatabase.id, table: peerTable.id },
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
          case "backup_policies":
            return connection.query(
              "INSERT INTO rootset_control.backup_policies(id,org_id,database_id,actor,cron) VALUES($1,$2,$3,'{}','0 0 * * *')",
              args,
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
      for (const table of [
        "jobs",
        "backups",
        "backup_policies",
        "history_retention_policies",
      ]) {
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
      const peerId = records[table]![1]!;
      await withOrg(cluster.identity, orgId, async (connection) => {
        assert.equal(
          (
            await connection.query(
              `SELECT id FROM rootset_control.${table} WHERE id=$1`,
              [peerId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await connection.query(
              `UPDATE rootset_control.${table} SET updated_at=now() WHERE id=$1 RETURNING id`,
              [peerId],
            )
          ).rowCount,
          0,
        );
      });
      await assert.rejects(
        insert(
          cluster.identity,
          orgId,
          fixtures[1]!,
          table,
          newId(),
          records.jobs![1]!,
        ),
        (error: unknown) =>
          !!error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "42501",
      );
      await denied(
        cluster.identity,
        `UPDATE rootset_control.${table} SET org_id='${peerOrgId}' WHERE id='${records[table]![0]}'`,
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
            [peerId, peerOrgId],
          )
        ).rowCount,
        1,
      );
    }
  },
);
