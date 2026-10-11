import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newId, scopeNames, type Actor } from "@rootset/contracts";
import { loadConfig } from "@rootset/core/config";
import { createRuntime } from "@rootset/core/runtime";
import { OAuthService } from "@rootset/oauth";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createApp } from "./app.js";

const databaseURL = process.env.ROOTSET_TEST_DATABASE_URL;
const codexId = "https://chatgpt.com/oauth/codex/client.json";
const registeredRedirect = "http://127.0.0.1/callback";
const callback = "http://127.0.0.1:51255/callback";

test(
  "Codex native OAuth grants administrator MCP access and follows live membership",
  { skip: !databaseURL },
  async () => {
    const fixture = await isolatedDatabase();
    let app: ReturnType<typeof createApp>;
    const server = serve({
      fetch: (request) => app.fetch(request),
      hostname: "127.0.0.1",
      port: 0,
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseURL = `http://127.0.0.1:${address.port}`;
    const target = new URL(databaseURL!);
    target.pathname = `/${fixture.name}`;
    const runtime = await createRuntime(
      loadConfig({
        ROOTSET_API_URL: baseURL,
        ROOTSET_WEB_URL: baseURL,
        ROOTSET_DATABASE_URL: target.href,
        ROOTSET_SECRET: "fixture-codex-oauth-secret-01234567890123456789",
        ROOTSET_ENCRYPTION_KEY: "a".repeat(64),
        ROOTSET_S3_ENDPOINT: "http://127.0.0.1:9000",
        ROOTSET_S3_BUCKET: "codex-oauth-fixture",
        ROOTSET_S3_ACCESS_KEY: "fixture",
        ROOTSET_S3_SECRET_KEY: "fixture-codex-oauth-storage",
        ROOTSET_SMTP_HOST: "127.0.0.1",
        ROOTSET_SMTP_PORT: "1025",
        ROOTSET_SMTP_SECURE: "false",
        ROOTSET_EMAIL_FROM: "rootset@example.test",
      }),
    );
    const orgId = newId(),
      userId = newId();
    const actor: Actor = {
      id: `user:${userId}`,
      kind: "session",
      userId,
      orgId,
      role: "admin",
      scopes: ["*"],
      authenticatedAt: Date.now(),
    };
    const sdk = new Client({
      name: "Codex compatibility verification",
      version: "1.0.0",
    });
    try {
      await fixture.owner.query(
        "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
        [userId, "Codex verification", `${userId.toLowerCase()}@example.test`],
      );
      await fixture.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
        [orgId, "Codex fixture"],
      );
      await fixture.owner.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')",
        [newId(), orgId, userId],
      );
      const oauth = new OAuthService(fixture.identity, {
        baseURL,
        scopes: scopeNames,
        clients: [
          {
            client_id: codexId,
            client_name: "Codex",
            redirect_uris: [registeredRedirect],
            grant_types: ["authorization_code", "refresh_token"],
            token_endpoint_auth_method: "none",
          },
        ],
        resolveSession: async (request) => {
          if (request.headers.get("cookie") !== "fixture=session") return null;
          const row = (
            await fixture.owner.query(
              "SELECT role FROM rootset_control.memberships WHERE user_id=$1 AND org_id=$2",
              [userId, orgId],
            )
          ).rows[0];
          return row ? { ...actor, role: row.role } : null;
        },
        refreshActor: (incoming) =>
          runtime.identity.refreshActor(incoming).catch(() => null),
      });
      app = createApp({
        ...runtime,
        oauth,
        identity: {
          auth: runtime.identity.auth,
          setupStatus: () => runtime.identity.setupStatus(),
          claimSetup: (input) => runtime.identity.claimSetup(input),
          resolveActor: (request, audience) =>
            audience === "browser"
              ? Promise.resolve(actor)
              : oauth.resolveActor(request, audience),
        },
      });
      const verifier = randomBytes(40).toString("base64url");
      const params = new URLSearchParams({
        client_id: codexId,
        redirect_uri: callback,
        response_type: "code",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        resource: `${baseURL}/mcp`,
        scope: "org:read org:manage",
        state: "codex-bound-state",
      });
      const authorize = () =>
        fetch(`${baseURL}/oauth/authorize?${params}`, {
          headers: { Cookie: "fixture=session" },
          redirect: "manual",
        });
      const authorization = await authorize();
      assert.equal(authorization.status, 302);
      const requestId = new URL(
        authorization.headers.get("location")!,
      ).searchParams.get("requestId")!;
      const consent = await fetch(
        `${baseURL}/api/internal/v1/oauth/requests/${requestId}`,
        { headers: { Cookie: "fixture=session" } },
      );
      assert.equal(consent.status, 200);
      assert.deepEqual((await consent.json()).scopes, [
        "org:read",
        "org:manage",
      ]);
      const approved = await fetch(
        `${baseURL}/api/internal/v1/oauth/requests/${requestId}/decision`,
        {
          method: "POST",
          headers: {
            Cookie: "fixture=session",
            Origin: baseURL,
            "Content-Type": "application/json",
          },
          body: '{"approve":true,"accessLevel":"admin"}',
        },
      );
      assert.equal(approved.status, 200);
      const redirect = new URL((await approved.json()).redirectUri);
      assert.equal(redirect.origin, "http://127.0.0.1:51255");
      assert.equal(redirect.pathname, "/callback");
      assert.equal(redirect.searchParams.get("state"), "codex-bound-state");
      assert.equal(redirect.searchParams.get("iss"), baseURL);
      const exchange = (redirectUri: string, codeVerifier = verifier) =>
        fetch(`${baseURL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: codexId,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
            code: redirect.searchParams.get("code")!,
            resource: `${baseURL}/mcp`,
          }),
        });
      // Port variation is allowed only at authorization; the issued code stays bound to the chosen callback.
      assert.equal((await exchange(registeredRedirect)).status, 400);
      assert.equal((await exchange(callback, "x".repeat(43))).status, 400);
      const issued = await exchange(callback);
      assert.equal(issued.status, 200);
      const tokens = await issued.json();
      const grantedScopes = tokens.scope.split(" ");
      assert.ok(grantedScopes.includes("org:read"));
      assert.ok(grantedScopes.includes("org:manage"));
      assert.ok(grantedScopes.includes("rows:write"));
      assert.ok(!grantedScopes.includes("installation:manage"));
      assert(tokens.refresh_token);
      await sdk.connect(
        new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
          requestInit: {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          },
        }),
      );
      assert(
        (await sdk.listTools()).tools.some(
          (tool) => tool.name === "rootset_update_organisation",
        ),
      );
      const result = await sdk.callTool({
        name: "rootset_update_organisation",
        arguments: {
          orgId,
          name: "Updated through Codex OAuth",
          idempotencyKey: newId(),
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT name FROM rootset_control.organisations WHERE id=$1",
            [orgId],
          )
        ).rows[0].name,
        "Updated through Codex OAuth",
      );
      await fixture.owner.query(
        "UPDATE rootset_control.memberships SET role='member',version=version+1 WHERE user_id=$1 AND org_id=$2",
        [userId, orgId],
      );
      await assert.rejects(
        sdk.callTool({
          name: "rootset_update_organisation",
          arguments: {
            orgId,
            name: "Denied after demotion",
            idempotencyKey: newId(),
          },
        }),
        /UNAUTHENTICATED/,
      );
      await assert.rejects(
        sdk.callTool({
          name: "rootset_get_organisation",
          arguments: { orgId },
        }),
        /UNAUTHENTICATED/,
      );
      const nextAuthorization = await authorize();
      assert.equal(nextAuthorization.status, 302);
      const nextId = new URL(
        nextAuthorization.headers.get("location")!,
      ).searchParams.get("requestId")!;
      const nextConsent = await fetch(
        `${baseURL}/api/internal/v1/oauth/requests/${nextId}`,
        {
          headers: { Cookie: "fixture=session" },
        },
      );
      assert.equal(nextConsent.status, 200);
      assert.deepEqual((await nextConsent.json()).availableAccessLevels, [
        "read",
        "write",
      ]);
      const refreshed = await fetch(`${baseURL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: codexId,
          refresh_token: tokens.refresh_token,
          resource: `${baseURL}/mcp`,
        }),
      });
      assert.equal(refreshed.status, 400);
      assert.equal((await refreshed.json()).error, "invalid_grant");
      assert.equal((await exchange(callback)).status, 400);
      assert.equal(
        await oauth.resolveActor(
          new Request(`${baseURL}/mcp`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          }),
          "mcp",
        ),
        null,
      );
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT name FROM rootset_control.organisations WHERE id=$1",
            [orgId],
          )
        ).rows[0].name,
        "Updated through Codex OAuth",
      );
    } finally {
      await sdk.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await runtime.close();
      await fixture.close();
    }
  },
);
