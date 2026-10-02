import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Pool } from "pg";
import { OAuthService } from "@rootset/oauth";
import {
  newId,
  operations,
  RootsetError,
  limits,
  type Actor,
} from "@rootset/contracts";
import { createApp, MCP_PROTOCOL_VERSION } from "./app.js";
import { readJson } from "./json.js";
import { httpServerOptions } from "./http-server.js";

const databaseURL = process.env.ROOTSET_TEST_DATABASE_URL,
  identityURL = process.env.ROOTSET_TEST_IDENTITY_DATABASE_URL,
  appURL = process.env.ROOTSET_TEST_APP_DATABASE_URL;

test("strict HTTP decoding rejects duplicate keys, malformed UTF-8 and oversized streamed bodies", async () => {
  await assert.rejects(
    readJson(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/jsonp" },
        body: "{}",
      }),
    ),
    (error) => error instanceof RootsetError && error.status === 415,
  );
  await assert.rejects(
    readJson(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"value":1,"value":2}',
      }),
    ),
    /Duplicate|duplicate/,
  );
  await assert.rejects(
    readJson(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Uint8Array.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]),
      }),
    ),
    /UTF-8/,
  );
  await assert.rejects(
    readJson(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"x":"' + "x".repeat(500) + '"}',
      }),
      64,
    ),
    /budget|limit/,
  );
  let pulls = 0;
  const declaredOversize = new Request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(limits.requestBytes + 1),
    },
    body: new ReadableStream(
      {
        pull() {
          pulls++;
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    readJson(declaredOversize),
    (error) => error instanceof RootsetError && error.status === 413,
  );
  assert.equal(pulls, 0, "declared oversize is rejected before reading");
  const stalled = new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    readJson(stalled, limits.requestBytes, 25),
    (error) =>
      error instanceof RootsetError &&
      error.code === "REQUEST_TIMEOUT" &&
      error.status === 408,
  );
});

