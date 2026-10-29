import { test } from "node:test";
import assert from "node:assert/strict";
import { operations, scopeNames, type Actor } from "@rootset/contracts";
import {
  keyScopes,
  keyRole,
  scopedRole,
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
  role: "member",
  scopes: [],
};

test("only three hierarchical scopes are supported", () => {
  assert.deepEqual(scopeNames, ["viewer", "member", "admin"]);
  assert.deepEqual(roleScopes("viewer"), ["viewer"]);
  assert.deepEqual(roleScopes("member"), ["viewer", "member"]);
  assert.deepEqual(roleScopes("admin"), ["viewer", "member", "admin"]);
  for (const role of ["viewer", "member", "admin"] as const) {
    for (const unsupported of [
      "rows:read",
      "installation:manage",
      "read",
      "write",
      "*",
      "unknown",
    ])
      assert.equal(roleAllows(role, unsupported), false);
  }
  for (const operation of operations) {
    assert.equal(operation.scopes.length, 1, operation.id);
    assert.equal(
      (operation.personal && operation.scopes[0] === "member") ||
        roleAllows(operation.minimumRole, operation.scopes[0]!),
      true,
      operation.id,
    );
  }
});

test("API key ceilings cannot exceed the live owner's role", () => {
  for (const ownerRole of ["viewer", "member", "admin"] as const) {
    const read = {
      ...base,
      kind: "personal_key" as const,
      role: keyRole(ownerRole, "read", true),
      scopes: keyScopes("read", true),
    };
    assert.doesNotThrow(() => assertAccess(read, { scope: "viewer" }));
    assert.throws(() => assertAccess(read, { scope: "member" }));
    assert.throws(() => assertAccess(read, { scope: "admin" }));
    const edit = {
      ...read,
      role: keyRole(ownerRole, "edit", false),
      scopes: keyScopes("edit", false),
    };
    if (ownerRole === "viewer")
      assert.throws(() => assertAccess(edit, { scope: "member" }));
    else assert.doesNotThrow(() => assertAccess(edit, { scope: "member" }));
    assert.throws(() => assertAccess(edit, { scope: "admin" }));
    const admin = {
      ...read,
      role: keyRole(ownerRole, "edit", true),
      scopes: keyScopes("edit", true),
    };
    if (ownerRole === "admin")
      assert.doesNotThrow(() => assertAccess(admin, { scope: "admin" }));
    else assert.throws(() => assertAccess(admin, { scope: "admin" }));
  }
});

test("OAuth grants combine their scope ceiling with the live role", () => {
  const actor = {
    ...base,
    kind: "oauth" as const,
    role: "admin" as const,
    scopes: ["member"],
  };
  assert.doesNotThrow(() => assertAccess(actor, { scope: "viewer" }));
  assert.doesNotThrow(() => assertAccess(actor, { scope: "member" }));
  assert.throws(() => assertAccess(actor, { scope: "admin" }), /credential/);
  assert.throws(
    () => assertAccess({ ...actor, role: "viewer" }, { scope: "member" }),
    /role/,
  );
  assert.doesNotThrow(() =>
    assertAccess({ ...actor, scopes: ["admin"] }, { scope: "member" }),
  );
  assert.throws(() =>
    assertAccess({ ...actor, scopes: ["rows:write"] }, { scope: "member" }),
  );
});

test("organisation and personal identity boundaries remain enforced", () => {
  assert.throws(
    () => assertAccess(base, { scope: "viewer", orgId: "foreign" }),
    /not found/,
  );
  assert.doesNotThrow(() =>
    assertAccess(base, { scope: "viewer", orgId: base.orgId }),
  );
  const anonymous = { ...base };
  delete anonymous.userId;
  assert.throws(
    () => assertAccess(anonymous, { scope: "viewer", personal: true }),
    /user identity/,
  );
  assert.throws(
    () => assertAccess({ ...base, kind: "operator" }, { scope: "viewer" }),
    /Admin/,
  );
  assert.doesNotThrow(() =>
    assertAccess(
      { ...base, role: "admin", kind: "operator" },
      { scope: "admin" },
    ),
  );
});

test("delegation cannot exceed the live role or credential ceiling", () => {
  assert.doesNotThrow(() => assertDelegation(base, ["viewer", "member"]));
  assert.throws(() => assertDelegation(base, ["admin"]));
  assert.throws(() =>
    assertDelegation({ ...base, role: "viewer" }, ["member"]),
  );
  assert.throws(() =>
    assertDelegation({ ...base, kind: "oauth", scopes: ["viewer"] }, [
      "member",
    ]),
  );
  assert.throws(() => assertDelegation(base, []));
  assert.throws(() => assertDelegation(base, ["viewer", "viewer"]));
  assert.throws(() => assertDelegation(base, ["rows:read"]));
});

test("account ownership cannot bypass a credential or role ceiling", () => {
  const viewer = { ...base, role: "viewer" as const };
  assert.throws(() =>
    assertAccess(viewer, { scope: "member", personal: true }),
  );
  assert.throws(() =>
    assertAccess(
      { ...viewer, kind: "oauth", scopes: ["viewer"] },
      { scope: "member", personal: true },
    ),
  );
  assert.throws(() =>
    assertAccess(
      { ...base, kind: "personal_key", scopes: ["viewer"] },
      { scope: "member", personal: true },
    ),
  );
});

test("OAuth scope ceilings cap an administrator's effective role", () => {
  assert.equal(scopedRole("admin", ["viewer"]), "viewer");
  assert.equal(scopedRole("admin", ["viewer", "member"]), "member");
  assert.equal(scopedRole("member", ["viewer", "member", "admin"]), "member");
  assert.equal(scopedRole("admin", ["admin"]), "admin");
});
