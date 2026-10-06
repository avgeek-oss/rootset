import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { Pool, migrate } from "@rootset/database";
import {
  AccountActionSchema,
  ContextSchema,
  KeyCreatedSchema,
  ProfileSchema,
  newId,
  type Actor,
} from "@rootset/contracts";
import {
  EmailOutbox,
  decryptProtected,
  type EmailPayload,
} from "@rootset/email";
import { createIdentityService, type IdentityService } from "./index";
import { testAuthenticator } from "./webauthn-test-authenticator";
import { MetadataPaging } from "../../core/src/paging";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";

const ownerURL = process.env.ROOTSET_TEST_DATABASE_URL;
const identityURL =
  process.env.ROOTSET_TEST_IDENTITY_DATABASE_URL ??
  process.env.ROOTSET_IDENTITY_DATABASE_URL;
const baseURL = "http://localhost:6300";
function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
function request(path: string, body?: unknown, cookie?: string): Request {
  return new Request(`${baseURL}/v1/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: baseURL,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function latestVerification(
  service: IdentityService,
  pool: Pool,
  email: string,
): Promise<void> {
  const row = (
    await pool.query(
      `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-verification' ORDER BY created_at DESC LIMIT 1`,
      [email],
    )
  ).rows[0];
  assert.ok(row, "A persisted verification email is required");
  const payload = decryptProtected<EmailPayload>(
    row.payload_encrypted,
    service.config,
  );
  assert.ok(payload.actionUrl);
  const result = await service.auth.handler(new Request(payload.actionUrl!));
  assert.ok(
    result.status === 200 || result.status === 302,
    "Email verification completes",
  );
}
async function login(
  service: IdentityService,
  email: string,
  password: string,
): Promise<{
  response: Response;
  body: Record<string, unknown>;
  cookie: string;
}> {
  const response = await service.auth.handler(
    request("/sign-in/email", { email, password }),
  );
  return {
    response,
    body: (await response.clone().json()) as Record<string, unknown>,
    cookie: cookies(response),
  };
}