test(
  "real HTTP and MCP SDK client negotiate, discover every tool and enforce OAuth audience/typed error transport",
  { skip: !databaseURL },
  async () => {
    const owner = new Pool({ connectionString: databaseURL }),
      issuer = new Pool({ connectionString: identityURL ?? databaseURL }),
      pool = new Pool({ connectionString: appURL ?? databaseURL });
    const userId = newId(),
      orgId = newId(),
      databaseId = newId(),
      tableId = newId(),
      rowId = newId();
    const actor: Actor = {
      kind: "session",
      id: `user:${userId}`,
      userId,
      orgId,
      role: "owner",
      scopes: ["rows:read"],
      targets: [],
      unrestricted: true,
    };
    await owner.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
      [
        userId,
        "HTTP verification",
        `${userId.toLowerCase()}@transport.example`,
      ],
    );
    await owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
      [orgId, "HTTP verification"],
    );
    await owner.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [newId(), orgId, userId],
    );
    let baseURL = "http://127.0.0.1:4310";
    const session = async (request: Request) =>
      request.headers.get("cookie") === "test=session" ? actor : null;
    const identity = {
      auth: { handler: async () => Response.json({}) },
      resolveActor: async (request: Request, audience: string) =>
        audience === "browser"
          ? session(request)
          : oauth.resolveActor(request, audience),
      setupStatus: async () => ({ claimed: true }),
      claimSetup: async () => ({ claimed: true }),
      approveAction: async () => ({ approved: true }),
    };
    // This integration isolates transport and permission plumbing. Domain CRUD is exercised by the candidate verification suite.
    let transportFailure: Error | undefined;
    const core = {
      execute: async (operationId: string, caller: Actor, input: unknown) => {
        if (transportFailure) throw transportFailure;
        const operation = operations.find((op) => op.id === operationId)!;
        if (operation.scopes.some((scope) => !caller.scopes.includes(scope)))
          throw new RootsetError("ACCESS_DENIED", "Scope unavailable.", 403);
        if (operationId !== "queryRows")
          throw new RootsetError(
            "RESOURCE_NOT_FOUND",
            "Operation fixture unavailable.",
            404,
          );
        const query = (input as { query?: { limit?: number } }).query;
        const data = [
          {
            id: rowId,
            version: "9007199254740993",
            createdAt: "2026-10-02T12:00:00.000Z",
            updatedAt: "2026-10-02T12:00:00.000Z",
            values: { NAME: "Airline", COUNT: 1, CONFIG: { active: true } },
          },
        ];
        if (query?.limit === 25000) data[0]!.values.NAME = "x".repeat(65536);
        const rows =
          query?.limit === 25000
            ? Array.from({ length: 100 }, () => ({ ...data[0]!, id: newId() }))
            : data;
        return {
          data: rows,
          schemaVersion: 1,
          page: {
            returned: rows.length,
            requestedLimit: query?.limit ?? 5000,
            hasMore: false,
            nextCursor: null,
            stopReason: "end",
            consistency: "live",
          },
        };
      },
    };
    const server = serve({
      serverOptions: httpServerOptions,
      fetch: (request) => app.fetch(request),
      hostname: "127.0.0.1",
      port: 0,
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    baseURL = `http://127.0.0.1:${address.port}`;
    const clientId = "transport-verification-client",
      redirect = "https://client.example/return";
    const oauth = new OAuthService(issuer, {
      baseURL,
      scopes: ["rows:read", "rows:write"],
      clients: [
        {
          client_id: clientId,
          client_name: "Transport verification",
          redirect_uris: [redirect],
        },
      ],
      resolveSession: session,
    });
    let readiness: "healthy" | "failed" | "throws" = "healthy";
    const observed: {
      requestId: string;
      operationId: string;
      status: number;
      durationMs: number;
      errorCode?: string;
    }[] = [];
    const app = createApp({
      pool,
      config: { baseURL },
      core,
      identity,
      oauth,
      observer: {
        record: (event) => {
          observed.push(event);
        },
      },
      getReadiness: async () => {
        if (readiness === "throws")
          throw new Error("private connection details");
        return {
          healthy: readiness === "healthy",
          dependencies: {
            postgresql: "healthy",
            migrations: "healthy",
            worker: readiness === "healthy" ? "healthy" : "stale",
            objectStorage: readiness === "healthy" ? "healthy" : "unavailable",
            smtp: "healthy",
            storageAdmission: readiness === "healthy" ? "healthy" : "degraded",
            password: "private connection details",
          },
        };
      },
    });
    assert.equal((await fetch(`${baseURL}/health/ready`)).status, 200);
    readiness = "failed";
    const failedReadiness = await fetch(`${baseURL}/health/ready`);
    assert.equal(failedReadiness.status, 503);
    assert.deepEqual(await failedReadiness.json(), {
      status: "not_ready",
      dependencies: {
        postgresql: "healthy",
        migrations: "healthy",
        worker: "stale",
        objectStorage: "unavailable",
        smtp: "healthy",
        storageAdmission: "degraded",
      },
    });
    assert.equal((await fetch(`${baseURL}/health/live`)).status, 200);
    readiness = "throws";
    const unavailableReadiness = await fetch(`${baseURL}/health/ready`);
    assert.equal(unavailableReadiness.status, 503);
    assert.deepEqual(await unavailableReadiness.json(), {
      status: "not_ready",
    });
    readiness = "healthy";
    assert.equal((await fetch(`${baseURL}/health/ready`)).status, 200);
    const grant = async (resource: string) => {
      const verifier = randomBytes(40).toString("base64url"),
        challenge = createHash("sha256").update(verifier).digest("base64url");
      const url = new URL(`${baseURL}/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource,
        organization_id: orgId,
        scope: "rows:read",
      }).toString();
      const authorization = await fetch(url, {
        headers: { Cookie: "test=session" },
        redirect: "manual",
      });
      assert.equal(authorization.status, 302);
      const requestId = new URL(
        authorization.headers.get("location")!,
      ).searchParams.get("requestId")!;
      const details = await fetch(
        `${baseURL}/api/internal/v1/oauth/requests/${requestId}`,
        { headers: { Cookie: "test=session" } },
      );
      assert.equal(details.status, 200);
      const decision = await fetch(
        `${baseURL}/api/internal/v1/oauth/requests/${requestId}/decision`,
        {
          method: "POST",
          headers: {
            Cookie: "test=session",
            Origin: baseURL,
            "Content-Type": "application/json",
          },
          body: '{"approve":true}',
        },
      );
      assert.equal(decision.status, 200);
      const approved = await decision.json(),
        code = new URL(approved.redirectUri).searchParams.get("code")!;
      const response = await fetch(`${baseURL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirect,
          resource,
          code,
          code_verifier: verifier,
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).access_token as string;
    };
    const client = new Client({
      name: "Rootset verification client",
      version: "1.0.0",
    });
    const oauthClient = new Client({
      name: "Rootset OAuth SDK verification",
      version: "1.0.0",
    });
    try {
      const mcpToken = await grant(`${baseURL}/mcp`),
        restToken = await grant(`${baseURL}/v1`);
      const stalledBody = (path: string, headers: Record<string, string>) =>
        new Promise<{
          status: number;
          body: Record<string, unknown>;
        }>((resolve, reject) => {
          const pending = httpRequest(
            `${baseURL}${path}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Transfer-Encoding": "chunked",
                ...headers,
              },
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => {
                pending.destroy();
                resolve({
                  status: response.statusCode!,
                  body: JSON.parse(body),
                });
              });
              response.on("error", reject);
            },
          );
          pending.on("error", reject);
          pending.write("{");
        });
      const [stalledRest, stalledMcp, stalledAuth, stalledOauth] =
        await Promise.all([
          stalledBody(
            `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
            { Authorization: `Bearer ${restToken}` },
          ),
          stalledBody("/mcp", {
            Authorization: `Bearer ${mcpToken}`,
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          }),
          stalledBody("/v1/auth/sign-in/email", {}),
          stalledBody("/oauth/token", {
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        ]);
      for (const response of [
        stalledRest,
        stalledMcp,
        stalledAuth,
        stalledOauth,
      ])
        assert.equal(response.status, 408);
      for (const response of [stalledRest, stalledAuth])
        assert.equal(
          (response.body.error as { code: string }).code,
          "REQUEST_TIMEOUT",
        );
      assert.equal(
        (stalledMcp.body.error as { data: { error: { code: string } } }).data
          .error.code,
        "REQUEST_TIMEOUT",
      );
      assert.equal(stalledOauth.body.error, "invalid_request");
      assert.equal((await fetch(`${baseURL}/health/ready`)).status, 200);
      const spec = await (await fetch(`${baseURL}/v1/openapi.json`)).json();
      assert.equal(spec.openapi, "3.1.2");
      const transport = new StreamableHTTPClientTransport(
        new URL(`${baseURL}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } },
      );
      await client.connect(transport);
      assert.equal(transport.protocolVersion, MCP_PROTOCOL_VERSION);
      assert.equal(client.getServerVersion()?.name, "Rootset");
      const tools = await client.listTools();
      assert.equal(tools.tools.length, operations.length);
      assert(Buffer.byteLength(JSON.stringify(tools)) < 1_048_576);
      const protocolHeaders = {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      };
      for (const body of [
        JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x".repeat(129),
          method: "tools/list",
        }),
        '{"jsonrpc":"2.0","id":9007199254740990.5,"method":"tools/list"}',
      ]) {
        const denied = await fetch(`${baseURL}/mcp`, {
          method: "POST",
          headers: protocolHeaders,
          body,
        });
        assert.equal(denied.status, 400);
        assert.equal((await denied.json()).error.code, -32600);
      }
      const malformed = await fetch(`${baseURL}/mcp`, {
        method: "POST",
        headers: protocolHeaders,
        body: '{"jsonrpc":"2.0","id":1,"id":2,"method":"tools/list"}',
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, -32700);
      const result = await client.callTool({
        name: "rootset_query_rows",
        arguments: { orgId, databaseId, tableId, query: {} },
      });
      assert.equal(
        (result.structuredContent as { page: { requestedLimit: number } }).page
          .requestedLimit,
        200,
      );
      assert(Array.isArray(result.content));
      assert.equal(result.content.length, 1);
      assert(!JSON.stringify(result.content).includes("Airline"));
      assert(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
      const oversized = await client.callTool({
        name: "rootset_query_rows",
        arguments: { orgId, databaseId, tableId, query: { limit: 25000 } },
      });
      assert.equal(oversized.isError, true);
      assert.equal(
        (oversized.structuredContent as { error: { code: string } }).error.code,
        "PAYLOAD_TOO_LARGE",
      );
      assert(Buffer.byteLength(JSON.stringify(oversized)) < 1024 * 1024);
      for (const [message, status, code] of [
        [
          "timeout exceeded when trying to connect",
          503,
          "DEPENDENCY_UNAVAILABLE",
        ],
        [
          "Connection terminated due to connection timeout",
          503,
          "DEPENDENCY_UNAVAILABLE",
        ],
        [
          "Unexpected programming failure: synthetic password=private SELECT",
          500,
          "INTERNAL_ERROR",
        ],
      ] as const) {
        transportFailure = new Error(message);
        const rest = await fetch(
          `${baseURL}/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${restToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: { limit: 1 } }),
          },
        );
        assert.equal(rest.status, status);
        const restFailure = await rest.json();
        assert.equal(restFailure.error.code, code);
        assert.equal(
          rest.headers.get("retry-after"),
          status === 503 ? "1" : null,
        );
        const mcp = await client.callTool({
          name: "rootset_query_rows",
          arguments: { orgId, databaseId, tableId, query: { limit: 1 } },
        });
        assert.equal(mcp.isError, true);
        assert.equal(
          (mcp.structuredContent as typeof restFailure).error.code,
          code,
        );
        if (status === 503)
          assert.equal(
            (mcp.structuredContent as typeof restFailure).error.details
              .retryAfter,
            1,
          );
        assert.ok(!JSON.stringify([restFailure, mcp]).includes(message));
        assert.ok(
          observed.some(
            (event) =>
              event.operationId === "queryRows" && event.errorCode === code,
          ),
        );
      }
      transportFailure = undefined;
      const unauthenticated = await fetch(`${baseURL}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "invented-session",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list" }),
      });
      assert.equal(unauthenticated.status, 401);
      const deniedTool = {
        name: "rootset_create_row",
        arguments: {
          orgId,
          databaseId,
          tableId,
          values: { NAME: "Denied" },
          expectedSchemaVersion: 1,
          idempotencyKey: "deny-row-00001",
        },
      };
      await assert.rejects(
        client.callTool(deniedTool),
        (error) =>
          error instanceof Error && "code" in error && error.code === 403,
      );
      const scopeChallenge = await fetch(`${baseURL}/mcp`, {
        method: "POST",
        headers: protocolHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: deniedTool,
        }),
      });
      assert.equal(scopeChallenge.status, 403);
      assert.match(
        scopeChallenge.headers.get("www-authenticate") ?? "",
        /error="insufficient_scope"/,
      );
      assert.match(
        scopeChallenge.headers.get("www-authenticate") ?? "",
        /scope="rows:read rows:write"/,
      );
      const denied = await fetch(
        `${baseURL}/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${mcpToken}`,
            "Content-Type": "application/json",
          },
          body: '{"query":{}}',
        },
      );
      assert.equal(denied.status, 401);
      assert(
        denied.headers
          .get("www-authenticate")
          ?.includes("oauth-protected-resource/v1"),
      );
      const rest = await fetch(
        `${baseURL}/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${restToken}`,
            "Content-Type": "application/json",
          },
          body: '{"query":{}}',
        },
      );
      assert.equal(rest.status, 200);
      assert.equal((await rest.json()).page.requestedLimit, 5000);
      const duplicate = await fetch(
        `${baseURL}/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${restToken}`,
            "Content-Type": "application/json",
          },
          body: '{"query":{},"query":{}}',
        },
      );
      assert.equal(duplicate.status, 400);
      let storedTokens: OAuthTokens | undefined,
        storedVerifier = "",
        authorizationCode = "";
      const provider: OAuthClientProvider = {
        redirectUrl: redirect,
        clientMetadata: {
          client_name: "Transport verification",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
          scope: "rows:read",
        },
        clientInformation: () => ({ client_id: clientId, issuer: baseURL }),
        tokens: () => storedTokens,
        saveTokens: (value) => {
          storedTokens = value;
        },
        saveCodeVerifier: (value) => {
          storedVerifier = value;
        },
        codeVerifier: () => storedVerifier,
        state: () => "sdk-bound-state",
        redirectToAuthorization: async (url) => {
          const authorization = await fetch(url, {
            headers: { Cookie: "test=session" },
            redirect: "manual",
          });
          assert.equal(authorization.status, 302);
          const requestId = new URL(
            authorization.headers.get("location")!,
          ).searchParams.get("requestId")!;
          assert.equal(
            (
              await fetch(
                `${baseURL}/api/internal/v1/oauth/requests/${requestId}`,
                { headers: { Cookie: "test=session" } },
              )
            ).status,
            200,
          );
          const consent = await fetch(
            `${baseURL}/api/internal/v1/oauth/requests/${requestId}/decision`,
            {
              method: "POST",
              headers: {
                Cookie: "test=session",
                Origin: baseURL,
                "Content-Type": "application/json",
              },
              body: '{"approve":true}',
            },
          );
          assert.equal(consent.status, 200);
          const callback = new URL((await consent.json()).redirectUri);
          assert.equal(callback.searchParams.get("state"), "sdk-bound-state");
          assert.equal(callback.searchParams.get("iss"), baseURL);
          authorizationCode = callback.searchParams.get("code")!;
        },
      };
      const oauthTransport = new StreamableHTTPClientTransport(
        new URL(`${baseURL}/mcp`),
        { authProvider: provider },
      );
      await assert.rejects(oauthClient.connect(oauthTransport), /Unauthorized/);
      assert(authorizationCode);
      await oauthTransport.finishAuth(authorizationCode);
      await oauthClient.close();
      await oauthClient.connect(
        new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
          authProvider: provider,
        }),
      );
      assert.equal(
        (await oauthClient.listTools()).tools.length,
        operations.length,
      );
      assert.equal(storedTokens?.token_type, "Bearer");
      await owner.query(
        "UPDATE rootset_control.oauth_grants SET revoked_at=now() WHERE user_id=$1",
        [userId],
      );
      await assert.rejects(client.listTools());
      assert(observed.some((event) => event.operationId === "queryRows"));
      assert(
        observed.some(
          (event) =>
            event.operationId === "healthReady" && event.status === 503,
        ),
      );
      assert(observed.some((event) => event.operationId === "oauthToken"));
      for (const event of observed) {
        assert.match(event.requestId, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        assert.match(event.operationId, /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/);
        assert(Number.isFinite(event.durationMs) && event.durationMs >= 0);
        assert(
          Object.keys(event).every((key) =>
            [
              "requestId",
              "operationId",
              "status",
              "durationMs",
              "errorCode",
            ].includes(key),
          ),
        );
      }
      assert(!JSON.stringify(observed).includes("private connection details"));
      assert(!JSON.stringify(observed).includes(mcpToken));
    } finally {
      await client.close();
      await oauthClient.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await owner.query(
        "UPDATE rootset_control.users SET disabled=true WHERE id=$1",
        [userId],
      );
      await pool.end();
      await issuer.end();
      await owner.end();
    }
  },
);
