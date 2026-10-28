import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { StorageConflictError } from "@avgeek-oss/agent-core";
import { newId } from "@rootset/contracts";
import { loadConfig } from "@rootset/core/config";
import { createRuntime } from "@rootset/core/runtime";
import { withOrg } from "@rootset/database";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { assistantProviderFixture } from "./assistant-provider.fixture.js";
import { assistantStorage } from "./assistant-storage.js";
import { createRuntimeApp } from "./runtime-app.js";

test("assistant enforces approval, live session authority, private workspace history and scoped storage", async (t) => {
  const db = await isolatedDatabase();
  const provider = await assistantProviderFixture();
  delete process.env.AGENT_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.AGENT_HEADERS = "{}";
  process.env.AGENT_API_KEY = "assistant-local-fixture";
  process.env.AGENT_BASE_URL = provider.url;
  process.env.AGENT_MODEL = "fixture-model";
  process.env.AGENT_PROFILE = "compatible";
  const config = {
    ...loadConfig(),
    databaseURL: db.app.options.connectionString!,
    baseURL: "http://localhost:4310",
    webURL: "http://localhost:4300",
  };
  const runtime = await createRuntime(config);
  const app = createRuntimeApp(runtime);
  let server: ReturnType<typeof serve>;
  const origin = await new Promise<string>((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      (info) => resolve(`http://127.0.0.1:${info.port}`),
    );
  });
  const request = (
    path: string,
    body?: unknown,
    cookie?: string,
    workspaceId?: string,
    headers: Record<string, string> = {},
  ) =>
    fetch(
      `${origin}/api/internal/v1/agent${path}${workspaceId ? `?workspaceId=${workspaceId}` : ""}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: config.webURL,
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  try {
    const setup = await app.request("/v1/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.webURL },
      body: JSON.stringify({
        bootstrapSecret: config.bootstrapSecret,
        name: "Assistant owner",
        email: "assistant-owner@example.test",
        password: "Rootset assistant fixture password 2026!",
        organisationName: "Assistant fixture",
      }),
    });
    assert.equal(setup.status, 201, await setup.clone().text());
    const { userId, orgId } = (await setup.json()) as {
      userId: string;
      orgId: string;
    };
    const login = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.webURL },
      body: JSON.stringify({
        email: "assistant-owner@example.test",
        password: "Rootset assistant fixture password 2026!",
      }),
    });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const ownerId = `${userId}:${orgId}:${orgId}`;
    const stream = async (body: unknown, workspaceId = orgId) => {
      const response = await request("/steps", body, cookie, workspaceId);
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(response.headers.get("cache-control") ?? "", /no-transform/);
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      assert.equal(
        events.some((event) => event.type === "error"),
        false,
        JSON.stringify(events),
      );
      const id = events.find(
        (event) => event.type === "step_started",
      )?.conversationId;
      assert.equal(typeof id, "string");
      return { id: String(id), events };
    };
    const decide = (id: string, approved: boolean) => ({
      type: "resolve_tool_calls",
      conversationId: id,
      resolutions: [
        { kind: "confirmation", toolUseId: "fixture-call", approved },
      ],
    });
    const propose = async (name: string) => {
      provider.reply({
        name: "rootset_create_database",
        input: { orgId, workspaceId: orgId, name, idempotencyKey: newId() },
      });
      const turn = await stream({
        type: "user_message",
        text: `Create a database called ${name}.`,
      });
      assert(
        turn.events.some((event) => event.type === "awaiting_input"),
        JSON.stringify(turn.events),
      );
      assert.equal(
        (
          await withOrg(db.app, orgId, (client) =>
            client.query(
              "SELECT id FROM rootset_control.databases WHERE name=$1",
              [name],
            ),
          )
        ).rowCount,
        0,
      );
      return turn;
    };
    await t.test(
      "disabled feature and non-browser callers cannot invoke the assistant",
      async () => {
        assert.equal((await request("/status")).status, 401);
        assert.equal(
          (
            await request("/status", undefined, cookie, undefined, {
              Authorization: "Bearer cannot-borrow-cookie",
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request(
              "/steps",
              { type: "user_message", text: "Hello" },
              cookie,
              orgId,
              { Origin: "https://untrusted.example" },
            )
          ).status,
          403,
        );
        delete process.env.AGENT_API_KEY;
        const disabled = createRuntimeApp(runtime);
        const status = await disabled.request("/api/internal/v1/agent/status", {
          headers: { Cookie: cookie },
        });
        assert.deepEqual(await status.json(), { enabled: false });
        assert.equal(
          (
            await disabled.request(
              `/api/internal/v1/agent/conversations?workspaceId=${orgId}`,
              { headers: { Cookie: cookie } },
            )
          ).status,
          404,
        );
        process.env.AGENT_API_KEY = "assistant-local-fixture";
        assert.equal(provider.requests.length, 0);
      },
    );
    await t.test(
      "writes execute only after approval and a decline performs no write",
      async () => {
        const turn = await propose("Approved database");
        const result = await stream(decide(turn.id, true));
        assert(
          result.events.some(
            (event) => event.type === "tool_result" && event.isError === false,
          ),
          JSON.stringify(result.events),
        );
        assert.equal(
          (
            await withOrg(db.app, orgId, (client) =>
              client.query(
                "SELECT id FROM rootset_control.databases WHERE name='Approved database'",
              ),
            )
          ).rowCount,
          1,
        );
        const declined = await propose("Declined database");
        await stream(decide(declined.id, false));
        assert.equal(
          (
            await withOrg(db.app, orgId, (client) =>
              client.query(
                "SELECT id FROM rootset_control.databases WHERE name='Declined database'",
              ),
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      "history survives new storage instances and cannot cross owner/workspace boundaries",
      async () => {
        const turn = await stream({
          type: "user_message",
          text: "A private conversation.",
        });
        const storage = assistantStorage(db.app, orgId, ownerId);
        assert(await storage.getConversation(turn.id, ownerId));
        const otherUser = newId();
        const otherOwner = `${otherUser}:${orgId}:${orgId}`;
        assert.equal(
          await assistantStorage(db.app, orgId, otherOwner).getConversation(
            turn.id,
            otherOwner,
          ),
          null,
        );
        const workspaceId = newId();
        await withOrg(db.owner, orgId, async (client) => {
          await client.query(
            "INSERT INTO rootset_control.workspaces(id,org_id,name) VALUES($1,$2,'Other workspace')",
            [workspaceId, orgId],
          );
          await client.query(
            "INSERT INTO rootset_control.workspace_members(org_id,workspace_id,user_id) VALUES($1,$2,$3)",
            [orgId, workspaceId, userId],
          );
        });
        assert.equal(
          (
            await request(
              `/conversations/${turn.id}`,
              undefined,
              cookie,
              workspaceId,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await request(
              "/steps",
              {
                type: "user_message",
                conversationId: turn.id,
                text: "Continue",
              },
              cookie,
              workspaceId,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await withOrg(db.app, newId(), (client) =>
              client.query(
                "SELECT count(*)::integer AS count FROM rootset_control.agent_conversations",
              ),
            )
          ).rows[0].count,
          0,
        );
        assert.equal(
          (
            await withOrg(db.app, newId(), (client) =>
              client.query(
                "SELECT count(*)::integer AS count FROM rootset_control.agent_messages",
              ),
            )
          ).rows[0].count,
          0,
        );
        const deleted = await app.request(
          `/api/internal/v1/agent/conversations/${turn.id}?workspaceId=${orgId}`,
          {
            method: "DELETE",
            headers: { Cookie: cookie, Origin: config.webURL },
          },
        );
        assert.equal(deleted.status, 204);
        assert.equal((await storage.listMessages(turn.id)).length, 0);
      },
    );
    await t.test(
      "storage commits serialize concurrent steps without losing messages",
      async () => {
        const storage = assistantStorage(db.app, orgId, ownerId);
        const conversation = await storage.createConversation({
          id: crypto.randomUUID(),
          ownerId,
          title: "Concurrent conversation",
        });
        const change = {
          expectedVersion: 0,
          pending: null,
          append: [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: "Only one step may commit." },
              ],
            },
          ],
        };
        const outcomes = await Promise.allSettled([
          storage.commit(conversation.id, change),
          storage.commit(conversation.id, change),
        ]);
        assert.equal(
          outcomes.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const rejected = outcomes.find(
          (result) => result.status === "rejected",
        );
        assert(
          rejected?.status === "rejected" &&
            rejected.reason instanceof StorageConflictError,
        );
        assert.equal((await storage.listMessages(conversation.id)).length, 1);
      },
    );
    await t.test(
      "live role and session revocation block a pending action",
      async () => {
        const turn = await propose("Forbidden after role change");
        await withOrg(db.owner, orgId, async (client) => {
          await client.query(
            "UPDATE rootset_control.memberships SET role='viewer',version=version+1 WHERE org_id=$1 AND user_id=$2",
            [orgId, userId],
          );
        });
        const resumed = await stream(decide(turn.id, true));
        assert(
          resumed.events.some(
            (event) => event.type === "tool_result" && event.isError === true,
          ),
          JSON.stringify(resumed.events),
        );
        assert.equal(
          (
            await withOrg(db.app, orgId, (client) =>
              client.query(
                "SELECT id FROM rootset_control.databases WHERE name='Forbidden after role change'",
              ),
            )
          ).rowCount,
          0,
        );
        await db.owner.query(
          "DELETE FROM rootset_control.sessions WHERE user_id=$1",
          [userId],
        );
        assert.equal(
          (
            await request(
              "/steps",
              { type: "user_message", text: "Try again" },
              cookie,
              orgId,
            )
          ).status,
          401,
        );
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    delete process.env.AGENT_API_KEY;
    await runtime.close();
    await provider.close();
    await db.close();
  }
});
