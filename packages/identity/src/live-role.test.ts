import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { newId, RootsetError, type Actor } from "@rootset/contracts";
import { roleAllows } from "@rootset/access";
import type { Pool, PoolClient } from "@rootset/database";
import { IdentityService } from "./index.js";

function fixture() {
  const userId = newId(),
    orgId = newId(),
    credentialId = newId();
  const state = {
    role: "member" as Actor["role"],
    version: 1,
    verified: true,
    member: true,
    credential: true,
    session: true,
    grant: true,
    scopes: ["rows:read", "rows:write"],
    job: undefined as Record<string, unknown> | undefined,
    approval: true,
    checkouts: 0,
    onAuthorityLock: undefined as (() => void) | undefined,
  };
  const query = async (sql: string, values: unknown[] = []) => {
    let rows: unknown[] = [];
    if (sql.includes("pg_advisory_xact_lock")) {
      state.onAuthorityLock?.();
    } else if (sql.includes("SELECT m.role,m.version")) {
      if (state.member && values[0] === orgId && values[1] === userId)
        rows = [
          {
            role: state.role,
            version: state.version,
            email_verified: state.verified,
          },
        ];
    } else if (sql.includes("SELECT authenticated_at")) {
      if (state.session && values[0] === credentialId && values[1] === userId)
        rows = [{ authenticated_at: new Date() }];
    } else if (sql.includes("SELECT 1 FROM rootset_control.api_keys")) {
      if (
        state.credential &&
        values[0] === credentialId &&
        values[1] === orgId &&
        values[2] === userId
      )
        rows = [{}];
    } else if (
      sql.includes("SELECT scopes FROM rootset_control.oauth_grants")
    ) {
      if (
        state.grant &&
        values[0] === credentialId &&
        values[1] === orgId &&
        values[2] === userId
      )
        rows = [{ scopes: state.scopes }];
    } else if (
      sql.includes("SELECT id,org_id,operation_id,target_id,actor,input")
    ) {
      if (
        state.job &&
        state.job.id === values[0] &&
        state.job.org_id === values[1]
      )
        rows = [state.job];
    } else if (sql.includes("SELECT id FROM rootset_control.account_actions")) {
      if (state.approval) rows = [{ id: values[0] }];
    } else if (!/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(sql)) {
      throw new Error(`Unexpected fixture query: ${sql}`);
    }
    return { rows, rowCount: rows.length };
  };
  const client = { query, release() {} } as unknown as PoolClient;
  const pool = {
    query,
    connect: async () => {
      state.checkouts++;
      return client;
    },
  } as unknown as Pool;
  const service = new IdentityService({
    pool,
    baseURL: "http://localhost:6300",

    secret: randomBytes(32).toString("hex"),
    bootstrapSecret: randomBytes(32).toString("hex"),
    keyHashSecret: randomBytes(32).toString("hex"),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),

    authoriseRepair: async () => undefined,
  });
  const actor: Actor = {
    kind: "personal_key",
    id: credentialId,
    credentialId,
    userId,
    orgId,
    role: "admin",
    scopes: ["installation:manage"],
  };
  return { state, service, actor, client };
}
const unauthenticated = (error: unknown) =>
  error instanceof RootsetError && error.code === "UNAUTHENTICATED";

test("personal keys inherit the live member role and membership version without an issued scope ceiling", async () => {
  const { state, service, actor } = fixture();
  const member = await service.refreshActor(actor);
  assert.equal(member.role, "member");
  assert.ok(member.scopes.includes("rows:write"));
  assert.ok(!member.scopes.includes("installation:manage"));
  assert.equal(member.membershipVersion, 1);
  state.role = "viewer";
  state.version++;
  const viewer = await service.refreshActor(member);
  assert.equal(viewer.role, "viewer");
  assert.equal(viewer.membershipVersion, 2);
  assert.ok(!viewer.scopes.includes("rows:write"));
  state.role = "admin";
  state.version++;
  const admin = await service.refreshActor(viewer);
  assert.equal(admin.role, "admin");
  assert.ok(admin.scopes.includes("installation:manage"));
  assert.ok(admin.scopes.every((scope) => roleAllows("admin", scope)));
});

