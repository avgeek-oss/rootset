import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_SCOPES,
  assertAccess,
  assertDelegation,
  intersectTargets,
  roleAllows,
  type Actor,
} from "./index";
const base: Actor = {
  kind: "session",
  id: "session",
  orgId: "01K00000000000000000000000",
  userId: "01K00000000000000000000001",
  role: "editor",
  scopes: [...ALL_SCOPES],
  targets: [],
  unrestricted: true,
};
test("ACC-03 role ceilings distinguish schema manage grants from organisation administration", () => {
  for (const role of ["owner", "admin", "editor", "viewer"] as const) {
    assert.equal(roleAllows(role, "rows:read"), true);
    assert.equal(roleAllows(role, "rows:write"), role !== "viewer");
    assert.equal(
      roleAllows(role, "members:manage"),
      role === "owner" || role === "admin",
    );
    assert.equal(roleAllows(role, "ownership:manage"), role === "owner");
    assert.equal(
      roleAllows(role, "schema:manage"),
      role === "owner" || role === "admin",
    );
    assert.equal(roleAllows(role, "schema:manage", true), role !== "viewer");
    assert.equal(roleAllows(role, "installation:manage", true), false);
  }
  assert.throws(() =>
    assertAccess({ ...base, role: "viewer" }, { scope: "rows:write" }),
  );
  assert.throws(() =>
    assertAccess(base, { scope: "schema:manage", databaseId: "db" }),
  );
  assert.doesNotThrow(() =>
    assertAccess(
      {
        ...base,
        targets: [{ databaseId: "db", tableId: "table", level: "manage" }],
      },
      {
        scope: "schema:manage",
        databaseId: "db",
        tableId: "table",
        level: "manage",
      },
    ),
  );
});
test("ACC-04 all actor kinds intersect role, scopes, resource and installation authority", () => {
  for (const kind of [
    "session",
    "personal_key",
    "team_key",
    "oauth",
    "operator",
  ] as const) {
    const actor: Actor = {
      ...base,
      kind,
      role: "admin",
      unrestricted: false,
      scopes: ["rows:read"],
      targets: [{ databaseId: "db", tableId: "one", level: "read" }],
    };
    assert.doesNotThrow(() =>
      assertAccess(actor, {
        scope: "rows:read",
        databaseId: "db",
        tableId: "one",
      }),
    );
    assert.throws(() =>
      assertAccess(actor, {
        scope: "rows:read",
        databaseId: "db",
        tableId: "two",
      }),
    );
    assert.throws(() =>
      assertAccess(actor, {
        scope: "rows:write",
        databaseId: "db",
        tableId: "one",
        level: "edit",
      }),
    );
    assert.throws(() =>
      assertAccess(actor, { scope: "rows:read", orgId: "foreign" }),
    );
    assert.throws(() =>
      assertAccess(
        { ...actor, scopes: ["installation:manage"] },
        { scope: "installation:manage" },
      ),
    );
  }
  assert.throws(() =>
    assertAccess(
      { ...base, kind: "team_key", role: "owner" },
      { scope: "ownership:manage", personal: true },
    ),
  );
});
test("KEY-04 delegation cannot widen resource boundaries, wildcard targets or scopes", () => {
  const actor: Actor = {
    ...base,
    unrestricted: false,
    targets: [{ databaseId: "db", tableId: "one", level: "edit" }],
    scopes: ["rows:read", "rows:write"],
  };
  assert.doesNotThrow(() =>
    assertDelegation(
      actor,
      ["rows:read"],
      [{ databaseId: "db", tableId: "one", level: "read" }],
    ),
  );
  assert.throws(() =>
    assertDelegation(
      actor,
      ["rows:read"],
      [{ databaseId: "db", level: "read" }],
    ),
  );
  assert.throws(() =>
    assertDelegation(
      actor,
      ["rows:read"],
      [{ databaseId: "db", tableId: "one", level: "manage" }],
    ),
  );
  assert.throws(() =>
    assertDelegation(actor, ["rows:read"], [{ level: "read" }]),
  );
  assert.doesNotThrow(() =>
    assertDelegation(
      { ...actor, targets: [{ level: "read" }] },
      ["rows:read"],
      [{ level: "read" }],
    ),
  );
  assert.throws(() =>
    assertDelegation(
      { ...actor, targets: [{ level: "read" }] },
      ["rows:read"],
      [{ level: "manage" }],
    ),
  );
  assert.throws(() => assertDelegation(actor, ["members:manage"], []));
  assert.throws(() => assertDelegation(actor, ["rows:read"], [], true));
  assert.deepEqual(
    intersectTargets(
      [{ databaseId: "db", level: "manage" }],
      [{ databaseId: "db", tableId: "one", level: "read" }],
    ),
    [{ databaseId: "db", tableId: "one", level: "read" }],
  );
});
