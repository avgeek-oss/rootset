import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import { getOperation, newId, type Actor } from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createRuntimeApp } from "./runtime-app.js";
import { httpServerOptions } from "./http-server.js";

test("REST and MCP require explicit workspace scope and enforce workspace key and deletion boundaries", async () => {
  const db = await isolatedDatabase();
  let app: ReturnType<typeof createRuntimeApp> | undefined;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
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
  const client = new Client({
    name: "Workspace boundary verification",
    version: "1.0.0",
  });
  try {
    runtime = await createRuntime({
      ...loadConfig(),
      baseURL,
      webURL: baseURL,
      databaseURL: db.app.options.connectionString!,
    });
    app = createRuntimeApp(runtime);
    const orgId = newId(),
      userId = newId(),
      sessionId = newId();
    await db.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Workspace transport fixture')",
      [orgId],
    );
    await db.owner.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Admin','workspace-admin@example.test',true)",
      [userId],
    );
    await db.owner.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')",
      [newId(), orgId, userId],
    );
    await db.owner.query(
      "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [sessionId, userId, newId()],
    );
    const admin: Actor = {
      kind: "session",
      id: sessionId,
      userId,
      orgId,
      role: "admin",
      scopes: [],
      authenticatedAt: Date.now(),
    };
    const issued = (await runtime.core.execute(
      "createPersonalKey",
      admin,
      {
        orgId,
        name: "Transport admin",
        access: "edit",
        includeAdmin: true,
        expiresAt: null,
      },
      { idempotencyKey: newId() },
    )) as { secret: string };
    const request = (
      path: string,
      method = "GET",
      body?: Record<string, unknown>,
      secret = issued.secret,
    ) =>
      app!.request(`/v1/orgs/${orgId}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": newId(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const missing = await request("/databases");
    assert.equal(missing.status, 422, await missing.clone().text());
    const defaultList = await request(`/databases?workspaceId=${orgId}`);
    assert.equal(defaultList.status, 200, await defaultList.clone().text());
    const created = await request("/workspaces", "POST", {
      name: "Private",
      description: "Transport scope",
    });
    assert.equal(created.status, 201, await created.clone().text());
    const workspace = (await created.json()) as { id: string };
    const database = await request("/databases", "POST", {
      workspaceId: workspace.id,
      name: "Private data",
    });
    assert.equal(database.status, 201, await database.clone().text());
    const privateDatabase = (await database.json()) as { id: string };
    const wrongWorkspace = await request(
      `/databases/${privateDatabase.id}?workspaceId=${orgId}`,
    );
    assert.equal(
      wrongWorkspace.status,
      404,
      await wrongWorkspace.clone().text(),
    );
    const notEmpty = await request(`/workspaces/${workspace.id}`, "DELETE");
    assert.equal(notEmpty.status, 422, await notEmpty.clone().text());
    const keyResponse = await request("/workspace-keys", "POST", {
      workspaceId: workspace.id,
      name: "Private automation",
      access: "read",
      includeAdmin: false,
      expiresAt: null,
    });
    assert.equal(keyResponse.status, 201, await keyResponse.clone().text());
    const key = (await keyResponse.json()) as { secret: string };
    assert.equal(
      (
        await request(
          `/databases?workspaceId=${workspace.id}`,
          "GET",
          undefined,
          key.secret,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/databases?workspaceId=${orgId}`,
          "GET",
          undefined,
          key.secret,
        )
      ).status,
      404,
    );
    assert.equal((await request("/team-keys")).status, 404);
    await db.owner.query(
      "UPDATE rootset_control.memberships SET role='member' WHERE org_id=$1 AND user_id=$2",
      [orgId, userId],
    );
    assert.equal(
      (
        await request("/workspace-keys", "POST", {
          workspaceId: workspace.id,
          name: "Denied",
          access: "read",
          includeAdmin: false,
          expiresAt: null,
        })
      ).status,
      403,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
      }),
    );
    const tool = getOperation("listDatabases").toolName;
    const absent = await client.callTool({ name: tool, arguments: { orgId } });
    assert.equal(absent.isError, true);
    const own = await client.callTool({
      name: tool,
      arguments: { orgId, workspaceId: workspace.id },
    });
    assert.notEqual(own.isError, true, JSON.stringify(own));
    assert.equal(
      (own.structuredContent as { data: { id: string }[] }).data[0]?.id,
      privateDatabase.id,
    );
    const other = await client.callTool({
      name: tool,
      arguments: { orgId, workspaceId: orgId },
    });
    assert.equal(other.isError, true);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime?.close();
    await db.close();
  }
});