test("member removal, verification loss, credential revocation and user/org mismatch immediately invalidate personal keys", async () => {
  for (const attribute of ["member", "verified", "credential"] as const) {
    const { state, service, actor } = fixture();
    state[attribute] = false;
    await assert.rejects(() => service.refreshActor(actor), unauthenticated);
  }
  const { service, actor } = fixture();
  for (const changed of [
    { userId: newId() },
    { orgId: newId() },
    { credentialId: newId() },
    { userId: undefined },
  ])
    await assert.rejects(
      () => service.refreshActor({ ...actor, ...changed }),
      unauthenticated,
    );
});

test("OAuth consent scopes intersect the live role, while a stored grant cannot add unconsented operations", async () => {
  const { state, service, actor } = fixture();
  state.scopes = ["rows:read", "rows:write", "installation:manage"];
  const consent = {
    ...actor,
    kind: "oauth" as const,
    scopes: ["rows:read", "rows:write"],
    clientId: "test-client",
  };
  assert.deepEqual((await service.refreshActor(consent)).scopes, [
    "rows:read",
    "rows:write",
  ]);
  state.role = "viewer";
  assert.deepEqual((await service.refreshActor(consent)).scopes, ["rows:read"]);
  state.grant = false;
  await assert.rejects(() => service.refreshActor(consent), unauthenticated);
});

test("revoked sessions cannot execute manually but verified membership retains scheduled policy authority", async () => {
  const { state, service, actor } = fixture();
  const session = { ...actor, kind: "session" as const };
  assert.ok((await service.refreshActor(session)).authenticatedAt);
  state.session = false;
  await assert.rejects(() => service.refreshActor(session), unauthenticated);
  assert.equal(
    (await service.refreshPolicyActor(session)).userId,
    actor.userId,
  );
  state.member = false;
  await assert.rejects(
    () => service.refreshPolicyActor(session),
    unauthenticated,
  );
});

test("repair intent authenticates the persisted job and matches either an explicit request or the durable job fallback", async () => {
  const { state, service, actor, client } = fixture();
  state.role = "admin";
  const jobId = newId(),
    tableId = newId(),
    approvalId = newId();
  const operationContext: Record<string, unknown> = { approvalId };
  state.job = {
    id: jobId,
    org_id: actor.orgId,
    operation_id: "mutateRows",
    target_id: tableId,
    actor,
    input: {
      tableId,
      repair: { reason: "Correct approved source transcription" },
      operationContext,
    },
  };
  const intent = {
    jobId,
    tableId,
    approvalId,
    reason: "Correct approved source transcription",
    requestId: jobId,
  };
  await service.recordRepairIntent(client, actor, intent);
  operationContext.requestId = newId();
  await service.recordRepairIntent(client, actor, {
    ...intent,
    requestId: operationContext.requestId as string,
  });
  await assert.rejects(
    () => service.recordRepairIntent(client, actor, intent),
    (error) =>
      error instanceof RootsetError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () =>
      service.recordRepairIntent(client, { ...actor, userId: newId() }, intent),
    (error) => error instanceof RootsetError && error.code === "ACCESS_DENIED",
  );
  state.approval = false;
  await assert.rejects(
    () => service.recordRepairIntent(client, actor, intent),
    (error) =>
      error instanceof RootsetError && error.code === "STEP_UP_REQUIRED",
  );
});

test("key admission rechecks removal or session revocation under the user authority lock without an extra pool checkout", async () => {
  for (const revoked of ["member", "session"] as const) {
    const { state, service, actor } = fixture();
    const session = { ...actor, kind: "session" as const };
    state.onAuthorityLock = () => {
      state[revoked] = false;
    };
    let executed = false;
    await assert.rejects(
      () =>
        service.withOperationApproval(
          session,
          "createPersonalKey",
          { orgId: actor.orgId, name: "Racing key" },
          { idempotencyKey: newId() },
          async () => {
            executed = true;
          },
        ),
      unauthenticated,
    );
    assert.equal(executed, false);
    assert.equal(state.checkouts, 2);
  }
});
