import assert from "node:assert/strict";
import { before, after } from "node:test";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import { newId, scopeNames, type Actor, type Role } from "@rootset/contracts";
import { isolatedDatabase } from "./isolated-database.js";
import { verificationCase } from "./evidence.js";

let database: Awaited<ReturnType<typeof isolatedDatabase>>;
let runtime: Awaited<ReturnType<typeof createRuntime>>;
const orgId = newId();
const actors = {} as Record<Role, Actor>;
let databaseId: string,
  tableId: string,
  peerDatabaseId: string,
  peerTableId: string;
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const idOf = (value: unknown): string => {
  const id = record(value).id;
  assert.equal(typeof id, "string");
  return id as string;
};
const failure = (error: unknown): string =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "INTERNAL_ERROR";
const deny = async (
  work: Promise<unknown>,
  codes = [
    "FORBIDDEN",
    "INSUFFICIENT_SCOPE",
    "ACCESS_DENIED",
    "DELEGATION_EXCEEDS_AUTHORITY",
    "PERSONAL_IDENTITY_REQUIRED",
    "OPERATOR_REQUIRED",
  ],
) => {
  await assert.rejects(work, (error) => codes.includes(failure(error)));
};
const execute = (
  operation: string,
  actor: Actor,
  input: Record<string, unknown>,
) =>
  runtime.core.execute(operation, actor, input, {
    surface: "browser",
    idempotencyKey: newId(),
    requestId: newId(),
  });
const ids = () => ({ orgId, databaseId, tableId });

before(async () => {
  database = await isolatedDatabase();
  runtime = await createRuntime({
    ...loadConfig(),
    databaseURL: database.app.options.connectionString!,
    ddlDatabaseURL: database.ddl.options.connectionString!,
    identityDatabaseURL: database.identity.options.connectionString!,
  });
  // Verified identities and session actors are explicit local service fixtures.
  // Real password, session-cookie and OAuth authentication have separate transport tests.
  await database.owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [orgId, "Service authority matrix fixture"],
  );
  for (const role of ["owner", "admin", "editor", "viewer"] as const) {
    const userId = newId();
    await database.owner.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
      [
        userId,
        `${role} fixture`,
        `${userId.toLowerCase()}@access.example.test`,
      ],
    );
    await database.owner.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
      [newId(), orgId, userId, role],
    );
    actors[role] = {
      kind: "session",
      id: newId(),
      userId,
      orgId,
      role,
      scopes: [...scopeNames],
      targets: [],
      unrestricted: true,
      authenticatedAt: Date.now(),
    };
    await database.owner.query(
      "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,active_organization_id,authenticated_at) VALUES($1,$2,$3,now()+interval '1 day',$4,now())",
      [actors[role].id, userId, newId(), orgId],
    );
  }
  databaseId = idOf(
    await execute("createDatabase", actors.owner, {
      orgId,
      name: "Granted database",
    }),
  );
  peerDatabaseId = idOf(
    await execute("createDatabase", actors.owner, {
      orgId,
      name: "Peer database",
    }),
  );
  tableId = idOf(
    record(
      await execute("createTable", actors.owner, {
        orgId,
        databaseId,
        name: "Granted table",
        fields: [{ type: "text", apiKey: "CODE", label: "Code" }],
      }),
    ).table,
  );
  peerTableId = idOf(
    record(
      await execute("createTable", actors.owner, {
        orgId,
        databaseId: peerDatabaseId,
        name: "Peer table",
        fields: [{ type: "text", apiKey: "CODE", label: "Code" }],
      }),
    ).table,
  );
});
after(async () => {
  await runtime?.close();
  await database?.close();
});

verificationCase(
  {
    id: "ACCESS-ROLE-01",
    gates: ["ACC-02", "ACC-03", "ACC-04", "API-05"],
    scope:
      "Actual core runtime and role-specific verified actor fixtures enforce owner/admin/editor/viewer read, write, schema and member authority; authentication transport is separate",
  },
  async () => {
    for (const role of ["owner", "admin", "editor", "viewer"] as const) {
      const actor = actors[role];
      await execute("queryRows", actor, { ...ids(), query: {} });
      const write = execute("createRow", actor, {
        ...ids(),
        expectedSchemaVersion: 1,
        values: { CODE: role },
      });
      if (role === "viewer") await deny(write);
      else await write;
      const schema = execute("createTable", actor, {
        orgId,
        databaseId,
        name: `${role} schema authority`,
      });
      if (["owner", "admin"].includes(role)) await schema;
      else await deny(schema);
      const members = execute("listMembers", actor, { orgId });
      if (["owner", "admin"].includes(role)) await members;
      else await deny(members);
      await deny(execute("getInstallationConfiguration", actor, {}));
    }
    const rows = await runtime.storage.queryRows(actors.owner, tableId, {});
    assert.equal(rows.data.length, 3);
  },
);

