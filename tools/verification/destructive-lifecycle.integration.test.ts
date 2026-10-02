import assert from "node:assert/strict";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import { getOperation, newId, type Actor } from "@rootset/contracts";
import { decryptProtected } from "../../packages/email/src/index.js";
import { isolatedDatabase } from "./isolated-database.js";
import { verificationCase } from "./evidence.js";

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const failure = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;

verificationCase(
  {
    id: "DELETE-ORG-LIFECYCLE-01",
    gates: ["ACC-10", "DB-12", "BKP-07", "JOB-01", "JOB-02", "ROW-10"],
    scope:
      "Real setup/email verification/password session, current Owner-bound approval and durable Core org deletion retain native/history and verified encrypted backup under default indefinite policy, revoke current credentials, record an atomic terminal outcome and preserve a peer org",
  },
  async () => {
    const db = await isolatedDatabase();
    const config = {
      ...loadConfig(),
      databaseURL: db.app.options.connectionString!,
      ddlDatabaseURL: db.ddl.options.connectionString!,
      identityDatabaseURL: db.identity.options.connectionString!,
    };
    const runtime = await createRuntime(config);
    let actor: Actor | undefined;
    try {
      const email = `delete-org-${newId().toLowerCase()}@rootset.example.test`,
        password = "Rootset deletion fixture password 2026!";
      const setup = record(
        await runtime.identity.claimSetup({
          bootstrapSecret: config.bootstrapSecret,
          name: "Deletion fixture",
          email,
          password,
          organisationName: "Deletion target",
        }),
      );
      const orgId = String(setup.orgId);
      const notification = (
        await db.owner.query(
          "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='account-verification' AND to_address=$1 ORDER BY created_at DESC LIMIT 1",
          [email],
        )
      ).rows[0];
      assert.ok(notification);
      const message = decryptProtected<{ actionUrl: string }>(
        notification.payload_encrypted,
        config,
      );
      const verified = await runtime.identity.auth.handler(
        new Request(message.actionUrl),
      );
      assert.ok([200, 302].includes(verified.status));
      const login = await runtime.identity.auth.handler(
        new Request(`${config.baseURL}/v1/auth/sign-in/email`, {
          method: "POST",
          headers: {
            origin: config.baseURL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, password }),
        }),
      );
      assert.equal(login.status, 200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const sessionRequest = new Request(
        `${config.baseURL}/api/internal/v1/context`,
        { headers: { cookie, origin: config.baseURL } },
      );
      actor = (await runtime.identity.resolveActor(sessionRequest, "browser"))!;
      assert.ok(actor && actor.orgId === orgId && actor.role === "owner");
      const owner = actor;
      const execute = async (
        id: string,
        input: Record<string, unknown>,
        key = newId(),
      ) =>
        getOperation(id).outputSchema.parse(
          await runtime.core.execute(id, owner, input, {
            surface: "browser",
            requestId: newId(),
            idempotencyKey: key,
          }),
        );
      const databaseId = String(
        record(
          await execute("createDatabase", {
            orgId,
            name: "Retained organisation data",
          }),
        ).id,
      );
      const schema = record(
        await execute("createTable", {
          orgId,
          databaseId,
          name: "Retained rows",
          fields: [
            { apiKey: "CODE", label: "Code", type: "text", charLimit: 64 },
          ],
        }),
      );
      const tableId = String(record(schema.table).id);
      const row = record(
        record(
          await execute("createRow", {
            orgId,
            databaseId,
            tableId,
            expectedSchemaVersion: 1,
            values: { CODE: "retained-data" },
          }),
        ).row,
      );
      await execute("updateRow", {
        orgId,
        databaseId,
        tableId,
        rowId: row.id,
        expectedVersion: "1",
        expectedSchemaVersion: 1,
        values: { CODE: "retained-edit" },
      });
      const table = await runtime.storage.getTable(owner, tableId);
      const historyBefore = (
        await db.owner.query(
          "SELECT count(*)::integer AS count FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2",
          [orgId, tableId],
        )
      ).rows[0]!.count;
      assert.equal(historyBefore, 2);
      const key = record(
        await execute("createPersonalKey", {
          orgId,
          name: "Deleted org read key",
          scopes: ["org:read", "rows:read"],
          targets: [],
          unrestricted: true,
        }),
      );
      assert.equal(typeof key.secret, "string");
      const keyRequest = new Request(`${config.baseURL}/v1/orgs/${orgId}`, {
        headers: { authorization: `Bearer ${key.secret}` },
      });
      assert.ok(await runtime.identity.resolveActor(keyRequest, "api"));
      const peerOrgId = newId();
      await db.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Peer preserved')",
        [peerOrgId],
      );
      const peerActor = { ...owner, orgId: peerOrgId };
      const peerDatabase = await runtime.storage.createDatabase(peerActor, {
        name: "Peer data",
        idempotencyKey: newId(),
      });
      const peerTable = await runtime.storage.createTable(
        peerActor,
        peerDatabase.id,
        {
          name: "Peer rows",
          fields: [{ apiKey: "CODE", label: "Code", type: "text" }],
          idempotencyKey: newId(),
        },
      );
      await runtime.storage.createRow(peerActor, peerTable.id, {
        CODE: "peer-preserved",
      });
      const terminal = async (id: string) => {
        for (let attempt = 0; attempt < 30; attempt++) {
          await runtime.jobs.runOnce(orgId);
          const state = (
            await db.owner.query(
              "SELECT * FROM rootset_control.jobs WHERE id=$1",
              [id],
            )
          ).rows[0]!;
          if (
            [
              "succeeded",
              "failed",
              "cancelled",
              "partially_completed",
            ].includes(state.state)
          )
            return state;
        }
        throw new Error("Durable fixture job did not become terminal.");
      };
      const backupJob = record(
        await execute("createBackup", { orgId, databaseId }),
      );
      const backupOutcome = await terminal(String(backupJob.jobId));
      assert.equal(
        backupOutcome.state,
        "succeeded",
        JSON.stringify(backupOutcome.error),
      );
      const publicBackupJob = record(
        await execute("getJob", { orgId, id: backupJob.jobId }),
      );
      assert.equal(publicBackupJob.state, "succeeded");
      const backup = (
        await db.owner.query(
          "SELECT * FROM rootset_control.backups WHERE job_id=$1",
          [backupJob.jobId],
        )
      ).rows[0]!;
      assert.equal(backup.state, "succeeded");
      assert.ok(backup.verified_at && backup.manifest_artifact_id);
      const action = record(
        await execute("beginAccountAction", {
          orgId,
          type: "delete_organisation",
          operationId: "deleteOrganisation",
          input: { orgId },
        }),
      );
      await assert.rejects(
        runtime.core.execute(
          "deleteOrganisation",
          owner,
          { orgId, approvalId: action.id },
          { surface: "browser", idempotencyKey: newId() },
        ),
        (error) => failure(error) === "STEP_UP_REQUIRED",
      );
      await runtime.identity.approveAction(String(action.id), owner);
      const admissionKey = newId();
      const accepted = record(
        await execute(
          "deleteOrganisation",
          { orgId, approvalId: action.id },
          admissionKey,
        ),
      );
      const publicDeletionJob = record(
        await execute("getJob", { orgId, id: accepted.jobId }),
      );
      assert.equal(publicDeletionJob.state, "queued");
      const replay = record(
        await execute(
          "deleteOrganisation",
          { orgId, approvalId: action.id },
          admissionKey,
        ),
      );
      assert.equal(replay.jobId, accepted.jobId);
      assert.equal(
        (
          await db.owner.query(
            "SELECT consumed_at IS NOT NULL AS consumed FROM rootset_control.account_actions WHERE id=$1",
            [action.id],
          )
        ).rows[0]!.consumed,
        true,
      );
      const deleted = await terminal(String(accepted.jobId));
      assert.equal(deleted.state, "succeeded", JSON.stringify(deleted.error));
      assert.equal(deleted.result.deleted, true);
      assert.equal(
        (
          await db.owner.query(
            "SELECT state FROM rootset_control.organisations WHERE id=$1",
            [orgId],
          )
        ).rows[0]!.state,
        "deleted",
      );
      assert.equal(
        (
          await db.owner.query(
            "SELECT state FROM rootset_control.databases WHERE id=$1",
            [databaseId],
          )
        ).rows[0]!.state,
        "deleted",
      );
      assert.equal(
        (
          await db.owner.query(
            "SELECT state FROM rootset_control.tables WHERE id=$1",
            [tableId],
          )
        ).rows[0]!.state,
        "deleted",
      );
      assert.equal(
        (
          await db.owner.query(
            `SELECT "f_${table.fields[0]!.id.toLowerCase()}" AS value FROM "${table.schemaName}"."${table.physicalName}" WHERE row_id=$1`,
            [row.id],
          )
        ).rows[0]!.value,
        "retained-edit",
      );
      assert.equal(
        (
          await db.owner.query(
            "SELECT count(*)::integer AS count FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2",
            [orgId, tableId],
          )
        ).rows[0]!.count,
        historyBefore,
      );
      assert.equal(
        (
          await db.owner.query(
            "SELECT count(*)::integer AS count FROM rootset_control.operation_outcomes WHERE job_id=$1 AND result->>'deleted'='true'",
            [accepted.jobId],
          )
        ).rows[0]!.count,
        1,
      );
      assert.equal(
        (
          await db.owner.query(
            "SELECT count(*)::integer AS count FROM rootset_control.account_audit WHERE org_id=$1 AND operation='deleteOrganisation'",
            [orgId],
          )
        ).rows[0]!.count,
        1,
      );
      assert.equal(
        await runtime.identity.resolveActor(keyRequest, "api"),
        null,
      );
      assert.equal(
        await runtime.identity.resolveActor(sessionRequest, "browser"),
        null,
      );
      await assert.rejects(runtime.identity.refreshActor(owner));
      assert.equal(
        (
          await db.owner.query(
            "SELECT count(*)::integer AS count FROM rootset_control.memberships WHERE org_id=$1 AND state='active'",
            [orgId],
          )
        ).rows[0]!.count,
        0,
      );
      assert.equal(await runtime.jobs.scheduleMaintenance(orgId), 0);
      const retained = await runtime.jobs.artifacts.get(
        owner,
        backup.manifest_artifact_id,
      );
      assert.equal(retained.state, "ready");
      assert.equal(
        (
          await db.owner.query(
            "SELECT state FROM rootset_control.backups WHERE id=$1",
            [backup.id],
          )
        ).rows[0]!.state,
        "succeeded",
      );
      assert.equal(
        (await runtime.storage.queryRows(peerActor, peerTable.id, {})).data[0]!
          .values.CODE,
        "peer-preserved",
      );
    } finally {
      if (actor) {
        const records = (
          await db.owner.query(
            "SELECT id FROM rootset_control.artifacts WHERE org_id=$1 AND state<>'deleted'",
            [actor.orgId],
          )
        ).rows;
        for (const item of records) {
          const artifact = await runtime.jobs.artifacts.get(actor, item.id);
          await runtime.jobs.artifacts.remove(actor, artifact);
        }
      }
      await runtime.close();
      await db.close();
    }
  },
);
