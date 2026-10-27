import { workspaceInput } from "./workspace-input";
import assert from "node:assert/strict";
import { before, after } from "node:test";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import { newId, type Actor, type Role } from "@rootset/contracts";
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
  codes = ["FORBIDDEN", "INSUFFICIENT_SCOPE", "ACCESS_DENIED"],
) => {
  await assert.rejects(work, (error) => codes.includes(failure(error)));
};
const execute = (
  operation: string,
  actor: Actor,
  input: Record<string, unknown>,
  idempotencyKey = newId(),
) =>
  runtime.core.execute(
    operation,
    actor,
    workspaceInput(operation, actor, input),
    {
      surface: "browser",
      idempotencyKey,
      requestId: newId(),
    },
  );
const ids = () => ({ orgId, databaseId, tableId });
const resolveKey = async (secret: unknown) => {
  assert.equal(typeof secret, "string");
  const actor = await runtime.identity.resolveActor(
    new Request(`${runtime.config.baseURL}/v1/me`, {
      headers: { Authorization: `Bearer ${secret}` },
    }),
    "api",
  );
  assert.ok(actor);
  return actor;
};

before(async () => {
  database = await isolatedDatabase();
  runtime = await createRuntime({
    ...loadConfig(),
    databaseURL: database.app.options.connectionString!,
  });
  await database.owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [orgId, "Role authority fixture"],
  );
  for (const role of ["admin", "member", "viewer"] as const) {
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
      scopes: [],
      authenticatedAt: Date.now(),
      membershipVersion: 1,
    };
    await database.owner.query(
      "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 day',now())",
      [actors[role].id, userId, newId()],
    );
  }
  databaseId = idOf(
    await execute("createDatabase", actors.admin, {
      orgId,
      name: "Primary database",
    }),
  );
  peerDatabaseId = idOf(
    await execute("createDatabase", actors.admin, {
      orgId,
      name: "Peer database",
    }),
  );
  tableId = idOf(
    record(
      await execute("createTable", actors.admin, {
        orgId,
        databaseId,
        name: "Primary table",
        fields: [{ type: "text", name: "CODE" }],
      }),
    ).table,
  );
  peerTableId = idOf(
    record(
      await execute("createTable", actors.admin, {
        orgId,
        databaseId: peerDatabaseId,
        name: "Peer table",
        fields: [{ type: "text", name: "CODE" }],
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
    id: "ACCESS-SINGLE-ORG-01",
    gates: ["V1-03"],
    scope:
      "Direct and concurrent SQL attempts cannot create a second organisation or bypass the singleton check",
  },
  async () => {
    const attempts = await Promise.allSettled([
      database.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
        [newId(), "Second fixture"],
      ),
      database.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
        [newId(), "Concurrent second fixture"],
      ),
    ]);
    for (const attempt of attempts) {
      assert.equal(attempt.status, "rejected");
      if (attempt.status === "rejected")
        assert.equal(attempt.reason.code, "23505");
    }
    await assert.rejects(
      database.owner.query(
        "INSERT INTO rootset_control.organisations(id,name,singleton) VALUES($1,$2,false)",
        [newId(), "Bypass fixture"],
      ),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23514",
    );
    assert.deepEqual(
      (
        await database.owner.query(
          "SELECT id FROM rootset_control.organisations",
        )
      ).rows,
      [{ id: orgId }],
    );
  },
);

verificationCase(
  {
    id: "ACCESS-ROLE-01",
    gates: ["V1-04"],
    scope:
      "Real Core runtime enforces Admin/Member/Viewer read, row-write, schema, people and installation authority; password/MFA transports have separate tests",
  },
  async () => {
    for (const role of ["admin", "member", "viewer"] as const) {
      const actor = actors[role];
      await execute("queryRows", actor, { ...ids(), query: {} });
      const write = execute("createRow", actor, {
        ...ids(),
        expectedSchemaVersion: 1,
        values: { CODE: role },
      });
      if (role === "viewer") await deny(write);
      else await write;
      for (const [operation, input] of [
        [
          "createTable",
          { orgId, databaseId, name: `${role} schema authority` },
        ],
        ["listMembers", { orgId }],
      ] as const) {
        const work = execute(operation, actor, input);
        if (
          role === "admin" ||
          (role === "member" && operation === "createTable")
        )
          await work;
        else await deny(work);
      }
    }
    assert.equal(
      (await runtime.storage.queryRows(actors.admin, tableId, {})).data.length,
      2,
    );
  },
);