verificationCase(
  {
    id: "ACCESS-GRANT-01",
    gates: ["ACC-03", "ACC-04", "API-06"],
    scope:
      "Real stored editor manage grant enables only its database; peer resources and mismatched parents remain inaccessible; viewer elevation to manage is rejected",
  },
  async () => {
    const member = (
      await database.owner.query(
        "SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.editor.userId],
      )
    ).rows[0]!;
    await execute("updateGrants", actors.owner, {
      orgId,
      grants: [
        {
          membershipId: member.id,
          version: Number(member.version),
          unrestricted: false,
          targets: [{ databaseId, level: "manage" }],
        },
      ],
    });
    await execute("updateTable", actors.editor, {
      ...ids(),
      expectedSchemaVersion: 1,
      name: "Editor managed table",
    });
    await execute("createTable", actors.editor, {
      orgId,
      databaseId,
      name: "Editor managed creation",
    });
    await deny(
      execute("queryRows", actors.editor, {
        orgId,
        databaseId: peerDatabaseId,
        tableId: peerTableId,
        query: {},
      }),
      ["RESOURCE_NOT_FOUND"],
    );
    await deny(
      execute("queryRows", actors.editor, {
        ...ids(),
        databaseId: peerDatabaseId,
        query: {},
      }),
      ["RESOURCE_NOT_FOUND"],
    );
    const list = record(
      await execute("listDatabases", actors.editor, { orgId }),
    );
    assert.ok(Array.isArray(list.data));
    assert.deepEqual(list.data.map(idOf), [databaseId]);
    const viewer = (
      await database.owner.query(
        "SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.viewer.userId],
      )
    ).rows[0]!;
    await deny(
      execute("updateGrants", actors.owner, {
        orgId,
        grants: [
          {
            membershipId: viewer.id,
            version: Number(viewer.version),
            unrestricted: false,
            targets: [{ databaseId, level: "manage" }],
          },
        ],
      }),
      ["VALIDATION_FAILED"],
    );
  },
);

verificationCase(
  {
    id: "ACCESS-CREATE-01",
    gates: ["ACC-03", "KEY-02", "API-06"],
    scope:
      "New database creation requires organisation-level manage authority: a database-restricted bearer cannot create a namespace outside its targets",
  },
  async () => {
    const created = record(
      await execute("createPersonalKey", actors.owner, {
        orgId,
        name: "One database management fixture",
        scopes: ["databases:read", "databases:manage"],
        targets: [{ databaseId, level: "manage" }],
        unrestricted: false,
      }),
    );
    const restricted = await runtime.identity.resolveActor(
      new Request(`${runtime.config.baseURL}/v1/me`, {
        headers: { Authorization: `Bearer ${created.secret}` },
      }),
      "api",
    );
    assert.ok(restricted);
    await deny(
      execute("createDatabase", restricted, {
        orgId,
        name: "Outside credential target",
      }),
      [
        "RESOURCE_NOT_FOUND",
        "FORBIDDEN",
        "INSUFFICIENT_SCOPE",
        "ACCESS_DENIED",
      ],
    );
  },
);

verificationCase(
  {
    id: "ACCESS-CREATE-02",
    gates: ["ACC-03", "API-05"],
    scope:
      "The approved role matrix permits an Editor with an explicit organisation-level manage grant to create a database; restoring the grant prevents fixture authority from leaking across cases",
  },
  async () => {
    const member = (
      await database.owner.query(
        "SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.editor.userId],
      )
    ).rows[0]!;
    await execute("updateGrants", actors.owner, {
      orgId,
      grants: [
        {
          membershipId: member.id,
          version: Number(member.version),
          unrestricted: false,
          targets: [{ level: "manage" }],
        },
      ],
    });
    try {
      const newDatabase = await execute("createDatabase", actors.editor, {
        orgId,
        name: "Explicit Editor organisation manage fixture",
      });
      const createdId = idOf(newDatabase);
      await execute("getDatabase", actors.editor, {
        orgId,
        databaseId: createdId,
      });
      const listed = record(
        await execute("listDatabases", actors.editor, { orgId }),
      );
      assert.ok(Array.isArray(listed.data));
      assert.ok(
        listed.data.some((item) => idOf(item) === createdId),
        "The organisation manage grant must inherit into the newly created database and its enumeration.",
      );
      await execute("listTables", actors.editor, {
        orgId,
        databaseId: createdId,
      });
    } finally {
      const current = (
        await database.owner.query(
          "SELECT version FROM rootset_control.memberships WHERE id=$1",
          [member.id],
        )
      ).rows[0]!;
      await execute("updateGrants", actors.owner, {
        orgId,
        grants: [
          {
            membershipId: member.id,
            version: Number(current.version),
            unrestricted: false,
            targets: [{ databaseId, level: "manage" }],
          },
        ],
      });
    }
  },
);

