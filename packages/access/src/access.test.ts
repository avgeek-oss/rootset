import { test } from "node:test";
import assert from "node:assert/strict";
import { ActorSchema, operations, type Actor } from "@rootset/contracts";
import {
  ALL_SCOPES,
  assertAccess,
  assertDelegation,
  roleAllows,
  roleScopes,
} from "./index";

const base: Actor = {
  kind: "session",
  id: "user:one",
  userId: "01K6J7B8000000000000000000",
  orgId: "01K6J7B8000000000000000001",
  role: "editor",
  scopes: [],
};

test("roles separate admin management, editor row writes and viewer reads", () => {
  for (const role of ["admin", "editor", "viewer"] as const) {
    for (const scope of [
      "rows:read",
      "history:read",
      "exports:read",
      "profile:manage",
      "account:security",
      "keys:manage",
    ])
      assert.equal(roleAllows(role, scope), true, `${role}:${scope}`);
    for (const scope of [
      "org:manage",
      "members:read",
      "members:manage",
      "databases:manage",
      "tables:manage",
      "schema:manage",
      "backups:manage",
      "installation:read",
      "installation:manage",
    ])
      assert.equal(
        roleAllows(role, scope),
        role === "admin",
        `${role}:${scope}`,
      );
    for (const scope of ["rows:write", "imports:write"])
      assert.equal(
        roleAllows(role, scope),
        role !== "viewer",
        `${role}:${scope}`,
      );
    for (const scope of [
      "ownership:manage",
      "grants:manage",
      "audit:read",
      "*",
      "unsupported:read",
    ])
      assert.equal(roleAllows(role, scope), false);
  }
  assert.deepEqual(roleScopes("admin"), [...ALL_SCOPES]);
  for (const operation of operations)
    for (const scope of operation.scopes)
      assert.equal(
        roleAllows(operation.minimumRole, scope),
        true,
        operation.id,
      );
});

test("personal keys inherit the live role without selected operation or resource restrictions", () => {
  const actor = { ...base, kind: "personal_key" as const, scopes: [] };
  assert.doesNotThrow(() =>
    assertAccess(actor, {
      scope: "rows:write",
      databaseId: "any",
      tableId: "any",
    }),
  );
  assert.doesNotThrow(() =>
    assertAccess({ ...actor, role: "admin" }, { scope: "schema:manage" }),
  );
  assert.throws(() =>
    assertAccess({ ...actor, role: "viewer" }, { scope: "rows:write" }),
  );
  assert.throws(() => assertAccess(actor, { scope: "schema:manage" }));
  assert.doesNotThrow(() =>
    assertAccess(
      { ...actor, role: "viewer" },
      { scope: "keys:manage", personal: true },
    ),
  );
  assert.equal(
    ActorSchema.safeParse({ ...actor, kind: "team_key" }).success,
    false,
  );
});

test("OAuth operation consent intersects the current role on every check", () => {
  const actor = {
    ...base,
    kind: "oauth" as const,
    scopes: ["rows:read", "rows:write"],
  };
  assert.doesNotThrow(() =>
    assertAccess(actor, {
      scope: "rows:write",
      databaseId: "one",
      tableId: "two",
    }),
  );
  assert.throws(
    () => assertAccess(actor, { scope: "imports:write" }),
    /OAuth grant/,
  );
  assert.throws(
    () => assertAccess({ ...actor, role: "viewer" }, { scope: "rows:write" }),
    /role/,
  );
  assert.doesNotThrow(() =>
    assertAccess({ ...actor, role: "viewer" }, { scope: "rows:read" }),
  );
});

test("the single organisation fence and personal identity still apply", () => {
  assert.throws(
    () => assertAccess(base, { scope: "rows:read", orgId: "foreign" }),
    /not found/,
  );
  assert.doesNotThrow(() =>
    assertAccess(base, { scope: "rows:read", orgId: base.orgId }),
  );
  const anonymous = { ...base };
  delete anonymous.userId;
  assert.throws(
    () => assertAccess(anonymous, { scope: "profile:manage", personal: true }),
    /user identity/,
  );
});

test("installation administration has no second operator permission flag", () => {
  assert.doesNotThrow(() =>
    assertAccess({ ...base, role: "admin" }, { scope: "installation:manage" }),
  );
  assert.throws(() => assertAccess(base, { scope: "installation:manage" }));
  assert.doesNotThrow(() =>
    assertAccess(
      { ...base, role: "admin", kind: "operator" },
      { scope: "installation:manage" },
    ),
  );
  assert.throws(() =>
    assertAccess({ ...base, kind: "operator" }, { scope: "rows:read" }),
  );
});

test("OAuth delegation cannot exceed live role or existing OAuth consent", () => {
  assert.doesNotThrow(() =>
    assertDelegation(base, ["rows:read", "rows:write"]),
  );
  assert.throws(() => assertDelegation(base, ["schema:manage"]));
  assert.throws(() =>
    assertDelegation({ ...base, role: "viewer" }, ["rows:write"]),
  );
  assert.throws(() =>
    assertDelegation({ ...base, kind: "oauth", scopes: ["rows:read"] }, [
      "rows:write",
    ]),
  );
  assert.throws(() => assertDelegation(base, []));
  assert.throws(() => assertDelegation(base, ["rows:read", "rows:read"]));
  assert.throws(() => assertDelegation(base, ["grants:manage"]));
});