test(
  "AUTH-07 AUTH-08 UI-shaped sign-out approvals preserve or revoke delegated authority with an immutable boolean",
  { skip: !ownerURL || !identityURL },
  async () => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    };
    const service = createIdentityService(config);
    const email = `signout-${newId().toLowerCase()}@example.test`;
    const password = randomBytes(32).toString("base64url");
    const execute = (id: string, actor: Actor, input: unknown) =>
      service.execute(id, actor, input, { idempotencyKey: newId() });
    const freshSession = async () => {
      const session = await login(service, email, password);
      assert.equal(session.response.status, 200);
      return (await service.resolveActor(
        request("/get-session", undefined, session.cookie),
        "browser",
      ))!;
    };
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "Sign-out approval fixture",
        email,
        password,
        organisationName: "Disposable sign-out approval fixture",
      });
      await latestVerification(service, fixture.identity, email);
      const actor = await freshSession();
      const key = KeyCreatedSchema.parse(
        await execute("createPersonalKey", actor, {
          orgId: actor.orgId,
          name: "Sign-out delegated key",
        }),
      );
      assert.ok(key.secret);
      const bearer = () =>
        service.resolveActor(
          new Request(`${baseURL}/v1/me`, {
            headers: { authorization: `Bearer ${key.secret}` },
          }),
          "api",
        );
      // Token issuance is exercised by the HTTP/MCP suite; this grant checks persisted revocation state.
      const grantId = newId();
      await fixture.owner.query(
        `INSERT INTO rootset_control.oauth_grants(id,org_id,user_id,client_id,scopes,actor,resource) VALUES($1,$2,$3,'signout-fixture-client',ARRAY['rows:read'],$4,$5)`,
        [
          grantId,
          actor.orgId,
          actor.userId,
          JSON.stringify({
            ...actor,
            kind: "oauth",
            id: grantId,
            credentialId: grantId,
            clientId: "signout-fixture-client",
          }),
          `${baseURL}/mcp`,
        ],
      );
      await assert.rejects(
        () =>
          execute("beginAccountAction", actor, {
            type: "sign_out_everywhere",
            operationId: "signOutEverywhere",
            input: { revokeDelegated: "false" },
          }),
        (error) => (error as { code: string }).code === "VALIDATION_FAILED",
      );
      const preserve = AccountActionSchema.parse(
        await execute("beginAccountAction", actor, {
          type: "sign_out_everywhere",
          operationId: "signOutEverywhere",
          input: { revokeDelegated: false },
        }),
      );
      await service.approveAction(preserve.id, actor);
      await assert.rejects(
        () =>
          service.execute(
            "signOutEverywhere",
            actor,
            { revokeDelegated: true },
            { actionId: preserve.id, idempotencyKey: newId() },
          ),
        (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
      );
      assert.ok(await service.refreshActor(actor));
      assert.equal(
        (
          await fixture.owner.query(
            `SELECT consumed_at FROM rootset_control.account_actions WHERE id=$1`,
            [preserve.id],
          )
        ).rows[0].consumed_at,
        null,
      );
      const preserved = AccountActionSchema.parse(
        await execute("completeAccountAction", actor, { id: preserve.id }),
      );
      assert.deepEqual(preserved.result, { revoked: true });
      await assert.rejects(() => service.refreshActor(actor));
      assert.ok(await bearer());
      assert.equal(
        (
          await fixture.owner.query(
            `SELECT revoked_at FROM rootset_control.oauth_grants WHERE id=$1`,
            [grantId],
          )
        ).rows[0].revoked_at,
        null,
      );
      const renewed = await freshSession();
      const secondSession = await freshSession();
      const revoke = AccountActionSchema.parse(
        await execute("beginAccountAction", renewed, {
          type: "sign_out_everywhere",
          operationId: "signOutEverywhere",
          input: { revokeDelegated: true },
        }),
      );
      await service.approveAction(revoke.id, renewed);
      const revoked = AccountActionSchema.parse(
        await execute("completeAccountAction", renewed, { id: revoke.id }),
      );
      assert.deepEqual(revoked.result, { revoked: true });
      await assert.rejects(() => service.refreshActor(renewed));
      await assert.rejects(() => service.refreshActor(secondSession));
      assert.equal(await bearer(), null);
      assert.equal(
        (
          await fixture.owner.query(
            `SELECT count(*) FROM rootset_control.sessions WHERE user_id=$1`,
            [actor.userId],
          )
        ).rows[0].count,
        "0",
      );
      assert.ok(
        (
          await fixture.owner.query(
            `SELECT revoked_at FROM rootset_control.oauth_grants WHERE id=$1`,
            [grantId],
          )
        ).rows[0].revoked_at,
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "ACC/AUTH/KEY real PostgreSQL identity, invitation, MFA, revocation and immutable approvals",
  { skip: !ownerURL || !identityURL, timeout: 120000 },
  async (t) => {
    const databaseName = `rootset_identity_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({ connectionString: ownerURL });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const ownerAddress = new URL(ownerURL!),
      identityAddress = new URL(identityURL!);
    ownerAddress.pathname = `/${databaseName}`;
    identityAddress.pathname = `/${databaseName}`;
    const owner = new Pool({ connectionString: ownerAddress.href });
    const pool = new Pool({ connectionString: identityAddress.href, max: 12 });
    try {
      await migrate(owner);
      const config = {
        pool,
        baseURL,
        secret: randomBytes(32).toString("hex"),
        bootstrapSecret: randomBytes(32).toString("hex"),
        keyHashSecret: randomBytes(32).toString("hex"),
        encryptionKeys: { v1: randomBytes(32).toString("base64") },
        activeEncryptionKeyId: "v1",
      };
      const service = createIdentityService(config);
      const execute = (
        operationId: string,
        current: Actor,
        value: unknown,
        context: Parameters<IdentityService["execute"]>[3] = {},
      ) =>
        service.execute(operationId, current, value, {
          idempotencyKey: newId(),
          ...context,
        });
      service.setPaging(new MetadataPaging(randomBytes(32).toString("hex")));
      let password = "Rootset verification password 2026";
      let email = "owner@example.test";
      let actor: Actor;
      let cookie = "";
      let orgId = "";
      await t.test(
        "ACC-01 concurrent setup creates one pending admin and retries reconcile",
        async () => {
          const input = {
            bootstrapSecret: config.bootstrapSecret,
            name: "Rootset Admin",
            email,
            password,
            organisationName: "Identity verification",
            preferences: {
              timezone: "Asia/Kolkata",
              dateFormat: "DD/MM/YYYY",
              timeFormat: "12h",
            },
          };
          await assert.rejects(() =>
            service.claimSetup({ ...input, bootstrapSecret: "wrong-secret" }),
          );
          await assert.rejects(() =>
            service.claimSetup({
              ...input,
              preferences: { ...input.preferences, timezone: "invalid/zone" },
            }),
          );
          await assert.rejects(() =>
            service.claimSetup({
              ...input,
              preferences: { ...input.preferences, theme: "dark" },
            }),
          );
          assert.deepEqual(await service.setupStatus(), {
            claimed: false,
            verified: false,
          });
          const attempts = await Promise.allSettled([
            service.claimSetup(input),
            service.claimSetup(input),
          ]);
          assert.equal(
            attempts.filter((r) => r.status === "fulfilled").length,
            2,
            JSON.stringify(
              attempts
                .filter((r) => r.status === "rejected")
                .map((r) =>
                  r.status === "rejected"
                    ? {
                        code: (r.reason as { code?: string }).code,
                        message: (r.reason as Error).message,
                      }
                    : null,
                ),
            ),
          );
          const claimed = (
            await owner.query(
              `SELECT org_id,user_id,claim_digest FROM rootset_control.bootstrap`,
            )
          ).rows[0];
          orgId = claimed.org_id;
          assert.deepEqual(
            (
              await owner.query(
                `SELECT timezone,date_format,time_format,locale,theme FROM rootset_control.user_preferences WHERE user_id=$1`,
                [claimed.user_id],
              )
            ).rows[0],
            {
              timezone: "Asia/Kolkata",
              date_format: "DD/MM/YYYY",
              time_format: "12h",
              locale: "en",
              theme: "system",
            },
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.organisations`,
              )
            ).rows[0].count,
            "1",
          );
          assert.deepEqual(await service.setupStatus(), {
            claimed: true,
            verified: false,
          });
          const refused = await login(service, email, password);
          assert.equal(refused.response.ok, false);
          await latestVerification(service, pool, email);
          assert.deepEqual(await service.setupStatus(), {
            claimed: true,
            verified: true,
          });
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          cookie = session.cookie;
          actor = (await service.resolveActor(
            request("/get-session", undefined, cookie),
            "browser",
          ))!;
          assert.equal(actor.role, "admin");
          ContextSchema.parse(await execute("getContext", actor, {}));
          ProfileSchema.parse(await execute("getProfile", actor, {}));
          await assert.rejects(() =>
            service.claimSetup({ ...input, email: "new@example.test" }),
          );
          await assert.rejects(() =>
            service.claimSetup({
              ...input,
              preferences: { ...input.preferences, timeFormat: "24h" },
            }),
          );
        },
      );
      await t.test(
        "API09 identity mutation retries dedupe invitations/actions, reject changed input and recheck live sessions",
        async () => {
          await assert.rejects(
            () =>
              service.execute("updateProfile", actor, {
                name: "Missing replay key",
              }),
            (error) => (error as { code: string }).code === "VALIDATION_FAILED",
          );
          const invitation = {
            orgId,
            email: "replay-invitation@example.test",
            role: "viewer",
          };
          const invitationContext = { idempotencyKey: newId() };
          const outcomes = await Promise.all(
            Array.from({ length: 4 }, () =>
              execute("inviteMember", actor, invitation, invitationContext),
            ),
          );
          for (const outcome of outcomes)
            assert.deepEqual(outcome, outcomes[0]);
          await assert.rejects(
            () =>
              execute(
                "inviteMember",
                actor,
                { ...invitation, email: "changed-replay@example.test" },
                invitationContext,
              ),
            (error) =>
              (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.invitations WHERE email=$1",
                [invitation.email],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.email_outbox WHERE to_address=$1 AND template='invitation'",
                [invitation.email],
              )
            ).rows[0].count,
            1,
          );
          const actionContext = { idempotencyKey: newId() },
            actionInput = {
              operationId: "changePassword",
              type: "change_password",
              input: {
                currentPassword: password,
                newPassword: "Replay private password 2026",
              },
            };
          const actions = await Promise.all([
            execute("beginAccountAction", actor, actionInput, actionContext),
            execute("beginAccountAction", actor, actionInput, actionContext),
          ]);
          assert.deepEqual(actions[0], actions[1]);
          AccountActionSchema.parse(actions[0]);
          const privateReceipts = (
            await owner.query(
              "SELECT input_digest,outcome FROM rootset_control.control_mutation_replays WHERE operation_id='beginAccountAction'",
            )
          ).rows;
          assert.equal(
            JSON.stringify(privateReceipts).includes(
              actionInput.input.currentPassword,
            ),
            false,
          );
          assert.equal(
            JSON.stringify(privateReceipts).includes(
              actionInput.input.newPassword,
            ),
            false,
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.account_actions WHERE id=$1",
                [(actions[0] as { id: string }).id],
              )
            ).rows[0].count,
            1,
          );
          const anotherSession = await login(service, email, password);
          assert.ok(anotherSession.response.ok);
          const sessionActor = (await service.resolveActor(
            request("/get-session", undefined, anotherSession.cookie),
            "browser",
          ))!;
          const currentInput = {
              ...invitation,
              email: "revoked-replay@example.test",
            },
            currentContext = { idempotencyKey: newId() };
          await execute(
            "inviteMember",
            sessionActor,
            currentInput,
            currentContext,
          );
          await execute("revokeSession", actor, { id: sessionActor.id });
          await assert.rejects(() =>
            execute("inviteMember", sessionActor, currentInput, currentContext),
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.invitations WHERE email=$1",
                [currentInput.email],
              )
            ).rows[0].count,
            1,
          );
          let queued = 0;
          await service.withOperationApproval(
            actor,
            "restoreBackup",
            { mode: "new" },
            { idempotencyKey: newId() },
            async () => {
              queued++;
              return {};
            },
          );
          assert.equal(queued, 1);
          await assert.rejects(() =>
            service.withOperationApproval(
              {
                ...actor,
                kind: "oauth",
                id: newId(),
                credentialId: newId(),
                clientId: "missing-grant",
              },
              "restoreBackup",
              { mode: "replace" },
              {},
              async () => ({}),
            ),
          );
        },
      );
      await t.test(
        "KEY-01 KEY-06 key secrets display once with safe metadata idempotency",
        async () => {
          const input = {
            orgId,
            name: "Read integration",
          };
          const context = { idempotencyKey: newId() };
          const created = KeyCreatedSchema.parse(
            await execute("createPersonalKey", actor, input, context),
          );
          assert.ok(created.secret);
          assert.equal(created.secret!.slice(31).length, 43);
          const stored = (
            await owner.query(
              `SELECT secret_hash FROM rootset_control.api_keys WHERE id=$1`,
              [created.key.id],
            )
          ).rows[0];
          assert.notEqual(stored.secret_hash, created.secret);
          const replay = KeyCreatedSchema.parse(
            await execute("createPersonalKey", actor, input, context),
          );
          assert.equal(replay.secret, undefined);
          assert.equal(replay.key.id, created.key.id);
          await assert.rejects(
            () =>
              execute(
                "createPersonalKey",
                actor,
                { ...input, name: "Changed input" },
                context,
              ),
            (error) =>
              (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
          );
          const keyActor = await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${created.secret}` },
            }),
            "api",
          );
          assert.ok(keyActor);
          assert.equal(keyActor!.kind, "personal_key");
          assert.deepEqual(
            await service.withOperationApproval(
              keyActor!,
              "restoreBackup",
              { mode: "new" },
              { idempotencyKey: newId() },
              async () => ({ admitted: true }),
            ),
            { admitted: true },
          );
          await assert.rejects(
            () =>
              service.withOperationApproval(
                keyActor!,
                "restoreBackup",
                { mode: "replace" },
                { idempotencyKey: newId() },
                async () => ({ admitted: true }),
              ),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          await execute("revokePersonalKey", actor, {
            id: created.key.id,
          });
          assert.equal(
            await service.resolveActor(
              new Request(`${baseURL}/v1/me`, {
                headers: { authorization: `Bearer ${created.secret}` },
              }),
              "api",
            ),
            null,
          );
        },
      );
      await t.test(
        "AUTH-07 action is immutable, client-bound, one-use and replay metadata only",
        async () => {
          const input = {
            name: "Approved key",
          };
          const begun = AccountActionSchema.parse(
            await execute("beginAccountAction", actor, {
              type: "create_key",
              operationId: "createPersonalKey",
              input,
            }),
          );
          assert.equal(begun.state, "pending");
          await assert.rejects(() =>
            execute("completeAccountAction", actor, { id: begun.id }),
          );
          AccountActionSchema.parse(
            await service.approveAction(begun.id, actor),
          );
          await assert.rejects(() =>
            execute(
              "createPersonalKey",
              actor,
              { ...input, name: "Tampered" },
              { idempotencyKey: newId(), actionId: begun.id },
            ),
          );
          const completed = AccountActionSchema.parse(
            await execute("completeAccountAction", actor, {
              id: begun.id,
            }),
          );
          assert.equal(completed.state, "consumed");
          assert.ok((completed.result as { secret?: string }).secret);
          const replay = AccountActionSchema.parse(
            await execute("completeAccountAction", actor, {
              id: begun.id,
            }),
          );
          assert.equal(
            (replay.result as { secret?: string }).secret,
            undefined,
          );
          const db = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.account_actions WHERE id=$1`,
              [begun.id],
            )
          ).rows[0];
          assert.equal(db.payload_encrypted.includes("Approved key"), false);
        },
      );
      let viewerActor: Actor;
      let viewerCookie = "";
      let viewerUserId = "";
      await t.test(
        "ACC-06 invitations enforce verified email, role and one-use membership",
        async () => {
          const email = "viewer@example.test";
          const invite = (await execute("inviteMember", actor, {
            orgId,
            email,
            role: "viewer",
          })) as { id: string };
          assert.ok(invite.id);
          const outbox = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='invitation' ORDER BY created_at DESC LIMIT 1`,
              [email],
            )
          ).rows[0];
          const payload = decryptProtected<EmailPayload>(
            outbox.payload_encrypted,
            config,
          );
          const token = new URL(payload.actionUrl!).pathname.split("/").at(-1)!;
          const signup = await service.auth.handler(
            request("/invitations/accept", { token, name: "Viewer", password }),
          );
          assert.equal(signup.status, 202);
          await latestVerification(service, pool, email);
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          viewerCookie = session.cookie;
          const accepted = await service.auth.handler(
            request("/invitations/accept", { token }, viewerCookie),
          );
          assert.ok(accepted.ok);
          const replay = await service.auth.handler(
            request("/invitations/accept", { token }, viewerCookie),
          );
          assert.ok(replay.ok);
          viewerActor = (await service.resolveActor(
            request("/get-session", undefined, viewerCookie),
            "browser",
          ))!;
          assert.equal(viewerActor.role, "viewer");
          viewerUserId = viewerActor.userId!;
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.memberships WHERE user_id=$1 AND org_id=$2`,
                [viewerUserId, orgId],
              )
            ).rows[0].count,
            "1",
          );
          await assert.rejects(() =>
            execute("inviteMember", viewerActor, {
              orgId,
              email: "another@example.test",
              role: "admin",
            }),
          );
          const adminInvitation = (await execute("inviteMember", actor, {
            orgId,
            email: "future-admin@example.test",
            role: "admin",
          })) as { role: string };
          assert.equal(adminInvitation.role, "admin");
          const wrong = await service.auth.handler(
            request("/invitations/accept", { token }, cookie),
          );
          assert.equal(wrong.status, 403);
        },
      );
      await t.test(
        "Shared team data preserves member authority, version checks and pending invitation pagination",
        async () => {
          const page = (await execute("listMembers", actor, { orgId })) as {
            data: Array<{
              id: string;
              userId: string;
              version: string;
              name: string;
              role: string;
              twoFactorEnabled: boolean;
            }>;
          };
          const member = page.data.find(
            (item) => item.userId === viewerUserId,
          )!;
          const admin = page.data.find((item) => item.userId === actor.userId)!;
          assert.equal(member.twoFactorEnabled, false);
          const updated = (await execute("updateMember", actor, {
            orgId,
            id: member.id,
            expectedVersion: member.version,
            name: "Updated Viewer",
          })) as {
            name: string;
            role: string;
            version: string;
            twoFactorEnabled: boolean;
          };
          assert.equal(updated.name, "Updated Viewer");
          assert.equal(updated.role, "viewer");
          assert.equal(updated.version, String(BigInt(member.version) + 1n));
          assert.equal(updated.twoFactorEnabled, false);
          await assert.rejects(() =>
            execute("updateMember", actor, {
              orgId,
              id: member.id,
              expectedVersion: member.version,
              name: "Stale name",
              role: "editor",
            }),
          );
          await assert.rejects(() =>
            execute("updateMember", viewerActor, {
              orgId,
              id: member.id,
              expectedVersion: updated.version,
              name: "Unauthorised name",
            }),
          );
          await assert.rejects(() =>
            execute("updateMember", actor, {
              orgId,
              id: admin.id,
              expectedVersion: admin.version,
              name: "Rejected name",
              role: "viewer",
            }),
          );
          assert.equal(
            ProfileSchema.parse(await execute("getProfile", viewerActor, {}))
              .name,
            "Updated Viewer",
          );
          assert.equal(
            ProfileSchema.parse(await execute("getProfile", actor, {})).name,
            admin.name,
          );
          const expired = (await execute("inviteMember", actor, {
            orgId,
            email: "expired-team@example.test",
            role: "viewer",
          })) as { id: string };
          await owner.query(
            `UPDATE rootset_control.invitations SET expires_at=now()-interval '1 second' WHERE id=$1`,
            [expired.id],
          );
          await execute("inviteMember", actor, {
            orgId,
            email: "pending-team@example.test",
            role: "editor",
          });
          const pending = (await execute("listInvitations", actor, {
            orgId,
            state: "pending",
            limit: 1,
          })) as {
            data: Array<{ id: string; state: string }>;
            nextCursor: string;
          };
          assert.equal(pending.data.length, 1);
          assert.equal(pending.data[0]!.state, "pending");
          assert.ok(pending.nextCursor);
          const next = (await execute("listInvitations", actor, {
            orgId,
            state: "pending",
            limit: 1,
            cursor: pending.nextCursor,
          })) as { data: Array<{ id: string; state: string }> };
          assert.equal(next.data.length, 1);
          assert.notEqual(next.data[0]!.id, pending.data[0]!.id);
          await assert.rejects(() =>
            execute("listInvitations", actor, {
              orgId,
              state: "expired",
              limit: 1,
              cursor: pending.nextCursor,
            }),
          );
          const expiredPage = (await execute("listInvitations", actor, {
            orgId,
            state: "expired",
          })) as { data: Array<{ id: string; state: string }> };
          assert.ok(
            expiredPage.data.some(
              (item) => item.id === expired.id && item.state === "expired",
            ),
          );
        },
      );
      await t.test(
        "ACC-08 verified email change handles uniqueness, one-use tokens, and session revocation",
        async () => {
          const name = "N".repeat(255);
          assert.equal(
            ProfileSchema.parse(await execute("updateProfile", actor, { name }))
              .name,
            name,
          );
          await execute("changeEmail", actor, {
            newEmail: "viewer@example.test",
          });
          let change = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='email-change-verification' ORDER BY created_at DESC LIMIT 1`,
            )
          ).rows[0];
          let payload = decryptProtected<EmailPayload>(
            change.payload_encrypted,
            config,
          );
          const conflict = await service.auth.handler(
            request(
              "/email-change/confirm",
              { token: new URL(payload.actionUrl!).searchParams.get("token") },
              cookie,
            ),
          );
          assert.equal(conflict.status, 409);
          assert.equal(
            ProfileSchema.parse(await execute("getProfile", actor, {})).email,
            email,
          );
          const pending = await service.auth.handler(
            request("/email-change", undefined, cookie),
          );
          assert.equal(pending.status, 200);
          assert.equal(pending.headers.get("cache-control"), "no-store");
          assert.equal(
            (await pending.json()).pending.email,
            "viewer@example.test",
          );
          const otherPending = await service.auth.handler(
            request("/email-change", undefined, viewerCookie),
          );
          assert.deepEqual(await otherPending.json(), { pending: null });
          assert.equal(
            (await service.auth.handler(request("/email-change"))).status,
            401,
          );
          const deleteRequest = new Request(`${baseURL}/v1/auth/email-change`, {
            method: "DELETE",
            headers: { cookie, origin: baseURL },
          });
          const foreignOrigin = new Request(deleteRequest, {
            headers: { cookie, origin: "https://other.example" },
          });
          assert.equal((await service.auth.handler(foreignOrigin)).status, 403);
          const cancelled = await service.auth.handler(deleteRequest);
          assert.equal(cancelled.status, 200);
          assert.deepEqual(await cancelled.json(), { pending: null });
          const cancelledToken = new URL(payload.actionUrl!).searchParams.get(
            "token",
          );
          assert.equal(
            (
              await service.auth.handler(
                request(
                  "/email-change/confirm",
                  { token: cancelledToken },
                  cookie,
                ),
              )
            ).status,
            410,
          );
          const afterCancel = await service.auth.handler(
            request("/email-change", undefined, cookie),
          );
          assert.deepEqual(await afterCancel.json(), { pending: null });
          const nextEmail = "verified-owner@example.test";
          await execute("changeEmail", actor, { newEmail: nextEmail });
          change = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='email-change-verification' ORDER BY created_at DESC LIMIT 1`,
            )
          ).rows[0];
          payload = decryptProtected<EmailPayload>(
            change.payload_encrypted,
            config,
          );
          const token = new URL(payload.actionUrl!).searchParams.get("token");
          const confirmed = await service.auth.handler(
            request("/email-change/confirm", { token }, cookie),
          );
          assert.ok(confirmed.ok);
          await assert.rejects(
            () => service.refreshActor(actor),
            (error) => (error as { code: string }).code === "UNAUTHENTICATED",
          );
          const replay = await service.auth.handler(
            request("/email-change/confirm", { token }),
          );
          assert.equal(replay.status, 410);
          email = nextEmail;
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          cookie = session.cookie;
          actor = (await service.resolveActor(
            request("/get-session", undefined, cookie),
            "browser",
          ))!;
          assert.equal(
            ProfileSchema.parse(await execute("getProfile", actor, {})).email,
            email,
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.email_outbox WHERE template='email-changed'`,
              )
            ).rows[0].count,
            "2",
          );
        },
      );
      await t.test(
        "ACC-03 metadata pages enforce cursor request and principal binding",
        async () => {
          const first = (await execute("listMembers", actor, {
            orgId,
            limit: 1,
          })) as {
            data: Array<{ id: string }>;
            hasMore: boolean;
            nextCursor: string;
          };
          assert.equal(first.data.length, 1);
          assert.equal(first.hasMore, true);
          assert.ok(first.nextCursor);
          const second = (await execute("listMembers", actor, {
            orgId,
            limit: 1,
            cursor: first.nextCursor,
          })) as { data: Array<{ id: string }>; hasMore: boolean };
          assert.equal(second.data.length, 1);
          assert.equal(second.hasMore, false);
          assert.notEqual(first.data[0]!.id, second.data[0]!.id);
          await assert.rejects(
            () =>
              execute("listMembers", actor, {
                orgId,
                limit: 2,
                cursor: first.nextCursor,
              }),
            (error) => (error as { code: string }).code === "CURSOR_INVALID",
          );
          await assert.rejects(
            () =>
              execute("listInvitations", actor, {
                orgId,
                limit: 1,
                cursor: first.nextCursor,
              }),
            (error) => (error as { code: string }).code === "CURSOR_INVALID",
          );
          const key = KeyCreatedSchema.parse(
            await execute(
              "createPersonalKey",
              actor,
              {
                name: "Metadata actor",
              },
              { idempotencyKey: newId() },
            ),
          );
          const principal = (await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${key.secret}` },
            }),
            "api",
          ))!;
          await assert.rejects(
            () =>
              execute("listMembers", principal, {
                orgId,
                limit: 1,
                cursor: first.nextCursor,
              }),
            (error) => (error as { code: string }).code === "CURSOR_INVALID",
          );
        },
      );
      await t.test(
        "ACC-05 last verified Admin cannot be demoted or removed",
        async () => {
          const member = (
            await owner.query(
              `SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2`,
              [orgId, actor.userId],
            )
          ).rows[0];
          const attempts = await Promise.allSettled([
            execute("updateMember", actor, {
              orgId,
              id: member.id,
              role: "viewer",
              expectedVersion: String(member.version),
            }),
            execute("removeMember", actor, {
              orgId,
              id: member.id,
              expectedVersion: String(member.version),
            }),
          ]);
          assert.equal(
            attempts.every((r) => r.status === "rejected"),
            true,
          );
          assert.equal(
            (
              await owner.query(
                `SELECT role FROM rootset_control.memberships WHERE id=$1`,
                [member.id],
              )
            ).rows[0].role,
            "admin",
          );
        },
      );
      await t.test(
        "AUTH-08 scheduled policy authority outlives logout while manual session authority is revoked",
        async () => {
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          const principal = (await service.resolveActor(
            request("/get-session", undefined, session.cookie),
            "browser",
          ))!;
          await execute("revokeSession", actor, { id: principal.id });
          await assert.rejects(
            () => service.refreshActor(principal),
            (error) => (error as { code: string }).code === "UNAUTHENTICATED",
          );
          const policyActor = await service.refreshPolicyActor(principal);
          assert.equal(policyActor.userId, actor.userId);
          assert.equal(policyActor.role, "admin");
          assert.ok(policyActor.scopes.includes("backups:manage"));
        },
      );
      await t.test(
        "AUTH-03 AUTH-04 verified passkeys gate password sign-in and recovery code races are single-use",
        async () => {
          const authenticator = testAuthenticator();
          const options = await service.auth.handler(
            request("/passkey/generate-register-options", undefined, cookie),
          );
          assert.ok(options.ok);
          const challenge = ((await options.json()) as { challenge: string })
            .challenge;
          const registered = await service.auth.handler(
            request(
              "/passkey/verify-registration",
              {
                name: "Fixture passkey",
                response: authenticator.registration(challenge, baseURL),
              },
              [cookie, cookies(options)].join("; "),
            ),
          );
          assert.ok(registered.ok, await registered.clone().text());
          const data = (await registered.json()) as { recoveryCodes: string[] };
          assert.equal(data.recoveryCodes.length, 10);
          const factor = (
            await owner.query(
              `SELECT code_hashes FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
              [actor.userId],
            )
          ).rows[0];
          assert.equal(
            factor.code_hashes.some((hash: string) =>
              data.recoveryCodes.includes(hash),
            ),
            false,
          );
          assert.ok(
            factor.code_hashes.every((hash: string) =>
              /^[a-f0-9]{64}$/.test(hash),
            ),
          );
          const [a, b] = await Promise.all([
            login(service, email, password),
            login(service, email, password),
          ]);
          assert.equal(a.body.twoFactorRedirect, true);
          assert.deepEqual(a.body.twoFactorMethods, ["passkey"]);
          assert.equal(b.body.twoFactorRedirect, true);
          assert.equal(
            await service.resolveActor(
              request("/get-session", undefined, a.cookie),
              "browser",
            ),
            null,
          );
          const results = await Promise.all([
            service.auth.handler(
              request(
                "/passkey/verify-recovery-code",
                { code: data.recoveryCodes[0] },
                a.cookie,
              ),
            ),
            service.auth.handler(
              request(
                "/passkey/verify-recovery-code",
                { code: data.recoveryCodes[0] },
                b.cookie,
              ),
            ),
          ]);
          assert.equal(results.filter((r) => r.ok).length, 1);
        },
      );
      await t.test(
        "AUTH-01 AUTH-04 password reset changes credential while preserving enabled MFA",
        async () => {
          const reset = await service.auth.handler(
            request("/request-password-reset", {
              email,
              redirectTo: `${baseURL}/reset-password`,
            }),
          );
          assert.ok(reset.ok);
          const row = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='password-reset' ORDER BY created_at DESC LIMIT 1`,
              [email],
            )
          ).rows[0];
          const payload = decryptProtected<EmailPayload>(
            row.payload_encrypted,
            config,
          );
          const token = new URL(payload.actionUrl!).pathname.split("/").at(-1);
          const nextPassword = "Changed Rootset password after verified reset";
          const changed = await service.auth.handler(
            request("/reset-password", { token, newPassword: nextPassword }),
          );
          assert.ok(changed.ok);
          password = nextPassword;
          assert.equal(
            (
              await owner.query(
                `SELECT EXISTS(SELECT 1 FROM rootset_control.auth_passkeys WHERE user_id=$1) has_passkey`,
                [actor.userId],
              )
            ).rows[0].has_passkey,
            true,
          );
          await assert.rejects(
            () => service.refreshActor(actor),
            (error) => (error as { code: string }).code === "UNAUTHENTICATED",
          );
          const loginPending = await login(service, email, password);
          assert.equal(loginPending.body.twoFactorRedirect, true);
          assert.equal(
            await service.resolveActor(
              request("/get-session", undefined, loginPending.cookie),
              "browser",
            ),
            null,
          );
        },
      );
      await t.test(
        "AUTH-10 admin recovery requires a reason and revokes factors and credentials",
        async () => {
          const originalSession = actor.id;
          await assert.rejects(() =>
            service.recoverUser(actor.userId!, { reason: "" }),
          );
          await service.recoverUser(actor.userId!, {
            reason: "Fixture recovery ceremony",
          });
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "0",
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.sessions WHERE id=$1`,
                [originalSession],
              )
            ).rows[0].count,
            "0",
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.api_keys WHERE user_id=$1 AND revoked_at IS NULL`,
                [actor.userId],
              )
            ).rows[0].count,
            "0",
          );
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          cookie = session.cookie;
          actor = (await service.resolveActor(
            request("/get-session", undefined, cookie),
            "browser",
          ))!;
          assert.equal(actor.role, "admin");
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-recovery'`,
                [email],
              )
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "AUTH-13 SMTP outage retries persistent encrypted outbox and event dedupe survives worker restart",
        async () => {
          const eventId = newId();
          const denied = new EmailOutbox(pool, {
            ...config,
            smtp: { host: "127.0.0.1", port: 1, from: "rootset@example.test" },
          });
          const original = await denied.enqueue(pool, {
            template: "account-recovery",
            to: "delivery@example.test",
            payload: { name: "Delivery Test" },
            dedupeKey: eventId,
          });
          const same = await denied.enqueue(pool, {
            template: "account-recovery",
            to: "delivery@example.test",
            payload: { name: "Delivery Test" },
            dedupeKey: eventId,
          });
          assert.equal(original, same);
          await owner.query(
            `UPDATE rootset_control.email_outbox SET next_attempt_at=now()+interval '1 day' WHERE id<>$1`,
            [original],
          );
          assert.equal(await denied.deliverNext(), true);
          const failed = (
            await owner.query(
              `SELECT state,attempts,last_error,payload_encrypted FROM rootset_control.email_outbox WHERE id=$1`,
              [original],
            )
          ).rows[0];
          assert.equal(failed.state, "pending");
          assert.equal(failed.attempts, 1);
          assert.equal(failed.last_error, "SMTP delivery failed");
          assert.ok(failed.payload_encrypted);
          const smtpHost = process.env.ROOTSET_SMTP_HOST;
          const smtpPort = Number(process.env.ROOTSET_SMTP_PORT);
          const smtpFrom = process.env.ROOTSET_EMAIL_FROM;
          assert.ok(smtpHost, "The mail fixture needs a configured SMTP host");
          assert.ok(
            Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535,
            "The mail fixture needs a configured SMTP port",
          );
          assert.ok(smtpFrom, "The mail fixture needs a configured sender");
          const restarted = new EmailOutbox(pool, {
            ...config,
            smtp: {
              host: smtpHost,
              port: smtpPort,
              secure: process.env.ROOTSET_SMTP_SECURE === "true",
              from: smtpFrom,
              user: process.env.ROOTSET_SMTP_USER,
              password: process.env.ROOTSET_SMTP_PASSWORD,
            },
          });
          await owner.query(
            `UPDATE rootset_control.email_outbox SET next_attempt_at=now() WHERE id=$1`,
            [original],
          );
          assert.equal(await restarted.deliverNext(), true);
          const sent = (
            await owner.query(
              `SELECT state,attempts,payload_encrypted,provider_id FROM rootset_control.email_outbox WHERE id=$1`,
              [original],
            )
          ).rows[0];
          assert.equal(sent.state, "sent");
          assert.equal(sent.attempts, 2);
          assert.equal(sent.payload_encrypted, "");
          assert.ok(sent.provider_id);
          const later = await restarted.enqueue(pool, {
            template: "account-recovery",
            to: "delivery@example.test",
            payload: { name: "Delivery Test" },
            dedupeKey: newId(),
          });
          assert.notEqual(later, original);
        },
      );
    } finally {
      await pool.end();
      await owner.end();
      await admin.query(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
  },
);