verificationCase(
  {
    id: "ACCESS-PARENT-01",
    gates: ["V1-10"],
    scope:
      "Every role can read both same-organisation databases; a mismatched database/table parent or unrelated organisation ID returns RESOURCE_NOT_FOUND",
  },
  async () => {
    for (const actor of Object.values(actors)) {
      await execute("queryRows", actor, {
        orgId,
        databaseId: peerDatabaseId,
        tableId: peerTableId,
        query: {},
      });
      await deny(
        execute("queryRows", actor, {
          ...ids(),
          databaseId: peerDatabaseId,
          query: {},
        }),
        ["RESOURCE_NOT_FOUND"],
      );
      await deny(
        execute("queryRows", actor, { ...ids(), orgId: newId(), query: {} }),
        ["RESOURCE_NOT_FOUND"],
      );
      const list = record(await execute("listDatabases", actor, { orgId }));
      assert.ok(Array.isArray(list.data));
      assert.ok(list.data.some((item) => idOf(item) === databaseId));
      assert.ok(list.data.some((item) => idOf(item) === peerDatabaseId));
    }
  },
);

verificationCase(
  {
    id: "ACCESS-RESOURCE-PAGING-01",
    gates: ["V1-10"],
    scope:
      "Database and table directory pages preserve complete summaries, active field counts and parent-bound cursors across SQL keyset windows",
  },
  async () => {
    const actor = actors.viewer;
    const parent = await runtime.storage.createDatabase(actors.admin, {
      name: "Directory paging",
    });
    const expected = new Map<string, number>();
    for (let index = 0; index < 6; index++) {
      const table = await runtime.storage.createTable(actors.admin, parent.id, {
        name: `Directory table ${index}`,
        description: `Description ${index}`,
        fields: Array.from({ length: index % 3 }, (_, field) => ({
          name: `FIELD_${String.fromCharCode(65 + field)}`,
          type: "text" as const,
        })),
      });
      expected.set(table.id, table.fields.length);
    }
    const readAll = async (
      operation: string,
      input: Record<string, unknown>,
    ) => {
      const rows: Record<string, unknown>[] = [];
      let cursor: unknown;
      do {
        const page = record(
          await execute(operation, actor, {
            ...input,
            limit: 2,
            ...(cursor ? { cursor } : {}),
          }),
        );
        assert.ok(Array.isArray(page.data));
        assert.ok(page.data.length <= 2);
        rows.push(...page.data.map(record));
        assert.equal(page.hasMore, !!page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    };
    const tables = await readAll("listTables", {
      orgId,
      databaseId: parent.id,
    });
    assert.deepEqual(tables.map(idOf), [...expected.keys()].sort());
    for (const table of tables) {
      assert.equal(table.fieldCount, expected.get(idOf(table)));
      assert.equal(typeof table.storageBytes, "number");
      assert.equal(table.lastDataChangeAt, null);
    }
    assert.ok(tables.every((table) => !Object.hasOwn(table, "fields")));
    const databases = await readAll("listDatabases", { orgId });
    assert.deepEqual(
      databases.map(idOf),
      (await runtime.storage.listDatabases(actor))
        .map((database) => database.id)
        .sort(),
    );
    assert.equal(
      databases.find((database) => database.id === parent.id)!.tableCount,
      6,
    );
    const first = record(
      await execute("listTables", actor, {
        orgId,
        databaseId: parent.id,
        limit: 2,
      }),
    );
    await deny(
      execute("listTables", actor, {
        orgId,
        databaseId,
        limit: 2,
        cursor: first.nextCursor,
      }),
      ["CURSOR_INVALID"],
    );
  },
);

verificationCase(
  {
    id: "ACCESS-DATABASE-COUNTS-01",
    gates: ["V1-10"],
    scope:
      "Database summaries count active and maintenance tables, omit deleted tables and include empty databases for every readable role",
  },
  async () => {
    const summaryId = idOf(
      await execute("createDatabase", actors.admin, {
        orgId,
        name: "Table count fixture",
      }),
    );
    const count = async (actor: Actor) => {
      const list = record(await execute("listDatabases", actor, { orgId }));
      assert.ok(Array.isArray(list.data));
      return record(list.data.find((item) => idOf(item) === summaryId))
        .tableCount;
    };
    assert.equal(await count(actors.viewer), 0);
    const tableIds: string[] = [];
    for (const name of ["Active", "Maintenance", "Deleted"]) {
      tableIds.push(
        idOf(
          record(
            await execute("createTable", actors.admin, {
              orgId,
              databaseId: summaryId,
              name,
              fields: [],
            }),
          ).table,
        ),
      );
    }
    assert.equal(await count(actors.viewer), 3);
    await database.owner.query(
      "UPDATE rootset_control.tables SET state='maintenance' WHERE id=$1",
      [tableIds[1]],
    );
    await database.owner.query(
      "UPDATE rootset_control.tables SET state='deleted' WHERE id=$1",
      [tableIds[2]],
    );
    for (const actor of Object.values(actors))
      assert.equal(await count(actor), 2);
  },
);

verificationCase(
  {
    id: "ACCESS-PERSONAL-01",
    gates: ["V1-07", "V1-05", "V1-17"],
    scope:
      "Issued personal keys inherit live roles across all resources; demotion blocks new and replayed writes while reads remain allowed; revocation, expiry and membership removal invalidate existing actors",
  },
  async () => {
    const created = record(
      await execute("createPersonalKey", actors.member, {
        access: actors.member.role === "viewer" ? "read" : "edit",
        includeAdmin: actors.member.role === "admin",
        expiresAt: "2030-01-01T00:00:00.000Z",
        orgId,
        name: "Member role fixture",
      }),
    );
    const actor = await resolveKey(created.secret);
    const schema = await runtime.storage.getTable(actors.admin, tableId);
    const writeInput = {
      ...ids(),
      expectedSchemaVersion: schema.schemaVersion,
      values: { CODE: "personal-write" },
    };
    const replayKey = newId();
    await execute("createRow", actor, writeInput, replayKey);
    await execute("queryRows", actor, {
      orgId,
      databaseId: peerDatabaseId,
      tableId: peerTableId,
      query: {},
    });
    const viewerKey = record(
      await execute("createPersonalKey", actors.viewer, {
        access: actors.viewer.role === "viewer" ? "read" : "edit",
        includeAdmin: actors.viewer.role === "admin",
        expiresAt: "2030-01-01T00:00:00.000Z",
        orgId,
        name: "Viewer role fixture",
      }),
    );
    const viewer = await resolveKey(viewerKey.secret);
    await execute("queryRows", viewer, { ...ids(), query: {} });
    await deny(
      execute("createRow", viewer, {
        ...writeInput,
        values: { CODE: "viewer-denied" },
      }),
    );
    const member = (
      await database.owner.query(
        "SELECT id,version::text version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.member.userId],
      )
    ).rows[0]!;
    await execute("updateMember", actors.admin, {
      orgId,
      id: member.id,
      expectedVersion: member.version,
      role: "viewer",
    });
    await deny(
      execute("createRow", actor, {
        ...writeInput,
        values: { CODE: "demoted" },
      }),
    );
    await deny(execute("createRow", actor, writeInput, replayKey));
    await execute("queryRows", actor, { ...ids(), query: {} });
    await execute("revokePersonalKey", actors.member, {
      id: idOf(created.key),
    });
    await deny(execute("queryRows", actor, { ...ids(), query: {} }), [
      "UNAUTHENTICATED",
    ]);

    const expiring = record(
      await execute("createPersonalKey", actors.viewer, {
        access: actors.viewer.role === "viewer" ? "read" : "edit",
        includeAdmin: actors.viewer.role === "admin",
        orgId,
        name: "Expiry fixture",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    const expiredActor = await resolveKey(expiring.secret);
    await database.owner.query(
      "UPDATE rootset_control.api_keys SET expires_at=now()-interval '1 second' WHERE id=$1",
      [idOf(expiring.key)],
    );
    await deny(execute("queryRows", expiredActor, { ...ids(), query: {} }), [
      "UNAUTHENTICATED",
    ]);
    const viewerMember = (
      await database.owner.query(
        "SELECT id,version::text version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.viewer.userId],
      )
    ).rows[0]!;
    await execute("removeMember", actors.admin, {
      orgId,
      id: viewerMember.id,
      expectedVersion: viewerMember.version,
    });
    await deny(execute("queryRows", viewer, { ...ids(), query: {} }), [
      "UNAUTHENTICATED",
    ]);
    await deny(execute("queryRows", actors.viewer, { ...ids(), query: {} }), [
      "UNAUTHENTICATED",
    ]);
  },
);

verificationCase(
  {
    id: "ACCESS-LAST-ADMIN-01",
    gates: ["V1-05"],
    scope: "The sole Admin cannot demote or remove itself",
  },
  async () => {
    const member = (
      await database.owner.query(
        "SELECT id,version::text version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, actors.admin.userId],
      )
    ).rows[0]!;
    await deny(
      execute("updateMember", actors.admin, {
        orgId,
        id: member.id,
        expectedVersion: member.version,
        role: "viewer",
      }),
      ["LAST_ADMIN"],
    );
    await deny(
      execute("removeMember", actors.admin, {
        orgId,
        id: member.id,
        expectedVersion: member.version,
      }),
      ["LAST_ADMIN"],
    );
  },
);
