import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { decryptProtected, type EmailPayload } from "@rootset/email";
import {
  AccountActionSchema,
  JobAcceptedSchema,
  JobSchema,
  limits,
  newId,
  operationMap,
  RootsetError,
  RowValuesInputSchema,
  type Actor,
  type Row,
} from "@rootset/contracts";
import { createRuntime } from "./runtime";
import { loadConfig } from "./config";

function assertBusinessValues(
  actual: unknown,
  expected: unknown,
  typedDictionary: boolean,
) {
  const values = RowValuesInputSchema.parse(actual);
  if (typedDictionary) assert.equal(Object.getPrototypeOf(actual), null);
  assert.deepEqual(values, RowValuesInputSchema.parse(expected));
  const secret = (values.token as { secret: Record<string, unknown> }).secret;
  assert.equal(Object.hasOwn(secret, "__proto__"), true);
  assert.equal(secret["__proto__"], "ordinary JSON");
  assert.equal(Object.getPrototypeOf(secret), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, "rootsetRepairPolluted"), false);
  assert.equal(
    ({} as Record<string, unknown>).rootsetRepairPolluted,
    undefined,
  );
}

test(
  "AUD03 approved operator repair preserves exact business intent and atomically journals normal row/history effects",
  { timeout: 60000 },
  async (t) => {
    const fixture = await isolatedDatabase();
    const runtime = await createRuntime({
      ...loadConfig(),
      baseURL: "http://localhost:6313",
      webURL: "http://localhost:6313",
      databaseURL: fixture.app.options.connectionString!,
      ddlDatabaseURL: fixture.ddl.options.connectionString!,
      identityDatabaseURL: fixture.identity.options.connectionString!,
    }).catch(async (error) => {
      await fixture.close();
      throw error;
    });
    try {
      assert.ok(
        fixture.appliedMigrations.includes("0001_baseline.sql"),
        "The isolated fixture must apply the fixed repair completion migration",
      );
      const permissions = (
        await fixture.owner.query(
          "SELECT has_function_privilege('rootset_app','rootset_control.append_operator_repair_completion(varchar,varchar,varchar,varchar)','EXECUTE') AS fixed_append,has_table_privilege('rootset_app','rootset_control.resource_history','INSERT') AS history_insert,has_table_privilege('rootset_app','rootset_control.resource_history','UPDATE') AS history_update,has_table_privilege('rootset_app','rootset_control.resource_history','DELETE') AS history_delete",
        )
      ).rows[0];
      assert.deepEqual(permissions, {
        fixed_append: true,
        history_insert: false,
        history_update: false,
        history_delete: false,
      });
      const service = runtime.identity,
        password = randomBytes(32).toString("base64url"),
        email = `repair-${newId().toLowerCase()}@example.test`;
      await service.claimSetup({
        bootstrapSecret: service.config.bootstrapSecret,
        name: "Repair reviewer",
        email,
        password,
        organisationName: "Disposable operator repair",
      });
      const mail = (
        await fixture.owner.query(
          "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-verification'",
          [email],
        )
      ).rows[0];
      const verification = decryptProtected<EmailPayload>(
        mail.payload_encrypted,
        service.config,
      );
      const verified = await service.auth.handler(
        new Request(verification.actionUrl!),
      );
      assert.ok(verified.status === 200 || verified.status === 302);
      const signedIn = await service.auth.handler(
        new Request("http://localhost:6313/v1/auth/sign-in/email", {
          method: "POST",
          headers: {
            origin: "http://localhost:6313",
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, password }),
        }),
      );
      assert.equal(signedIn.status, 200);
      const cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      let actor = (await service.resolveActor(
        new Request("http://localhost:6313/v1/auth/get-session", {
          headers: { cookie },
        }),
        "browser",
      ))!;
      assert.equal(actor.kind, "session");
      const execute = async (
        id: string,
        input: Record<string, unknown>,
        context: Record<string, unknown> = {},
        as: Actor = actor,
      ) =>
        operationMap[id]!.outputSchema.parse(
          await runtime.core.execute(id, as, input, {
            surface: "browser",
            idempotencyKey: newId(),
            ...context,
          }),
        );
      const database = await runtime.storage.createDatabase(actor, {
        name: "Operator repair data",
      });
      const table = await runtime.storage.createTable(actor, database.id, {
        name: "Repair cells",
        fields: [
          {
            name: "password",
            type: "text",
            charLimit: 100,
          },
          { name: "token", type: "json" },
          { name: "NUMBER", type: "integer" },
        ],
      });
      let row: Row = await runtime.storage.createRow(
        actor,
        table.id,
        {
          password: "original datum",
          token: { secret: "original business value" },
          NUMBER: 1,
        },
        { expectedSchemaVersion: 1, idempotencyKey: newId() },
      );
      const input = (current: Row, values: Record<string, unknown>) => ({
        orgId: actor.orgId,
        databaseId: database.id,
        tableId: table.id,
        expectedSchemaVersion: 1,
        repair: { reason: "  Correct approved source transcription  " },
        mutations: [
          {
            type: "update",
            rowId: current.id,
            expectedVersion: current.version,
            values,
          },
        ],
      });
      const counts = async () =>
        (
          await fixture.owner.query(
            "SELECT (SELECT count(*) FROM rootset_control.jobs WHERE operation_id='mutateRows')::text AS jobs,(SELECT count(*) FROM rootset_control.resource_history WHERE operation='operatorRepair')::text AS completions,(SELECT count(*) FROM rootset_control.cell_changes WHERE row_id=$1)::text AS cells",
            [row.id],
          )
        ).rows[0];
      const values = {
        password: "corrected business datum",
        token: JSON.parse(
          '{"password":"business value","token":"business value","secret":{"__proto__":"ordinary JSON"}}',
        ),
        NUMBER: 2,
      };
      await t.test(
        "Admin repair and missing/changed proof cannot admit repair; typed display and exact replay retain business password/token/secret keys",
        async () => {
          actor = await service.refreshActor(actor);
          const before = await counts();
          await assert.rejects(
            () => execute("mutateRows", input(row, values)),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          assert.deepEqual(await counts(), before);
          const key = newId(),
            business = input(row, values);
          const action = AccountActionSchema.parse(
            await execute(
              "beginAccountAction",
              {
                orgId: actor.orgId,
                type: "operator_repair",
                operationId: "mutateRows",
                input: business,
              },
              { idempotencyKey: key },
            ),
          );
          const replay = AccountActionSchema.parse(
            await execute(
              "beginAccountAction",
              {
                orgId: actor.orgId,
                type: "operator_repair",
                operationId: "mutateRows",
                input: business,
              },
              { idempotencyKey: key },
            ),
          );
          assert.deepEqual(replay, action);
          assert.equal(
            action.repairIntent?.reason,
            "Correct approved source transcription",
          );
          assertBusinessValues(
            action.repairIntent?.updates[0]?.values,
            values,
            true,
          );
          const viewed = AccountActionSchema.parse(
            await execute("getAccountAction", { id: action.id }),
          );
          assertBusinessValues(
            viewed.repairIntent?.updates[0]?.values,
            values,
            true,
          );
          assert.equal(JSON.stringify(action).includes(password), false);
          await service.approveAction(action.id, actor);
          await assert.rejects(
            () =>
              execute("mutateRows", {
                ...business,
                mutations: [
                  {
                    ...business.mutations[0],
                    values: { ...values, NUMBER: 3 },
                  },
                ],
                approvalId: action.id,
              }),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          assert.deepEqual(await counts(), before);
          const admissionKey = newId();
          const admitted = JobAcceptedSchema.parse(
            await execute(
              "mutateRows",
              { ...business, approvalId: action.id },
              { idempotencyKey: admissionKey },
            ),
          );
          const pending = (
            await fixture.owner.query(
              "SELECT org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,state FROM rootset_control.jobs WHERE id=$1",
              [admitted.jobId],
            )
          ).rows[0];
          assert.equal(pending.org_id, actor.orgId);
          assert.equal(pending.kind, "operation");
          assert.equal(pending.operation_id, "mutateRows");
          assert.equal(pending.state, "queued");
          assert.equal(pending.requester_id, `${actor.kind}:${actor.id}`);
          assert.equal(pending.target_type, "table");
          assert.equal(pending.target_id, table.id);
          for (const field of [
            "kind",
            "id",
            "orgId",
            "userId",
            "credentialId",
            "clientId",
          ] as const)
            assert.equal(pending.actor[field], actor[field]);
          assert.equal(pending.actor.role, "admin");
          assert.equal(
            pending.input.repair.reason,
            "Correct approved source transcription",
          );
          assert.equal(pending.input.approvalId, action.id);
          assert.equal(pending.input.operationContext.approvalId, action.id);
          assert.equal(pending.input.operationContext.source, "operator");
          assert.equal(pending.input.operationContext.stepUpApproved, true);
          assert.equal(
            pending.input.operationContext.admissionSource,
            "browser",
          );
          assert.equal(
            pending.input.operationContext.admissionStepUpApproved,
            true,
          );
          assert.match(
            pending.input.operationContext.admissionBinding,
            /^v1:[a-f0-9]{64}$/,
          );
          const staged = await fixture.owner.query(
            "UPDATE rootset_control.control_mutation_replays SET expires_at=clock_timestamp()-interval '1 hour' WHERE org_id=$1 AND operation_id='mutateRows' AND outcome->>'jobId'=$2 RETURNING operation_id",
            [actor.orgId, admitted.jobId],
          );
          assert.equal(staged.rowCount, 1);
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT consumed_at IS NOT NULL AND expires_at>clock_timestamp() AS admitted FROM rootset_control.account_actions WHERE id=$1",
                [action.id],
              )
            ).rows[0].admitted,
            true,
          );
          assert.deepEqual(
            await execute(
              "mutateRows",
              { ...business, approvalId: action.id },
              { idempotencyKey: admissionKey },
            ),
            admitted,
          );
          for (const [changed, context] of [
            [{ ...business, approvalId: action.id }, { surface: "mcp" }],
            [{ ...business, approvalId: newId() }, {}],
            [
              {
                ...business,
                approvalId: action.id,
                mutations: [
                  {
                    ...business.mutations[0],
                    values: { ...values, NUMBER: 3 },
                  },
                ],
              },
              {},
            ],
          ] as const)
            await assert.rejects(
              () =>
                execute("mutateRows", changed, {
                  idempotencyKey: admissionKey,
                  ...context,
                }),
              (error) =>
                (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
            );
          await assert.rejects(
            () =>
              execute(
                "mutateRows",
                { ...business, approvalId: action.id },
                { idempotencyKey: admissionKey, actionId: newId() },
              ),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          await assert.rejects(
            () => execute("mutateRows", { ...business, approvalId: action.id }),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          const consumed = AccountActionSchema.parse(
            await execute("getAccountAction", { id: action.id }),
          );
          assert.equal(consumed.state, "consumed");
          assert.deepEqual(consumed.result, admitted);
          assert.equal(consumed.repairIntent, undefined);
          const nativeIntent = (
            await fixture.owner.query(
              "SELECT jsonb_build_object('actionId',input#>>'{operationContext,approvalId}','reason',input#>>'{repair,reason}') AS outcome FROM rootset_control.jobs WHERE id=$1 AND operation_id='mutateRows'",
              [admitted.jobId],
            )
          ).rows;
          assert.equal(nativeIntent.length, 1);
          assert.equal(nativeIntent[0].outcome.actionId, action.id);
          assert.equal(
            JSON.stringify(nativeIntent).includes("corrected business datum"),
            false,
          );
          assert.equal(
            (await runtime.storage.getRow(actor, table.id, row.id)).version,
            row.version,
          );
          assert.equal(await runtime.jobs.runOnce(actor.orgId), true);
          const job = (
            await fixture.owner.query(
              "SELECT state,result FROM rootset_control.jobs WHERE id=$1",
              [admitted.jobId],
            )
          ).rows[0];
          assert.equal(job.state, "succeeded");
          row = await runtime.storage.getRow(actor, table.id, row.id);
          assertBusinessValues(row.values, values, false);
          const outcome = (
            await fixture.owner.query(
              "SELECT result FROM rootset_control.operation_outcomes WHERE job_id=$1",
              [admitted.jobId],
            )
          ).rows[0];
          assert.deepEqual(outcome.result, job.result);
          const changes = (
            await fixture.owner.query(
              "SELECT old_value,new_value,actor,context FROM rootset_control.cell_changes WHERE mutation_id=$1",
              [job.result.mutationId],
            )
          ).rows;
          assert.equal(changes.length, 3);
          assert.ok(
            changes.every(
              (change) =>
                change.context.source === "operator" &&
                change.context.jobId === admitted.jobId &&
                change.actor.userId === actor.userId,
            ),
          );
          const completion = (
            await fixture.owner.query(
              "SELECT after_value,context FROM rootset_control.resource_history WHERE operation='operatorRepair' AND after_value->>'mutationId'=$1",
              [job.result.mutationId],
            )
          ).rows;
          assert.equal(completion.length, 1);
          assert.equal(completion[0].after_value.approvalId, action.id);
          assert.equal(
            JSON.stringify(completion).includes("corrected business datum"),
            false,
          );
        },
      );
      await t.test(
        "Ordinary batches remain synchronous and update only normal history without requiring operator approval",
        async () => {
          const before = await counts();
          const result = await execute("mutateRows", {
            orgId: actor.orgId,
            databaseId: database.id,
            tableId: table.id,
            expectedSchemaVersion: 1,
            mutations: [
              {
                type: "update",
                rowId: row.id,
                expectedVersion: row.version,
                values: { NUMBER: 4 },
              },
            ],
          });
          assert.ok(
            result &&
              typeof result === "object" &&
              "mutationId" in result &&
              !("jobId" in result),
          );
          const after = await counts();
          assert.equal(after.jobs, before.jobs);
          assert.equal(after.completions, before.completions);
          row = await runtime.storage.getRow(actor, table.id, row.id);
          assert.equal(row.values.NUMBER, 4);
        },
      );
      await t.test(
        "Trusted MCP repair origin caps the committed outcome independently of operator audit source",
        async () => {
          const rows: Row[] = [];
          for (let i = 0; i < 20; i++)
            rows.push(
              await runtime.storage.createRow(
                actor,
                table.id,
                {
                  password: `Budget datum ${i}`,
                  token: { ordinary: "x".repeat(60000) },
                  NUMBER: 1,
                },
                { expectedSchemaVersion: 1, idempotencyKey: newId() },
              ),
            );
          const admit = async (selection: Row[]) => {
            const business = {
              orgId: actor.orgId,
              databaseId: database.id,
              tableId: table.id,
              expectedSchemaVersion: 1,
              repair: { reason: "Verify bounded MCP repair outcome" },
              mutations: selection.map((current) => ({
                type: "update",
                rowId: current.id,
                expectedVersion: current.version,
                values: { NUMBER: 2 },
              })),
            };
            const action = AccountActionSchema.parse(
              await execute("beginAccountAction", {
                orgId: actor.orgId,
                type: "operator_repair",
                operationId: "mutateRows",
                input: business,
              }),
            );
            await service.approveAction(action.id, actor);
            return JobAcceptedSchema.parse(
              await execute(
                "mutateRows",
                { ...business, approvalId: action.id },
                { surface: "mcp" },
              ),
            );
          };
          const excessive = await admit(rows);
          assert.equal(await runtime.jobs.runOnce(actor.orgId), true);
          const failed = JobSchema.parse(
            await execute("getJob", {
              orgId: actor.orgId,
              id: excessive.jobId,
            }),
          );
          assert.equal(failed.state, "failed");
          assert.equal(failed.error?.code, "PAYLOAD_TOO_LARGE");
          for (const initial of rows) {
            const current = await runtime.storage.getRow(
              actor,
              table.id,
              initial.id,
            );
            assert.equal(current.version, initial.version);
            assert.equal(current.values.NUMBER, 1);
          }
          const absent = (
            await fixture.owner.query(
              "SELECT (SELECT count(*) FROM rootset_control.cell_changes WHERE context->>'jobId'=$1)::text cells,(SELECT count(*) FROM rootset_control.resource_history WHERE operation='operatorRepair' AND after_value->>'jobId'=$1)::text completions,(SELECT count(*) FROM rootset_control.operation_outcomes WHERE job_id=$1)::text outcomes,(SELECT count(*) FROM rootset_control.mutations WHERE idempotency_key=$2)::text mutations",
              [excessive.jobId, `job:${excessive.jobId}:operation`],
            )
          ).rows[0];
          assert.deepEqual(absent, {
            cells: "0",
            completions: "0",
            outcomes: "0",
            mutations: "0",
          });
          const bounded = await admit(rows.slice(0, 16));
          assert.equal(await runtime.jobs.runOnce(actor.orgId), true);
          const complete = JobSchema.parse(
            await execute("getJob", { orgId: actor.orgId, id: bounded.jobId }),
          );
          assert.equal(complete.state, "succeeded");
          const envelope = {
            content: [{ type: "text", text: "Operation completed." }],
            structuredContent: complete,
          };
          assert.ok(
            Buffer.byteLength(JSON.stringify(envelope)) < limits.mcpResultBytes,
          );
          const audit = (
            await fixture.owner.query(
              "SELECT count(*)::text cells,bool_and(context->>'source'='operator') operator FROM rootset_control.cell_changes WHERE context->>'jobId'=$1",
              [bounded.jobId],
            )
          ).rows[0];
          assert.equal(audit.cells, "16");
          assert.equal(audit.operator, true);
        },
      );
      await t.test(
        "A durable outcome failure rolls back repair rows, native receipt, history and completion in the same transaction",
        async () => {
          const business = input(row, { NUMBER: 6 });
          const action = AccountActionSchema.parse(
            await execute("beginAccountAction", {
              orgId: actor.orgId,
              type: "operator_repair",
              operationId: "mutateRows",
              input: business,
            }),
          );
          await service.approveAction(action.id, actor);
          const admitted = JobAcceptedSchema.parse(
            await execute("mutateRows", { ...business, approvalId: action.id }),
          );
          const before = await counts();
          const record = runtime.core.recordOperationOutcome;
          runtime.core.recordOperationOutcome = async () => {
            throw new RootsetError(
              "CONFIGURATION_INVALID",
              "Disposable durable-outcome failure",
            );
          };
          try {
            assert.equal(await runtime.jobs.runOnce(actor.orgId), true);
          } finally {
            runtime.core.recordOperationOutcome = record;
          }
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT state FROM rootset_control.jobs WHERE id=$1",
                [admitted.jobId],
              )
            ).rows[0].state,
            "failed",
          );
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*)::text AS count FROM rootset_control.operation_outcomes WHERE job_id=$1",
                [admitted.jobId],
              )
            ).rows[0].count,
            "0",
          );
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*)::text AS count FROM rootset_control.mutations WHERE idempotency_key=$1",
                [`job:${admitted.jobId}:operation`],
              )
            ).rows[0].count,
            "0",
          );
          assert.deepEqual(await counts(), before);
          const current = await runtime.storage.getRow(actor, table.id, row.id);
          assert.equal(current.version, row.version);
          assert.equal(current.values.NUMBER, 4);
        },
      );
      await t.test(
        "Current Admin role revocation after admission blocks worker publication with no row/history/completion effects",
        async () => {
          const business = input(row, { NUMBER: 5 });
          const action = AccountActionSchema.parse(
            await execute("beginAccountAction", {
              orgId: actor.orgId,
              type: "operator_repair",
              operationId: "mutateRows",
              input: business,
            }),
          );
          await service.approveAction(action.id, actor);
          const admitted = JobAcceptedSchema.parse(
            await execute("mutateRows", { ...business, approvalId: action.id }),
          );
          const before = await counts();
          await fixture.owner.query(
            "UPDATE rootset_control.memberships SET role='viewer',version=version+1 WHERE user_id=$1",
            [actor.userId],
          );
          assert.equal(await runtime.jobs.runOnce(actor.orgId), true);
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT state FROM rootset_control.jobs WHERE id=$1",
                [admitted.jobId],
              )
            ).rows[0].state,
            "failed",
          );
          const current = await runtime.storage.getRow(
            await service.refreshActor(actor),
            table.id,
            row.id,
          );
          assert.equal(current.version, row.version);
          assert.equal(current.values.NUMBER, 4);
          assert.deepEqual(await counts(), before);
        },
      );
    } finally {
      await runtime.close();
      await fixture.close();
    }
  },
);