verificationCase(
  {
    id: "ACCESS-PERSONAL-01",
    gates: ["KEY-02", "KEY-04", "ACC-07", "API-05", "API-06"],
    scope:
      "Real issued personal bearer keys intersect scope, target and current membership; viewer cannot mint writes and an editor demotion or key revocation affects the next core request",
  },
  async () => {
    const created = record(
      await execute("createPersonalKey", actors.editor, {
        orgId,
        name: "Editor write fixture",
        scopes: ["rows:read", "rows:write", "tables:read", "databases:read"],
        targets: [{ databaseId, tableId, level: "edit" }],
        unrestricted: false,
      }),
    );
    assert.equal(typeof created.secret, "string");
    const actor = await runtime.identity.resolveActor(
      new Request(`${runtime.config.baseURL}/v1/me`, {
        headers: { Authorization: `Bearer ${created.secret}` },
      }),
      "api",
    );
    assert.ok(actor);
    const schema = await runtime.storage.getTable(actors.owner, tableId);
    await execute("createRow", actor, {
      ...ids(),
      expectedSchemaVersion: schema.schemaVersion,
      values: { CODE: "personal-write" },
    });
    await deny(
      execute("queryRows", actor, {
        orgId,
        databaseId: peerDatabaseId,
        tableId: peerTableId,
        query: {},
      }),
      ["RESOURCE_NOT_FOUND"],
    );
    await deny(
      execute("createPersonalKey", actors.viewer, {
        orgId,
        name: "Forbidden write delegation",
        scopes: ["rows:write"],
        targets: [],
        unrestricted: true,
      }),
    );
    const viewerKey = record(
      await execute("createPersonalKey", actors.viewer, {
        orgId,
        name: "Viewer read fixture",
        scopes: ["rows:read", "tables:read", "databases:read"],
        targets: [],
        unrestricted: true,
      }),
    );
    const viewerActor = await runtime.identity.resolveActor(
      new Request(`${runtime.config.baseURL}/v1/me`, {
        headers: { Authorization: `Bearer ${viewerKey.secret}` },
      }),
      "api",
    );
    assert.ok(viewerActor);
    await execute("queryRows", viewerActor, { ...ids(), query: {} });
    await deny(
      execute("createRow", viewerActor, {
        ...ids(),
        expectedSchemaVersion: schema.schemaVersion,
        values: { CODE: "denied" },
      }),
    );
    const member = (
      await database.owner.query(
        "SELECT id,version::text version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.editor.userId],
      )
    ).rows[0]!;
    await execute("updateMember", actors.owner, {
      orgId,
      id: member.id,
      expectedVersion: member.version,
      role: "viewer",
    });
    await deny(
      execute("createRow", actor, {
        ...ids(),
        expectedSchemaVersion: schema.schemaVersion,
        values: { CODE: "demoted" },
      }),
    );
    await execute("queryRows", actor, { ...ids(), query: {} });
    await execute("revokePersonalKey", actors.editor, {
      id: idOf(created.key),
    });
    await deny(execute("queryRows", actor, { ...ids(), query: {} }), [
      "UNAUTHENTICATED",
    ]);
  },
);

verificationCase(
  {
    id: "ACCESS-TEAM-01",
    gates: ["KEY-03", "KEY-04", "API-06", "API-12"],
    scope:
      "Real team bearer key uses scoped service authority independent of disabled creator, rejects personal/operator APIs, excludes peer resources and fails immediately after revocation",
  },
  async () => {
    const created = record(
      await execute("createTeamKey", actors.admin, {
        orgId,
        name: "Scoped team fixture",
        scopes: ["rows:read", "rows:write", "tables:read", "databases:read"],
        targets: [{ databaseId, tableId, level: "edit" }],
        unrestricted: false,
      }),
    );
    const actor = await runtime.identity.resolveActor(
      new Request(`${runtime.config.baseURL}/v1/me`, {
        headers: { Authorization: `Bearer ${created.secret}` },
      }),
      "api",
    );
    assert.ok(actor);
    assert.equal(actor.kind, "team_key");
    assert.equal(actor.userId, undefined);
    const schema = await runtime.storage.getTable(actors.owner, tableId);
    await execute("createRow", actor, {
      ...ids(),
      expectedSchemaVersion: schema.schemaVersion,
      values: { CODE: "team-write" },
    });
    await deny(execute("getProfile", actor, {}));
    await deny(execute("getInstallationConfiguration", actor, {}));
    await deny(
      execute("queryRows", actor, {
        orgId,
        databaseId: peerDatabaseId,
        tableId: peerTableId,
        query: {},
      }),
      ["RESOURCE_NOT_FOUND"],
    );
    const member = (
      await database.owner.query(
        "SELECT id,version::text version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.admin.userId],
      )
    ).rows[0]!;
    await execute("updateMember", actors.owner, {
      orgId,
      id: member.id,
      expectedVersion: member.version,
      state: "disabled",
    });
    await deny(execute("queryRows", actors.admin, { ...ids(), query: {} }), [
      "UNAUTHENTICATED",
    ]);
    await execute("queryRows", actor, { ...ids(), query: {} });
    await execute("revokeTeamKey", actors.owner, {
      orgId,
      id: idOf(created.key),
    });
    await deny(execute("queryRows", actor, { ...ids(), query: {} }), [
      "UNAUTHENTICATED",
    ]);
  },
);
