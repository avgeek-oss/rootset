import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  AccountActionSchema,
  getRuntimeOperation,
  JobAcceptedSchema,
  newId,
  operationMap,
  type Actor,
} from "@rootset/contracts";
import { decryptProtected, type EmailPayload } from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { loadConfig } from "./config";
import { createRuntime } from "./runtime";

test(
  "ACC10 account and organisation deletion preserve declared approval input, last-Owner checks and authenticated queued replay",
  { timeout: 60000 },
  async (t) => {
    const fixture = await isolatedDatabase();
    const runtime = await createRuntime({
      ...loadConfig(),
      baseURL: "http://localhost:6314",
      databaseURL: fixture.app.options.connectionString!,
      ddlDatabaseURL: fixture.ddl.options.connectionString!,
      identityDatabaseURL: fixture.identity.options.connectionString!,
    }).catch(async (error) => {
      await fixture.close();
      throw error;
    });
    try {
      const service = runtime.identity,
        password = randomBytes(32).toString("base64url"),
        email = `delete-owner-${newId().toLowerCase()}@example.test`;
      const verifyEmail = async (address: string) => {
        const mail = (
          await fixture.owner.query(
            "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-verification' ORDER BY id DESC LIMIT 1",
            [address],
          )
        ).rows[0];
        assert.ok(mail);
        const payload = decryptProtected<EmailPayload>(
          mail.payload_encrypted,
          service.config,
        );
        const result = await service.auth.handler(
          new Request(payload.actionUrl!),
        );
        assert.ok(result.status === 200 || result.status === 302);
      };
      const signIn = async (address: string, secret: string) => {
        const result = await service.auth.handler(
          new Request(`${service.config.baseURL}/v1/auth/sign-in/email`, {
            method: "POST",
            headers: {
              origin: service.config.baseURL,
              "content-type": "application/json",
            },
            body: JSON.stringify({ email: address, password: secret }),
          }),
        );
        assert.equal(result.status, 200);
        return result.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
      };
      const actorFor = async (cookie: string) => {
        const actor = await service.resolveActor(
          new Request(`${service.config.baseURL}/v1/auth/get-session`, {
            headers: { cookie },
          }),
          "browser",
        );
        assert.ok(actor);
        return actor;
      };
      const execute = async (
        operationId: string,
        actor: Actor,
        input: Record<string, unknown>,
        idempotencyKey = newId(),
      ) =>
        getRuntimeOperation(operationId).outputSchema.parse(
          await runtime.core.execute(operationId, actor, input, {
            surface: "browser",
            idempotencyKey,
          }),
        );
      await service.claimSetup({
        bootstrapSecret: service.config.bootstrapSecret,
        name: "Disposable deletion Owner",
        email,
        password,
        organisationName: "Disposable account deletion",
      });
      await verifyEmail(email);
      const owner = await actorFor(await signIn(email, password));
      assert.equal(owner.role, "owner");
      assert.equal(operationMap.deleteAccount, undefined);
      await t.test(
        "Missing DELETE confirmation and sole enabled Owner cannot admit internal deletion",
        async () => {
          await assert.rejects(
            () =>
              execute("beginAccountAction", owner, {
                orgId: owner.orgId,
                type: "delete_account",
                operationId: "deleteAccount",
                input: {},
              }),
            (error) => (error as { code: string }).code === "VALIDATION_FAILED",
          );
          const action = AccountActionSchema.parse(
            await execute("beginAccountAction", owner, {
              orgId: owner.orgId,
              type: "delete_account",
              operationId: "deleteAccount",
              input: { confirmation: "DELETE" },
            }),
          );
          await service.approveAction(action.id, owner);
          await assert.rejects(
            () => execute("completeAccountAction", owner, { id: action.id }),
            (error) => (error as { code: string }).code === "LAST_OWNER",
          );
          const observed = (
            await fixture.owner.query(
              "SELECT (SELECT count(*) FROM rootset_control.jobs WHERE operation_id='deleteAccount')::text jobs,(SELECT count(*) FROM rootset_control.memberships WHERE org_id=$1 AND role='owner' AND state='active')::text owners,(SELECT consumed_at FROM rootset_control.account_actions WHERE id=$2) consumed_at",
              [owner.orgId, action.id],
            )
          ).rows[0];
          assert.equal(observed.jobs, "0");
          assert.equal(observed.owners, "1");
          assert.equal(observed.consumed_at, null);
          assert.equal((await service.refreshActor(owner)).role, "owner");
        },
      );
      await t.test(
        "Genuinely invited verified Editor deletion survives outer expiry and concurrent completion, then revokes its session and issued key without deleting the Owner",
        async () => {
          const invitedEmail = `delete-editor-${newId().toLowerCase()}@example.test`,
            invitedPassword = randomBytes(32).toString("base64url");
          await execute("inviteMember", owner, {
            orgId: owner.orgId,
            email: invitedEmail,
            role: "editor",
          });
          const invitation = (
            await fixture.owner.query(
              "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='invitation' ORDER BY id DESC LIMIT 1",
              [invitedEmail],
            )
          ).rows[0];
          const payload = decryptProtected<EmailPayload>(
              invitation.payload_encrypted,
              service.config,
            ),
            token = new URL(payload.actionUrl!).pathname.split("/").at(-1)!;
          const accept = async (
            body: Record<string, unknown>,
            cookie?: string,
          ) =>
            service.auth.handler(
              new Request(
                `${service.config.baseURL}/v1/auth/invitations/accept`,
                {
                  method: "POST",
                  headers: {
                    origin: service.config.baseURL,
                    "content-type": "application/json",
                    ...(cookie ? { cookie } : {}),
                  },
                  body: JSON.stringify({ token, ...body }),
                },
              ),
            );
          assert.equal(
            (
              await accept({
                name: "Disposable verified Editor",
                password: invitedPassword,
              })
            ).status,
            202,
          );
          await verifyEmail(invitedEmail);
          const cookie = await signIn(invitedEmail, invitedPassword);
          assert.equal((await accept({}, cookie)).status, 200);
          const actor = await actorFor(cookie);
          assert.equal(actor.role, "editor");
          const keyResult = await execute("createPersonalKey", actor, {
            orgId: actor.orgId,
            name: "Deletion authority observer",
            scopes: ["org:read"],
            targets: [],
            unrestricted: true,
          });
          assert.ok(
            keyResult &&
              typeof keyResult === "object" &&
              "secret" in keyResult &&
              typeof keyResult.secret === "string",
          );
          const bearerRequest = () =>
            new Request(`${service.config.baseURL}/v1/context`, {
              headers: { authorization: `Bearer ${keyResult.secret}` },
            });
          assert.ok(await service.resolveActor(bearerRequest(), "api"));
          const business = { orgId: actor.orgId, confirmation: "DELETE" },
            action = AccountActionSchema.parse(
              await execute("beginAccountAction", actor, {
                orgId: actor.orgId,
                type: "delete_account",
                operationId: "deleteAccount",
                input: business,
              }),
            );
          await service.approveAction(action.id, actor);
          const admissionKey = `account-action:${action.id}`;
          const [named, completed] = await Promise.all([
            execute(
              "deleteAccount",
              actor,
              { ...business, approvalId: action.id },
              admissionKey,
            ),
            execute("completeAccountAction", actor, { id: action.id }),
          ]);
          const accepted = JobAcceptedSchema.parse(named),
            metadata = AccountActionSchema.parse(completed);
          assert.equal(metadata.state, "consumed");
          assert.deepEqual(metadata.result, accepted);
          const expired = await fixture.owner.query(
            "UPDATE rootset_control.control_mutation_replays SET expires_at=clock_timestamp()-interval '1 hour' WHERE org_id=$1 AND operation_id='deleteAccount' AND outcome->>'jobId'=$2 RETURNING operation_id",
            [actor.orgId, accepted.jobId],
          );
          assert.equal(expired.rowCount, 1);
          assert.deepEqual(
            await execute(
              "deleteAccount",
              actor,
              { ...business, approvalId: action.id },
              admissionKey,
            ),
            accepted,
          );
          await assert.rejects(
            () =>
              execute(
                "deleteAccount",
                actor,
                { ...business, approvalId: newId() },
                admissionKey,
              ),
            (error) =>
              (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
          );
          const pending = (
            await fixture.owner.query(
              "SELECT org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,state FROM rootset_control.jobs WHERE id=$1",
              [accepted.jobId],
            )
          ).rows[0];
          assert.equal(pending.org_id, actor.orgId);
          assert.equal(pending.kind, "operation");
          assert.equal(pending.operation_id, "deleteAccount");
          assert.equal(pending.state, "queued");
          assert.equal(pending.requester_id, `${actor.kind}:${actor.id}`);
          assert.equal(pending.target_type, "organisation");
          assert.equal(pending.target_id, actor.orgId);
          for (const field of [
            "kind",
            "id",
            "orgId",
            "userId",
            "credentialId",
            "clientId",
          ] as const)
            assert.equal(pending.actor[field], actor[field]);
          assert.equal(pending.input.orgId, actor.orgId);
          assert.equal(pending.input.confirmation, "DELETE");
          assert.equal(
            pending.input.operationContext.idempotencyKey,
            admissionKey,
          );
          assert.equal(pending.input.operationContext.approvalId, action.id);
          assert.equal(pending.input.operationContext.source, "browser");
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
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*)::text count FROM rootset_control.jobs WHERE operation_id='deleteAccount'",
              )
            ).rows[0].count,
            "1",
          );
          assert.equal(await runtime.jobs.runOnce(actor.orgId), true);
          const result = (
            await fixture.owner.query(
              "SELECT state,result FROM rootset_control.jobs WHERE id=$1",
              [accepted.jobId],
            )
          ).rows[0];
          assert.equal(result.state, "succeeded");
          assert.ok(result.result.deleted);
          const native = (
            await fixture.owner.query(
              "SELECT disabled,(SELECT count(*) FROM rootset_control.memberships WHERE user_id=$1)::text memberships,(SELECT count(*) FROM rootset_control.sessions WHERE user_id=$1)::text sessions,(SELECT count(*) FROM rootset_control.api_keys WHERE owner_user_id=$1 AND revoked_at IS NULL)::text active_keys FROM rootset_control.users WHERE id=$1",
              [actor.userId],
            )
          ).rows[0];
          assert.equal(native.disabled, true);
          assert.equal(native.memberships, "0");
          assert.equal(native.sessions, "0");
          assert.equal(native.active_keys, "0");
          await assert.rejects(() => service.refreshActor(actor));
          assert.equal(
            await service.resolveActor(bearerRequest(), "api"),
            null,
          );
          assert.equal((await service.refreshActor(owner)).role, "owner");
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*)::text count FROM rootset_control.operation_outcomes WHERE job_id=$1",
                [accepted.jobId],
              )
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "Organisation deletion preserves named proof fields and completion-only proof absence across both admission orderings",
        async () => {
          const business = { orgId: owner.orgId };
          const begin = async () => {
            const action = AccountActionSchema.parse(
              await execute("beginAccountAction", owner, {
                orgId: owner.orgId,
                type: "delete_organisation",
                operationId: "deleteOrganisation",
                input: business,
              }),
            );
            await service.approveAction(action.id, owner);
            return action;
          };
          const queued = async (jobId: string) =>
            (
              await fixture.owner.query(
                "SELECT id,actor,input,state FROM rootset_control.jobs WHERE id=$1",
                [jobId],
              )
            ).rows[0];
          const namedFirst = await begin(),
            namedKey = `account-action:${namedFirst.id}`,
            firstAccepted = JobAcceptedSchema.parse(
              await execute(
                "deleteOrganisation",
                owner,
                { ...business, approvalId: namedFirst.id },
                namedKey,
              ),
            ),
            firstJob = await queued(firstAccepted.jobId);
          assert.equal(firstJob.input.orgId, owner.orgId);
          assert.equal(firstJob.input.approvalId, namedFirst.id);
          assert.ok(
            firstJob.input.operationContext.admissionFields.includes(
              "approvalId",
            ),
          );
          const firstCompleted = AccountActionSchema.parse(
            await execute("completeAccountAction", owner, {
              id: namedFirst.id,
            }),
          );
          assert.equal(firstCompleted.state, "consumed");
          assert.deepEqual(firstCompleted.result, firstAccepted);
          const cancelled = await execute("cancelJob", owner, {
            orgId: owner.orgId,
            id: firstAccepted.jobId,
          });
          assert.equal((cancelled as { state: string }).state, "cancelled");
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT state FROM rootset_control.organisations WHERE id=$1",
                [owner.orgId],
              )
            ).rows[0].state,
            "active",
          );

          const completionFirst = await begin(),
            completionKey = `account-action:${completionFirst.id}`,
            completed = AccountActionSchema.parse(
              await execute("completeAccountAction", owner, {
                id: completionFirst.id,
              }),
            ),
            accepted = JobAcceptedSchema.parse(completed.result),
            job = await queued(accepted.jobId);
          assert.equal(completed.state, "consumed");
          assert.equal(Object.hasOwn(job.input, "approvalId"), false);
          assert.equal(
            job.input.operationContext.admissionFields.includes("approvalId"),
            false,
          );
          assert.equal(
            job.input.operationContext.approvalId,
            completionFirst.id,
          );
          assert.match(
            job.input.operationContext.admissionBinding,
            /^v1:[a-f0-9]{64}$/,
          );
          const [namedReplay, completedReplay] = await Promise.all([
            execute(
              "deleteOrganisation",
              owner,
              { ...business, approvalId: completionFirst.id },
              completionKey,
            ),
            execute("completeAccountAction", owner, {
              id: completionFirst.id,
            }),
          ]);
          assert.deepEqual(namedReplay, accepted);
          assert.deepEqual(
            AccountActionSchema.parse(completedReplay).result,
            accepted,
          );
          const expired = await fixture.owner.query(
            "UPDATE rootset_control.control_mutation_replays SET expires_at=clock_timestamp()-interval '1 hour' WHERE org_id=$1 AND operation_id='deleteOrganisation' AND outcome->>'jobId'=$2 RETURNING operation_id",
            [owner.orgId, accepted.jobId],
          );
          assert.equal(expired.rowCount, 1);
          assert.deepEqual(
            await execute(
              "deleteOrganisation",
              owner,
              { ...business, approvalId: completionFirst.id },
              completionKey,
            ),
            accepted,
          );
          await assert.rejects(
            () =>
              execute(
                "deleteOrganisation",
                owner,
                { ...business, approvalId: newId() },
                completionKey,
              ),
            (error) =>
              (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
          );
          await assert.rejects(
            () =>
              runtime.core.execute(
                "deleteOrganisation",
                owner,
                { ...business, approvalId: completionFirst.id },
                {
                  surface: "browser",
                  idempotencyKey: completionKey,
                  actionId: newId(),
                },
              ),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          const otherSession = await actorFor(await signIn(email, password));
          assert.notEqual(otherSession.id, owner.id);
          await assert.rejects(
            () =>
              execute(
                "deleteOrganisation",
                otherSession,
                { ...business, approvalId: completionFirst.id },
                completionKey,
              ),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*)::text count FROM rootset_control.jobs WHERE operation_id='deleteOrganisation'",
              )
            ).rows[0].count,
            "2",
          );
          assert.deepEqual(await queued(accepted.jobId), job);
          assert.equal(await runtime.jobs.runOnce(owner.orgId), true);
          const terminal = (
            await fixture.owner.query(
              "SELECT state,result FROM rootset_control.jobs WHERE id=$1",
              [accepted.jobId],
            )
          ).rows[0];
          assert.equal(terminal.state, "succeeded");
          assert.equal(terminal.result.deleted, true);
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT state FROM rootset_control.organisations WHERE id=$1",
                [owner.orgId],
              )
            ).rows[0].state,
            "deleted",
          );
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*)::text count FROM rootset_control.operation_outcomes WHERE job_id=$1",
                [accepted.jobId],
              )
            ).rows[0].count,
            "1",
          );
          await assert.rejects(() => service.refreshActor(owner));
          await assert.rejects(() => service.refreshActor(otherSession));
        },
      );
    } finally {
      await runtime.close();
      await fixture.close();
    }
  },
);
