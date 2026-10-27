import { workspaceInput } from "../../../tools/verification/workspace-input.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import { withOrg } from "@rootset/database";
import {
  newId,
  getOperation,
  KeyCreatedSchema,
  type Actor,
  type RowComment,
  type Row,
  type QueryResult,
} from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createRuntimeApp } from "./runtime-app.js";
import { httpServerOptions } from "./http-server.js";

type Page = { data: RowComment[]; nextCursor: string | null; hasMore: boolean };
const code = (expected: string) => (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === expected;

test("row comments: native permissions, pagination, retained deletion logs, races and transport parity", async (t) => {
  const db = await isolatedDatabase();
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let app: ReturnType<typeof createRuntimeApp> | undefined;
  const server = serve({
    serverOptions: httpServerOptions,
    fetch: (request) => app!.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const mcp = new Client({ name: "Row comment integration", version: "1.0.0" });
  try {
    runtime = await createRuntime({
      ...loadConfig(),
      baseURL,
      webURL: baseURL,
      databaseURL: db.app.options.connectionString!,
    });
    const testRuntime = {
      ...runtime,
      getAdmissionLimits: () => ({
        principalRequestsPerMinute: 100000,
        organisationRequestsPerMinute: 100000,
        concurrentReads: 10,
        concurrentMutations: 5,
      }),
    };
    app = createRuntimeApp(testRuntime);
    const setup = await app.request("/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrapSecret: runtime.config.bootstrapSecret,
        name: "Alex Admin",
        email: "comments-admin@example.test",
        password: "Fixture comments password 2026!",
        organisationName: "Comment verification",
      }),
    });
    assert.equal(setup.status, 201, await setup.clone().text());
    const { orgId, userId } = (await setup.json()) as {
      orgId: string;
      userId: string;
    };
    const login = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email: "comments-admin@example.test",
        password: "Fixture comments password 2026!",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const admin = await runtime.identity.resolveActor(
      new Request(baseURL, { headers: { Cookie: cookie } }),
      "browser",
    );
    assert(admin);
    assert.equal(admin.userId, userId);
    async function person(
      name: string,
      role: "member" | "viewer",
    ): Promise<Actor> {
      const userId = newId(),
        sessionId = newId();
      await db.owner.query(
        "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
        [userId, name, `${userId.toLowerCase()}@example.test`],
      );
      await withOrg(db.owner, orgId, async (c) => {
        await c.query(
          "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
          [newId(), orgId, userId, role],
        );
      });
      await db.owner.query(
        "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
        [sessionId, userId, newId()],
      );
      return {
        kind: "session",
        id: sessionId,
        userId,
        orgId,
        role,
        scopes: [],
        authenticatedAt: Date.now(),
      };
    }
    const member = await person("Morgan Member", "member"),
      peer = await person("Sam Peer", "member"),
      viewer = await person("Viv Viewer", "viewer");
    const execute = async <T>(
      id: string,
      actor: Actor,
      input: Record<string, unknown>,
      key = newId(),
    ): Promise<T> => {
      const value = await runtime!.core.execute(
        id,
        actor,
        workspaceInput(id, actor, input),
        {
          idempotencyKey: key,
        },
      );
      return getOperation(id).outputSchema.parse(value) as T;
    };
    const database = await runtime.storage.createDatabase(admin, {
      name: "Operations",
    });
    const table = await runtime.storage.createTable(admin, database.id, {
      name: "Fleet",
      fields: [{ name: "REGISTRATION", type: "text", charLimit: 120 }],
    });
    const row = await runtime.storage.createRow(admin, table.id, {
      REGISTRATION: "VT-ONE",
    });
    const second = await runtime.storage.createRow(admin, table.id, {
      REGISTRATION: "VT-TWO",
    });
    const ids = {
      workspaceId: orgId,
      orgId,
      databaseId: database.id,
      tableId: table.id,
    };
    const target = { ...ids, rowId: row.id };
    t.beforeEach(async () => {
      await withOrg(db.owner, orgId, (client) =>
        client.query("DELETE FROM rootset_control.row_comments"),
      );
    });
    const create = (
      actor: Actor,
      body: string,
      key = newId(),
      targetIds = target,
    ) =>
      execute<{ id: string }>(
        "createRowComment",
        actor,
        { ...targetIds, body },
        key,
      );
    const list = (actor = admin, extra: Record<string, unknown> = {}) =>
      execute<Page>("listRowComments", actor, { ...target, ...extra });
    const remove = (actor: Actor, commentId: string, key = newId()) =>
      execute("deleteRowComment", actor, { ...target, commentId }, key);
    const count = () =>
      execute<{ data: { rowId: string; count: number }[] }>(
        "countRowComments",
        viewer,
        { ...ids, rowIds: [row.id, second.id, newId(), row.id] },
      );

    await t.test(
      "row pages carry live comment presence without bodies or counts",
      async () => {
        const page = () =>
          execute<QueryResult>("queryRows", viewer, {
            ...ids,
            query: { limit: 1 },
          });
        assert.equal((await page()).data[0]?.hasComments, false);
        assert.equal(
          (await execute<Row>("getRow", viewer, target)).hasComments,
          false,
        );
        const firstComment = await create(member, "Presence test one");
        const lastComment = await create(member, "Presence test two");
        const first = await page();
        assert.equal(first.data[0]?.id, row.id);
        assert.equal(first.data[0]?.hasComments, true);
        assert.deepEqual(first.data[0]?.values, { REGISTRATION: "VT-ONE" });
        assert(!JSON.stringify(first).includes("Presence test"));
        const next = await execute<QueryResult>("queryRows", viewer, {
          ...ids,
          query: { limit: 1, cursor: first.page.nextCursor },
        });
        assert.equal(next.data[0]?.id, second.id);
        assert.equal(next.data[0]?.hasComments, false);
        const filteredQuery = {
          where: { field: "REGISTRATION", op: "eq", value: "VT-ONE" },
          select: ["REGISTRATION"],
          orderBy: [{ field: "REGISTRATION", direction: "desc" }],
          limit: 1,
        };
        assert.equal(
          (
            await execute<QueryResult>("queryRows", viewer, {
              ...ids,
              query: filteredQuery,
            })
          ).data[0]?.hasComments,
          true,
        );
        for (const position of ["first", "last", 0]) {
          const window = await runtime!.core.windowQuery(viewer, {
            ...ids,
            query: filteredQuery,
            position,
          });
          assert.equal(window.result.data[0]?.hasComments, true);
        }
        const listed = await execute<QueryResult>("listRows", viewer, {
          ...ids,
          limit: 2,
        });
        assert.deepEqual(
          listed.data.map((value) => value.hasComments),
          [true, false],
        );
        await remove(member, firstComment.id);
        assert.equal((await page()).data[0]?.hasComments, true);
        await remove(member, lastComment.id);
        assert.equal((await page()).data[0]?.hasComments, true);
        const reread = await execute<Row>("getRow", viewer, target);
        assert.equal(reread.hasComments, true);
        assert.equal(reread.version, row.version);
        const window = await runtime!.core.windowQuery(viewer, {
          ...ids,
          query: { limit: 2 },
          position: "first",
        });
        assert.deepEqual(
          window.result.data.map((value) => value.hasComments),
          [true, false],
        );
        await assert.rejects(
          execute("queryRows", viewer, { ...ids, orgId: newId(), query: {} }),
          code("RESOURCE_NOT_FOUND"),
        );
      },
    );

    await t.test(
      "roles, authenticated names, ownership, immutable versions and bounded batches",
      async () => {
        await assert.rejects(create(viewer, "Forbidden"), code("FORBIDDEN"));
        for (const body of ["", " \n\t", "a".repeat(4097), "bad\0text"])
          await assert.rejects(create(member, body));
        await assert.rejects(
          execute("createRowComment", member, {
            ...target,
            body: "Forged",
            authorName: "Someone else",
          }),
        );
        const own = await create(member, "Plain <b>text</b>\nSecond line");
        const page = await list(viewer);
        assert.equal(page.data[0]?.authorName, "Morgan Member");
        assert.equal(page.data[0]?.authorUserId, member.userId);
        assert.equal(page.data[0]?.body, "Plain <b>text</b>\nSecond line");
        assert.equal(page.data[0]?.deletedAt, null);
        assert.equal(page.data[0]?.canDelete, false);
        assert.equal((await list(member)).data[0]?.canDelete, true);
        await assert.rejects(remove(peer, own.id), code("FORBIDDEN"));
        await assert.rejects(remove(viewer, own.id), code("FORBIDDEN"));
        await remove(member, own.id);
        await remove(admin, (await create(peer, "Moderate this")).id);
        assert.deepEqual(
          (await count()).data.map((item) => item.count),
          [2, 0],
        );
        assert.equal(
          (await runtime!.storage.getRow(admin, table.id, row.id)).version,
          row.version,
        );
        assert.equal(
          (await runtime!.storage.getTable(admin, table.id)).schemaVersion,
          table.schemaVersion,
        );
        await assert.rejects(
          execute("countRowComments", viewer, {
            ...ids,
            rowIds: Array.from({ length: 201 }, () => row.id),
          }),
        );
        await assert.rejects(list(viewer, { limit: 51 }));
        await assert.rejects(
          create(member, "Wrong database", newId(), {
            ...target,
            databaseId: newId(),
          }),
          code("RESOURCE_NOT_FOUND"),
        );
        await assert.rejects(
          create(member, "Wrong organisation", newId(), {
            ...target,
            orgId: newId(),
          }),
          code("RESOURCE_NOT_FOUND"),
        );
        await assert.rejects(
          create(member, "Missing row", newId(), { ...target, rowId: newId() }),
          code("RESOURCE_NOT_FOUND"),
        );
      },
    );

    await t.test(
      "chronological cursors survive deletion of the anchor and reject other rows/principals",
      async () => {
        const added = [];
        for (let i = 0; i < 5; i++)
          added.push(await create(member, `Page ${i}`));
        const first = await list(member, { limit: 2 });
        assert.deepEqual(
          first.data.map((item) => item.id),
          added.slice(0, 2).map((item) => item.id),
        );
        assert(first.nextCursor);
        await remove(member, first.data[1]!.id);
        const deletedAnchor = (await list(member, { limit: 2 })).data[1]!;
        assert.equal(deletedAnchor.id, first.data[1]!.id);
        assert.equal(deletedAnchor.body, "");
        assert(deletedAnchor.deletedAt);
        assert.equal(deletedAnchor.createdAt, first.data[1]!.createdAt);
        assert.equal(deletedAnchor.canDelete, false);
        const next = await list(member, { limit: 2, cursor: first.nextCursor });
        assert.deepEqual(
          next.data.map((item) => item.id),
          added.slice(2, 4).map((item) => item.id),
        );
        await assert.rejects(
          list(peer, { limit: 2, cursor: first.nextCursor }),
          code("CURSOR_INVALID"),
        );
        await assert.rejects(
          list(member, {
            rowId: second.id,
            limit: 2,
            cursor: first.nextCursor,
          }),
          code("CURSOR_INVALID"),
        );
        await assert.rejects(
          list(member, { limit: 3, cursor: first.nextCursor }),
          code("CURSOR_INVALID"),
        );
        const last = await list(member, { limit: 2, cursor: next.nextCursor });
        assert.equal(last.hasMore, false);
        assert.equal(last.data[0]?.id, added[4]?.id);
        assert.equal(
          (await count()).data.find((item) => item.rowId === row.id)?.count,
          5,
        );
        for (const item of (await list()).data) await remove(admin, item.id);
      },
    );

    await t.test(
      "encoded byte budgets page complete comments without omissions",
      async () => {
        const ids = [];
        for (let index = 0; index < 4; index++)
          ids.push(
            (await create(member, `${index}` + "\u0001".repeat(4095))).id,
          );
        let cursor: string | null = null;
        const found: string[] = [];
        do {
          const page = getOperation("listRowComments").outputSchema.parse(
            await runtime!.core.execute(
              "listRowComments",
              member,
              { ...target, limit: 50, cursor },
              { surface: "mcp", responseBudget: 32768 },
            ),
          ) as Page;
          assert(Buffer.byteLength(JSON.stringify(page)) < 32768);
          assert.equal(page.data.length, 1);
          found.push(...page.data.map((comment) => comment.id));
          cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(found, ids);
        for (const id of ids) await remove(member, id);
      },
    );
    await t.test(
      "concurrent retries are atomic, bodies are absent from receipts, and deletion is final",
      async () => {
        const key = newId();
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            create(member, "Erase this unique body", key),
          ),
        );
        assert.equal(new Set(results.map((result) => result.id)).size, 1);
        await assert.rejects(
          create(member, "Changed", key),
          code("IDEMPOTENCY_CONFLICT"),
        );
        const deleteKey = newId();
        await remove(member, results[0]!.id, deleteKey);
        await remove(member, results[0]!.id, deleteKey);
        assert.deepEqual(
          await create(member, "Erase this unique body", key),
          results[0],
        );
        const deleted = (await list()).data;
        assert.equal(deleted.length, 1);
        assert.equal(deleted[0]!.id, results[0]!.id);
        assert.equal(deleted[0]!.body, "");
        assert(deleted[0]!.deletedAt);
        assert.equal(deleted[0]!.canDelete, false);
        await remove(member, results[0]!.id);
        assert.deepEqual((await list()).data, deleted);
        await assert.rejects(remove(peer, results[0]!.id), code("FORBIDDEN"));
        await assert.rejects(remove(viewer, results[0]!.id), code("FORBIDDEN"));
        await withOrg(db.owner, orgId, async (c) => {
          const stored = await c.query(
            "SELECT body,deleted_at FROM rootset_control.row_comments WHERE id=$1",
            [results[0]!.id],
          );
          assert.equal(stored.rowCount, 1);
          assert.equal(stored.rows[0].body, "");
          assert.equal(
            stored.rows[0].deleted_at.toISOString(),
            deleted[0]!.deletedAt,
          );
          assert.equal(
            (
              await c.query(
                "UPDATE rootset_control.row_comments SET body='restored',deleted_at=NULL WHERE id=$1",
                [results[0]!.id],
              )
            ).rowCount,
            0,
          );
          for (const relation of [
            "control_mutation_replays",
            "operation_outcomes",
            "resource_history",
            "mutations",
            "jobs",
          ]) {
            const found = await c.query(
              `SELECT count(*)::int AS count FROM rootset_control.${relation} r WHERE row_to_json(r)::text LIKE $1`,
              ["%Erase this unique body%"],
            );
            assert.equal(found.rows[0].count, 0, relation);
          }
          await c.query(
            "UPDATE rootset_control.memberships SET role='viewer',version=version+1 WHERE user_id=$1",
            [member.userId],
          );
        });
        await assert.rejects(
          create(member, "Erase this unique body", key),
          code("FORBIDDEN"),
        );
        await withOrg(db.owner, orgId, (c) =>
          c.query(
            "UPDATE rootset_control.memberships SET role='member',version=version+1 WHERE user_id=$1",
            [member.userId],
          ),
        );
      },
    );

    await t.test(
      "foreign keys, RLS, one-way deletion, and deleted-user attribution",
      async () => {
        const departed = await person("Departed author", "member");
        const comment = await create(departed, "Keep my attribution");
        const removed = await create(
          departed,
          "Clear my text, keep my attribution",
        );
        await remove(departed, removed.id);
        const deletedBeforeUserRemoval = (await list()).data.find(
          (entry) => entry.id === removed.id,
        )!;
        for (const changes of [
          "body='edited'",
          "body='',deleted_at=clock_timestamp(),author_name_snapshot='Forged'",
          "body='',deleted_at=clock_timestamp(),created_at=clock_timestamp()",
          "deleted_at=clock_timestamp()",
        ])
          await assert.rejects(
            withOrg(db.owner, orgId, (c) =>
              c.query(
                `UPDATE rootset_control.row_comments SET ${changes} WHERE id=$1`,
                [comment.id],
              ),
            ),
            { code: "23514" },
          );
        await withOrg(db.owner, newId(), async (c) => {
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int AS count FROM rootset_control.row_comments",
              )
            ).rows[0].count,
            0,
          );
        });
        await withOrg(db.owner, orgId, (c) =>
          c.query("DELETE FROM rootset_control.memberships WHERE user_id=$1", [
            departed.userId,
          ]),
        );
        await db.owner.query("DELETE FROM rootset_control.users WHERE id=$1", [
          departed.userId,
        ]);
        const saved = (await list()).data[0]!;
        assert.equal(saved.authorName, "Departed author");
        assert.equal(saved.authorUserId, null);
        assert.equal(saved.canDelete, true);
        assert.deepEqual(
          (await list()).data.find((entry) => entry.id === removed.id),
          { ...deletedBeforeUserRemoval, authorUserId: null },
        );
        await remove(admin, comment.id);
        await withOrg(db.owner, orgId, async (c) => {
          await assert.rejects(
            c.query(
              "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_name_snapshot,actor,body) VALUES($1,$2,$3,$4,'Forged','{}','x')",
              [newId(), orgId, newId(), row.id],
            ),
            { code: "23503" },
          );
        });
      },
    );

    await t.test(
      "browser, REST and MCP share the catalog, identities and deletion rules",
      async () => {
        const issued = KeyCreatedSchema.parse(
          await runtime!.core.execute(
            "createPersonalKey",
            member,
            {
              orgId,
              name: "Comment fixture key",
              access: "edit",
              includeAdmin: false,
              expiresAt: "2030-01-01T00:00:00.000Z",
            },
            { idempotencyKey: newId() },
          ),
        );
        const basePath = `/v1/orgs/${orgId}/databases/${database.id}/tables/${table.id}/rows/${row.id}/comments`;
        const rest = await app!.request(basePath, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${issued.secret}`,
            "Content-Type": "application/json",
            "Idempotency-Key": newId(),
          },
          body: JSON.stringify({ workspaceId: orgId, body: "From REST" }),
        });
        assert.equal(rest.status, 201, await rest.clone().text());
        const created = (await rest.json()) as { id: string };
        const browser = await app!.request(
          `${basePath.replace("/v1", "/api/internal/v1")}?workspaceId=${orgId}`,
          { headers: { Cookie: cookie, Origin: baseURL } },
        );
        assert.equal(browser.status, 200);
        assert.equal(
          ((await browser.json()) as Page).data[0]?.authorName,
          "Morgan Member",
        );
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
            requestInit: {
              headers: { Authorization: `Bearer ${issued.secret}` },
            },
          }),
        );
        const tools = (await mcp.listTools()).tools;
        assert(
          !tools.some((tool) => /(?:update|edit).*comment/.test(tool.name)),
        );
        for (const operation of [
          "listRowComments",
          "countRowComments",
          "createRowComment",
          "deleteRowComment",
        ])
          assert(
            tools.some(
              (tool) => tool.name === getOperation(operation).toolName,
            ),
          );
        const call = async (
          operation: string,
          input: Record<string, unknown>,
        ) => {
          const result = await mcp.callTool({
            name: getOperation(operation).toolName,
            arguments: {
              ...input,
              ...(getOperation(operation).idempotencyRequired
                ? { idempotencyKey: newId() }
                : {}),
            },
          });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return getOperation(operation).outputSchema.parse(
            result.structuredContent,
          );
        };
        assert.equal(
          ((await call("listRowComments", target)) as Page).data[0]?.id,
          created.id,
        );
        await call("createRowComment", { ...target, body: "From MCP" });
        assert.equal(
          (
            (await call("countRowComments", { ...ids, rowIds: [row.id] })) as {
              data: { count: number }[];
            }
          ).data[0]?.count,
          2,
        );
        await call("deleteRowComment", { ...target, commentId: created.id });
        const deleted = ((await call("listRowComments", target)) as Page)
          .data[0]!;
        assert.equal(deleted.id, created.id);
        assert.equal(deleted.body, "");
        assert(deleted.deletedAt);
        assert.equal(deleted.canDelete, false);
        for (const comment of (await list()).data)
          await remove(admin, comment.id);
        const team = KeyCreatedSchema.parse(
          await execute("createWorkspaceKey", admin, {
            orgId,
            name: "Fleet bot",
            access: "edit",
            includeAdmin: false,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        );
        const teamActor = await runtime!.identity.resolveActor(
          new Request(baseURL, {
            headers: { Authorization: `Bearer ${team.secret}` },
          }),
          "rest",
        );
        assert(teamActor);
        const teamComment = await create(teamActor, "From the fleet bot");
        const savedTeamComment = (await list()).data.find(
          (entry) => entry.id === teamComment.id,
        )!;
        assert.equal(savedTeamComment.authorName, "Fleet bot");
        assert.equal(savedTeamComment.authorUserId, null);
        await assert.rejects(remove(member, teamComment.id), code("FORBIDDEN"));
        await remove(teamActor, teamComment.id);
      },
    );

    await t.test(
      "row deletion races leave no orphan bodies, and parent cleanup removes discussions",
      async () => {
        async function blockedOnRow() {
          for (let attempt = 0; attempt < 200; attempt++) {
            const blocked = await db.owner.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'",
            );
            if (blocked.rows[0]!.count > 0) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.fail("Expected the operation to wait for the held row lock");
        }
        const lockRow = async (rowId: string) => {
          const client = await db.app.connect();
          await client.query("BEGIN");
          await client.query("SELECT set_config('rootset.org_id',$1,true)", [
            orgId,
          ]);
          await client.query(
            `SELECT row_id FROM "${table.schemaName}"."${table.physicalName}" WHERE row_id=$1 FOR UPDATE`,
            [rowId],
          );
          return client;
        };
        for (const commentsFirst of [true, false]) {
          const victim = await runtime!.storage.createRow(admin, table.id, {
            REGISTRATION: "LOCK-ORDER",
          });
          const lock = await lockRow(victim.id);
          const comment = () =>
            create(member, "Concurrent comment", newId(), {
              ...target,
              rowId: victim.id,
            });
          const deletion = (): Promise<unknown> =>
            runtime!.storage.deleteRow(admin, table.id, victim.id, {
              expectedVersion: victim.version,
              idempotencyKey: newId(),
            });
          const first = commentsFirst ? comment() : deletion();
          // Attach handlers while PostgreSQL is blocked, so rejection is never unhandled.
          const firstResult = Promise.allSettled([first]);
          await blockedOnRow();
          const secondResult = Promise.allSettled([
            commentsFirst ? deletion() : comment(),
          ]);
          await lock.query("COMMIT");
          lock.release();
          assert.equal((await firstResult)[0]!.status, "fulfilled");
          const secondOutcome = (await secondResult)[0]!;
          if (commentsFirst) assert.equal(secondOutcome.status, "fulfilled");
          else {
            assert.equal(secondOutcome.status, "rejected");
            assert(
              secondOutcome.status === "rejected" &&
                code("RESOURCE_NOT_FOUND")(secondOutcome.reason),
            );
          }
          await withOrg(db.owner, orgId, async (c) =>
            assert.equal(
              (
                await c.query(
                  "SELECT count(*)::int AS count FROM rootset_control.row_comments WHERE row_id=$1",
                  [victim.id],
                )
              ).rows[0].count,
              0,
            ),
          );
        }
        const lock = await lockRow(row.id);
        const waiting = Promise.allSettled([
          create(member, "Demoted while waiting"),
        ]);
        await blockedOnRow();
        await withOrg(db.owner, orgId, (c) =>
          c.query(
            "UPDATE rootset_control.memberships SET role='viewer',version=version+1 WHERE user_id=$1",
            [member.userId],
          ),
        );
        await lock.query("COMMIT");
        lock.release();
        const denied = (await waiting)[0]!;
        assert(
          denied.status === "rejected" && code("FORBIDDEN")(denied.reason),
        );
        await withOrg(db.owner, orgId, (c) =>
          c.query(
            "UPDATE rootset_control.memberships SET role='member',version=version+1 WHERE user_id=$1",
            [member.userId],
          ),
        );
        for (let i = 0; i < 6; i++) {
          const victim = await runtime!.storage.createRow(admin, table.id, {
            REGISTRATION: `RACE-${i}`,
          });
          const outcomes: PromiseSettledResult<unknown>[] =
            await Promise.allSettled([
              create(member, "Racing comment", newId(), {
                ...target,
                rowId: victim.id,
              }),
              runtime!.storage.deleteRow(admin, table.id, victim.id, {
                expectedVersion: victim.version,
                idempotencyKey: newId(),
              }),
            ]);
          assert.equal(outcomes[1]!.status, "fulfilled");
          if (outcomes[0]!.status === "rejected")
            assert(code("RESOURCE_NOT_FOUND")(outcomes[0]!.reason));
          await withOrg(db.owner, orgId, async (c) =>
            assert.equal(
              (
                await c.query(
                  "SELECT count(*)::int AS count FROM rootset_control.row_comments WHERE row_id=$1",
                  [victim.id],
                )
              ).rows[0].count,
              0,
            ),
          );
        }
        await create(member, "Remove with table");
        await runtime!.storage.deleteTable(admin, table.id, {
          expectedSchemaVersion: table.schemaVersion,
          idempotencyKey: newId(),
        });
        await assert.rejects(list(), code("RESOURCE_NOT_FOUND"));
        await withOrg(db.owner, orgId, async (c) =>
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int AS count FROM rootset_control.row_comments",
              )
            ).rows[0].count,
            0,
          ),
        );
        const otherTable = await runtime!.storage.createTable(
          admin,
          database.id,
          { name: "Other", fields: [] },
        );
        const otherRow = await runtime!.storage.createRow(
          admin,
          otherTable.id,
          {},
        );
        await create(member, "Remove with database", newId(), {
          ...ids,
          tableId: otherTable.id,
          rowId: otherRow.id,
        });
        await runtime!.storage.deleteDatabase(admin, database.id, {
          idempotencyKey: newId(),
        });
        await withOrg(db.owner, orgId, async (c) =>
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int AS count FROM rootset_control.row_comments",
              )
            ).rows[0].count,
            0,
          ),
        );
        assert.equal(
          await execute<Row>("getRow", admin, { ...ids, rowId: row.id }).catch(
            () => null,
          ),
          null,
        );
      },
    );
  } finally {
    await mcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime?.close();
    await db.close();
  }
});