test(
  "personal key issuance, rotation, live role changes and concurrent last-admin protection share one installation",
  { skip: !ownerURL || !identityURL, timeout: 60000 },
  async () => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    };
    const service = createIdentityService(config),
      email = `personal-${newId().toLowerCase()}@example.test`,
      password = randomBytes(32).toString("base64url");
    const execute = (
      operation: string,
      actor: Actor,
      input: unknown,
      key = newId(),
    ) => service.execute(operation, actor, input, { idempotencyKey: key });
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "Installation Admin",
        email,
        password,
        organisationName: "Personal key lifecycle",
      });
      await latestVerification(service, fixture.identity, email);
      const signedIn = await login(service, email, password);
      assert.equal(signedIn.response.status, 200);
      const admin = (await service.resolveActor(
        request("/get-session", undefined, signedIn.cookie),
        "browser",
      ))!;
      assert.equal(admin.role, "admin");
      assert.equal(
        (
          await service.auth.handler(
            request("/organisations", undefined, signedIn.cookie),
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await service.auth.handler(
            request("/organisation", { orgId: newId() }, signedIn.cookie),
          )
        ).status,
        404,
      );
      const expiry = new Date(Date.now() + 3600000).toISOString(),
        input = { name: "Inherits current role", expiresAt: expiry },
        key = newId();
      const issued = (
        await Promise.all([
          execute("createPersonalKey", admin, input, key),
          execute("createPersonalKey", admin, input, key),
        ])
      ).map((value) => KeyCreatedSchema.parse(value));
      assert.equal(issued[0]!.key.id, issued[1]!.key.id);
      assert.equal(issued.filter((value) => value.secret).length, 1);
      const first = issued.find((value) => value.secret)!;
      assert.equal(first.key.userId, admin.userId);
      assert.equal(Object.hasOwn(first.key, "scopes"), false);
      assert.equal(Object.hasOwn(first.key, "targets"), false);
      await assert.rejects(
        () =>
          execute("createPersonalKey", admin, {
            name: "Removed authority selector",
            scopes: ["rows:write"],
          }),
        (error) => (error as { code: string }).code === "VALIDATION_FAILED",
      );
      const rotated = KeyCreatedSchema.parse(
        await execute("rotatePersonalKey", admin, { id: first.key.id }),
      );
      assert.equal(rotated.key.expiresAt, expiry);
      assert.equal(
        await service.resolveActor(
          new Request(`${baseURL}/v1/me`, {
            headers: { authorization: `Bearer ${first.secret}` },
          }),
        ),
        null,
      );
      const personal = (await service.resolveActor(
        new Request(`${baseURL}/v1/me`, {
          headers: { authorization: `Bearer ${rotated.secret}` },
        }),
      ))!;
      const peerUser = newId(),
        peerSession = newId(),
        peerMember = newId();
      await fixture.owner.query(
        `INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Second Admin',$2,true)`,
        [peerUser, `admin-${peerUser.toLowerCase()}@example.test`],
      );
      await fixture.owner.query(
        `INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')`,
        [peerMember, admin.orgId, peerUser],
      );
      await fixture.owner.query(
        `INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [peerSession, peerUser, newId()],
      );
      const peer = await service.refreshActor({
        kind: "session",
        id: peerSession,
        userId: peerUser,
        orgId: admin.orgId,
        role: "admin",
        scopes: [],
      });
      const ownMember = (
        await fixture.owner.query(
          `SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2`,
          [admin.orgId, admin.userId],
        )
      ).rows[0];
      await execute("updateMember", admin, {
        id: ownMember.id,
        role: "viewer",
        expectedVersion: String(ownMember.version),
      });
      const downgraded = await service.refreshActor(personal);
      assert.equal(downgraded.role, "viewer");
      assert.ok(!downgraded.scopes.includes("rows:write"));
      await assert.rejects(
        () =>
          execute("updateMember", peer, {
            id: peerMember,
            role: "viewer",
            expectedVersion: "1",
          }),
        (error) => (error as { code: string }).code === "LAST_ADMIN",
      );
      await assert.rejects(
        () =>
          execute("removeMember", peer, {
            id: peerMember,
            expectedVersion: "1",
          }),
        (error) => (error as { code: string }).code === "LAST_ADMIN",
      );
      await execute("updateMember", peer, {
        id: ownMember.id,
        role: "admin",
        expectedVersion: String(Number(ownMember.version) + 1),
      });
      const refreshedAdmin = await service.refreshActor(admin);
      assert.equal((await service.refreshActor(personal)).role, "admin");
      const attempts = await Promise.allSettled([
        execute("updateMember", refreshedAdmin, {
          id: peerMember,
          role: "viewer",
          expectedVersion: "1",
        }),
        execute("updateMember", peer, {
          id: ownMember.id,
          role: "viewer",
          expectedVersion: String(Number(ownMember.version) + 2),
        }),
      ]);
      assert.equal(
        attempts.filter((value) => value.status === "fulfilled").length,
        1,
      );
      assert.equal(
        (
          await fixture.owner.query(
            `SELECT count(*)::int count FROM rootset_control.memberships WHERE org_id=$1 AND role='admin'`,
            [admin.orgId],
          )
        ).rows[0].count,
        1,
      );
      const remainingAdmin =
        (await service.refreshActor(refreshedAdmin)).role === "admin"
          ? await service.refreshActor(refreshedAdmin)
          : await service.refreshActor(peer);
      const removedMember =
        remainingAdmin.userId === admin.userId ? peerMember : ownMember.id;
      const removedVersion = (
        await fixture.owner.query(
          `SELECT version FROM rootset_control.memberships WHERE id=$1`,
          [removedMember],
        )
      ).rows[0].version;
      const removedActor =
        remainingAdmin.userId === admin.userId ? peer : admin;
      await execute("removeMember", remainingAdmin, {
        id: removedMember,
        expectedVersion: String(removedVersion),
      });
      await assert.rejects(
        () => service.refreshActor(removedActor),
        (error) => (error as { code: string }).code === "UNAUTHENTICATED",
      );
      if (removedActor.userId === personal.userId)
        await assert.rejects(
          () => service.refreshActor(personal),
          (error) => (error as { code: string }).code === "UNAUTHENTICATED",
        );
    } finally {
      await fixture.close();
    }
  },
);
