import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import { newId } from "@rootset/contracts";
import { decryptProtected } from "../../../packages/email/src/index.js";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createRuntimeApp } from "./runtime-app.js";
import { httpServerOptions } from "./http-server.js";

test("split public API owns the browser session and accepts only the configured UI origin", async () => {
  const db = await isolatedDatabase();
  const webURL = "http://localhost:4300";
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
  const apiURL = `http://127.0.0.1:${address.port}`;
  const config = {
    ...loadConfig(),
    baseURL: apiURL,
    webURL,
    databaseURL: db.app.options.connectionString!,
  };
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime(config, {
      oauthClients: [
        {
          client_id: "rootset-split-origin-verification",
          client_name: "Split origin verification",
          redirect_uris: ["https://client.example/callback"],
        },
      ],
    });
    app = createRuntimeApp(runtime);
    const email = `split-${newId().toLowerCase()}@example.test`;
    const setup = await fetch(`${apiURL}/v1/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webURL },
      body: JSON.stringify({
        bootstrapSecret: config.bootstrapSecret,
        name: "Split origin owner",
        email,
        password: "Rootset verification password 2026!",
        organisationName: "Split origin",
      }),
    });
    assert.equal(setup.status, 201);
    assert.equal(setup.headers.get("Access-Control-Allow-Origin"), webURL);
    assert.equal(setup.headers.get("Access-Control-Allow-Credentials"), "true");
    const provision = await setup.json();
    assert.equal(provision.state, "ready");
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*) FROM rootset_control.email_outbox WHERE template='account-verification'",
        )
      ).rows[0].count,
      "0",
    );
    await db.owner.query(
      "UPDATE rootset_control.users SET email_verified=false WHERE id=$1",
      [provision.userId],
    );
    await fetch(`${apiURL}/v1/auth/request-verification-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webURL },
      body: JSON.stringify({ email }),
    });
    const row = (
      await db.owner.query<{ payload_encrypted: string }>(
        "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='account-verification' ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    assert(row);
    const verification = decryptProtected<{ actionUrl: string }>(
      row.payload_encrypted,
      config,
    );
    assert.equal(new URL(verification.actionUrl).origin, apiURL);
    const verified = await fetch(verification.actionUrl, {
      redirect: "manual",
    });
    assert([200, 302].includes(verified.status));
    const login = await fetch(`${apiURL}/v1/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webURL },
      body: JSON.stringify({
        email,
        password: "Rootset verification password 2026!",
      }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("Access-Control-Allow-Origin"), webURL);
    const cookies = login.headers.getSetCookie();
    assert(cookies.some((value) => value.startsWith("rootset.session_token=")));
    assert(cookies.every((value) => !/;\s*Domain=/i.test(value)));
    assert(cookies.every((value) => /;\s*HttpOnly/i.test(value)));
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const context = await fetch(`${apiURL}/api/internal/v1/context`, {
      headers: { Cookie: cookie, Origin: webURL },
    });
    assert.equal(context.status, 200);
    assert.equal(context.headers.get("Access-Control-Allow-Origin"), webURL);
    const passkey = await fetch(
      `${apiURL}/v1/auth/passkey/generate-register-options`,
      { headers: { Cookie: cookie, Origin: webURL } },
    );
    assert.equal(passkey.status, 200);
    assert.equal((await passkey.json()).rp.id, "localhost");
    const authorization = new URL(`${apiURL}/oauth/authorize`);
    authorization.search = new URLSearchParams({
      client_id: "rootset-split-origin-verification",
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      code_challenge: createHash("sha256")
        .update("split-origin-verifier-for-consent")
        .digest("base64url"),
      code_challenge_method: "S256",
      resource: `${apiURL}/mcp`,
      scope: "viewer",
      state: "split-origin-state",
    }).toString();
    const consent = await fetch(authorization, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    assert.equal(consent.status, 302);
    const consentURL = new URL(consent.headers.get("Location")!);
    assert.equal(consentURL.origin, webURL);
    assert.equal(consentURL.pathname, "/oauth/consent");
    const foreign = await fetch(`${apiURL}/v1/auth/sign-out`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: apiURL,
      },
      body: JSON.stringify({}),
    });
    assert.equal(foreign.status, 403);
    const metadata = await fetch(
      `${apiURL}/.well-known/oauth-authorization-server`,
    );
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).issuer, apiURL);
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
