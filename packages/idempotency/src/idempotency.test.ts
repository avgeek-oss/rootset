import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { withOrg } from "@rootset/database";
import { newId, type Actor } from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import {
  lookupMutation,
  runMutation,
  stripMutationSecrets,
  operationAdmissionBinding,
  resolveAdmissionApproval,
} from "./index";

test("Queued admission HMAC preserves exact business/proof and principal binding without retaining raw secrets", () => {
  const actor: Actor = {
    kind: "oauth",
    id: "oauth:" + newId(),
    userId: newId(),
    credentialId: newId(),
    clientId: "reviewed-client",
    orgId: newId(),
    role: "admin",
    scopes: [],
  };
  const proof = newId(),
    key = newId(),
    secret = randomBytes(32).toString("hex");
  const input = {
    orgId: actor.orgId,
    databaseId: newId(),
    id: newId(),
    mode: "replace",
    approvalId: proof,
    query: {
      value: {
        password: "ordinary business value",
        token: "ordinary business value",
      },
    },
  };
  const sign = (
    principal = actor,
    body = input,
    approval = proof,
    context = { source: "rest", stepUpApproved: true },
  ) =>
    operationAdmissionBinding(
      principal,
      "restoreBackup",
      body,
      key,
      approval,
      secret,
      context,
    );
  const first = sign();
  assert.match(first, /^v1:[a-f0-9]{64}$/);
  assert.ok(!first.includes(secret));
  assert.equal(
    sign(actor, {
      ...input,
      query: {
        value: {
          token: "ordinary business value",
          password: "ordinary business value",
        },
      },
    }),
    first,
  );
  assert.notEqual(
    sign(actor, {
      ...input,
      query: {
        value: {
          password: "changed business value",
          token: "ordinary business value",
        },
      },
    }),
    first,
  );
  for (const principal of [
    { ...actor, id: "oauth:" + newId() },
    { ...actor, credentialId: newId() },
    { ...actor, userId: newId() },
    { ...actor, clientId: "different-client" },
    { ...actor, kind: "personal_key" as const },
    { ...actor, orgId: newId() },
  ])
    assert.notEqual(sign(principal), first);
  const otherProof = newId();
  assert.notEqual(
    sign(actor, { ...input, approvalId: otherProof }, otherProof),
    first,
  );
  assert.throws(
    () => sign(actor, input, otherProof),
    (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
  );
  assert.notEqual(
    sign(actor, input, proof, { source: "mcp", stepUpApproved: true }),
    first,
  );
  assert.notEqual(
    sign(actor, input, proof, { source: "rest", stepUpApproved: false }),
    first,
  );
  assert.equal(
    resolveAdmissionApproval({ approvalId: proof }, { actionId: proof }),
    proof,
  );
  assert.throws(
    () =>
      resolveAdmissionApproval({ approvalId: proof }, { actionId: newId() }),
    (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
  );
});

test("Replay redaction preserves domain codes and credential IDs while removing explicit one-time secrets", () => {
  assert.deepEqual(
    stripMutationSecrets({
      error: { code: "JOB_FAILED", message: "Retry after recovery" },
      suspension: { code: "DEPENDENCY_UNAVAILABLE" },
      credentialId: "public-id",
      tokenCount: 12,
      newPassword: "private",
      accessToken: "private",
      backup_codes: ["private"],
      nested: { secret: "private", safe: true },
    }),
    {
      error: { code: "JOB_FAILED", message: "Retry after recovery" },
      suspension: { code: "DEPENDENCY_UNAVAILABLE" },
      credentialId: "public-id",
      tokenCount: 12,
      nested: { safe: true },
    },
  );
});

test("API09 control replay receipts are atomic, bound, private, bounded and retained for 24 hours in real PostgreSQL", async (t) => {
  const fixture = await isolatedDatabase();
  const orgId = newId(),
    foreignOrgId = newId(),
    secret = randomBytes(32).toString("hex");
  const actor: Actor = {
    kind: "session",
    id: newId(),
    userId: newId(),
    orgId,
    role: "admin",
    scopes: ["members:manage"],
  };
  try {
    assert.ok(fixture.appliedMigrations.length > 0);
    await fixture.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Replay fixture')",
      [orgId],
    );
    await fixture.owner.query(
      "CREATE SCHEMA replay_test; CREATE TABLE replay_test.effects(id varchar(26) PRIMARY KEY,operation text NOT NULL); GRANT USAGE ON SCHEMA replay_test TO rootset_identity; GRANT INSERT ON replay_test.effects TO rootset_identity",
    );
    const input = {
      email: "invited@example.test",
      password: "Private password material",
      nested: { b: 2, a: 1 },
    };
    const key = newId();
    let effects = 0;
    const execute = () =>
      withOrg(fixture.identity, orgId, (c) =>
        runMutation(c, actor, "inviteMember", input, key, secret, async () => {
          effects++;
          await c.query(
            "INSERT INTO replay_test.effects(id,operation) VALUES($1,'inviteMember')",
            [newId()],
          );
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            id: newId(),
            secret: "one-time-never-persisted",
            nested: { recoveryCodes: ["private"], safe: true },
          };
        }),
      );
    await t.test(
      "Concurrent identical callers publish one effect and the same redacted result; changed input conflicts",
      async () => {
        const outcomes = await Promise.all(Array.from({ length: 4 }, execute));
        assert.equal(effects, 1);
        for (const result of outcomes) assert.deepEqual(result, outcomes[0]);
        assert.deepEqual(outcomes[0]!.nested, { safe: true });
        const lookup = await withOrg(fixture.identity, orgId, (c) =>
          lookupMutation(
            c,
            actor,
            "inviteMember",
            {
              nested: { a: 1, b: 2 },
              password: input.password,
              email: input.email,
            },
            key,
            secret,
          ),
        );
        assert.deepEqual(lookup, { found: true, result: outcomes[0] });
        await withOrg(fixture.identity, orgId, (c) =>
          runMutation(
            c,
            actor,
            "updateProfile",
            {},
            "k".repeat(255),
            secret,
            async () => ({ accepted: true }),
          ),
        );
        await assert.rejects(
          () =>
            withOrg(fixture.identity, orgId, (c) =>
              lookupMutation(
                c,
                actor,
                "inviteMember",
                { ...input, email: "changed@example.test" },
                key,
                secret,
              ),
            ),
          (error) =>
            (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
        );
        const stored = (
          await fixture.owner.query(
            "SELECT * FROM rootset_control.control_mutation_replays",
          )
        ).rows;
        assert.equal(stored.length, 2);
        assert.equal(JSON.stringify(stored).includes(input.password), false);
        assert.equal(JSON.stringify(stored).includes(input.email), false);
        assert.equal(JSON.stringify(stored).includes(key), false);
        assert.equal(
          JSON.stringify(stored).includes("one-time-never-persisted"),
          false,
        );
        assert.equal(stored[0].input_digest.length, 64);
        assert.equal(
          (
            await fixture.owner.query(
              "SELECT count(*)::int AS count FROM replay_test.effects",
            )
          ).rows[0].count,
          1,
        );
      },
    );
    await t.test(
      "Forged context and changed principal/credential/client/operation bindings never replay another authority",
      async () => {
        for (const changed of [
          { ...actor, id: newId() },
          { ...actor, credentialId: newId() },
          { ...actor, clientId: "another-client" },
          { ...actor, kind: "personal_key" as const },
          { ...actor, orgId: foreignOrgId },
        ]) {
          assert.deepEqual(
            await withOrg(fixture.identity, changed.orgId, (c) =>
              lookupMutation(c, changed, "inviteMember", input, key, secret),
            ),
            { found: false },
          );
        }
        assert.deepEqual(
          await withOrg(fixture.identity, foreignOrgId, (c) =>
            lookupMutation(c, actor, "inviteMember", input, key, secret),
          ),
          { found: false },
        );
        assert.deepEqual(
          await withOrg(fixture.identity, orgId, (c) =>
            lookupMutation(c, actor, "updateProfile", input, key, secret),
          ),
          { found: false },
        );
      },
    );
    await t.test(
      "An effect failure rolls back its receipt and effect together; a retry can safely complete",
      async () => {
        const unbound = await fixture.identity.connect();
        try {
          await assert.rejects(
            () =>
              runMutation(
                unbound,
                actor,
                "updateOrganisation",
                {},
                newId(),
                secret,
                async () => ({ accepted: true }),
              ),
            /active transaction/,
          );
        } finally {
          unbound.release();
        }
        const rollbackKey = newId();
        await assert.rejects(
          () =>
            withOrg(fixture.identity, orgId, (c) =>
              runMutation(
                c,
                actor,
                "updateProfile",
                {},
                rollbackKey,
                secret,
                async () => {
                  await c.query(
                    "INSERT INTO replay_test.effects(id,operation) VALUES($1,'updateProfile')",
                    [newId()],
                  );
                  throw new Error("rollback fixture");
                },
              ),
            ),
          /rollback fixture/,
        );
        assert.deepEqual(
          await withOrg(fixture.identity, orgId, (c) =>
            lookupMutation(c, actor, "updateProfile", {}, rollbackKey, secret),
          ),
          { found: false },
        );
        assert.equal(
          (
            await fixture.owner.query(
              "SELECT count(*)::int AS count FROM replay_test.effects WHERE operation='updateProfile'",
            )
          ).rows[0].count,
          0,
        );
        assert.deepEqual(
          await withOrg(fixture.identity, orgId, (c) =>
            runMutation(
              c,
              actor,
              "updateProfile",
              {},
              rollbackKey,
              secret,
              async () => ({ updated: true }),
            ),
          ),
          { updated: true },
        );
      },
    );
    await t.test(
      "Receipt contention fails within its bound and leaves the original transaction intact; expired receipts accept a new request",
      async () => {
        const blocker = await fixture.identity.connect(),
          blockedKey = newId();
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT set_config('rootset.org_id',$1,true)", [
            orgId,
          ]);
          await runMutation(
            blocker,
            actor,
            "updatePreferences",
            {},
            blockedKey,
            secret,
            async () => ({ accepted: true }),
          );
          const started = Date.now();
          await assert.rejects(
            () =>
              withOrg(fixture.identity, orgId, (c) =>
                runMutation(
                  c,
                  actor,
                  "updatePreferences",
                  {},
                  blockedKey,
                  secret,
                  async () => ({ accepted: false }),
                ),
              ),
            (error) =>
              (error as { code: string; status: number }).code ===
                "DEPENDENCY_UNAVAILABLE" &&
              (error as { status: number }).status === 503,
          );
          assert.ok(Date.now() - started < 4000);
          await blocker.query("COMMIT");
          assert.deepEqual(
            await withOrg(fixture.identity, orgId, (c) =>
              runMutation(
                c,
                actor,
                "updatePreferences",
                {},
                blockedKey,
                secret,
                async () => ({ accepted: false }),
              ),
            ),
            { accepted: true },
          );
          await fixture.owner.query(
            "UPDATE rootset_control.control_mutation_replays SET expires_at=now()-interval '1 second' WHERE operation_id='updatePreferences'",
          );
          assert.deepEqual(
            await withOrg(fixture.identity, orgId, (c) =>
              lookupMutation(
                c,
                actor,
                "updatePreferences",
                {},
                blockedKey,
                secret,
              ),
            ),
            { found: false },
          );
          assert.deepEqual(
            await withOrg(fixture.identity, orgId, (c) =>
              runMutation(
                c,
                actor,
                "updatePreferences",
                { new: true },
                blockedKey,
                secret,
                async () => ({ accepted: "new" }),
              ),
            ),
            { accepted: "new" },
          );
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      },
    );
    await t.test(
      "View preference outcomes preserve business JSON vocabulary, replay exactly and reject credential-shaped extra output atomically",
      async () => {
        const tableId = newId();
        const preferences = {
          columnOrder: [],
          columnWidths: {},
          frozenColumns: 0,
          hiddenColumns: [],
          query: {
            where: {
              field: "DETAILS",
              op: "jsonContains",
              value: {
                password: "ordinary data vocabulary",
                token: "ordinary data vocabulary",
                secret: { nested: ["ordinary data vocabulary", null, true] },
              },
            },
          },
        };
        const input = { tableId, preferences };
        const expected = { tableId, preferences };
        const key = newId();
        let effects = 0;
        const execute = () =>
          withOrg(fixture.identity, orgId, (client) =>
            runMutation(
              client,
              actor,
              "updateViewPreferences",
              input,
              key,
              secret,
              async () => {
                effects++;
                return expected;
              },
            ),
          );
        assert.deepEqual(await execute(), expected);
        assert.deepEqual(await execute(), expected);
        assert.equal(effects, 1);
        assert.deepEqual(
          await withOrg(fixture.identity, orgId, (client) =>
            lookupMutation(
              client,
              actor,
              "updateViewPreferences",
              input,
              key,
              secret,
            ),
          ),
          { found: true, result: expected },
        );
        const invalidKey = newId();
        const effectId = newId();
        await assert.rejects(
          withOrg(fixture.identity, orgId, (client) =>
            runMutation(
              client,
              actor,
              "updateViewPreferences",
              input,
              invalidKey,
              secret,
              async () => {
                await client.query(
                  "INSERT INTO replay_test.effects(id,operation) VALUES($1,'updateViewPreferences')",
                  [effectId],
                );
                return { ...expected, accessToken: "must not be persisted" };
              },
            ),
          ),
          { code: "INTERNAL_ERROR", status: 500 },
        );
        assert.equal(
          (
            await fixture.owner.query(
              "SELECT id FROM replay_test.effects WHERE id=$1",
              [effectId],
            )
          ).rowCount,
          0,
        );
        assert.deepEqual(
          await withOrg(fixture.identity, orgId, (client) =>
            lookupMutation(
              client,
              actor,
              "updateViewPreferences",
              input,
              invalidKey,
              secret,
            ),
          ),
          { found: false },
        );
      },
    );
  } finally {
    await fixture.close();
  }
});
