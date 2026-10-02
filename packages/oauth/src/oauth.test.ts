import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { newId, ActorSchema, type Actor } from "@rootset/contracts";
import { OAuthService, fetchClientMetadata } from "./index.js";

const databaseURL = process.env.ROOTSET_TEST_DATABASE_URL;
const identityURL = process.env.ROOTSET_TEST_IDENTITY_DATABASE_URL;
const baseURL = "http://localhost:4310",
  clientId = "test-rootset-client";
const client = {
  client_id: clientId,
  client_name: "OAuth integration client",
  redirect_uris: ["https://client.example/callback"],
};
async function fixture(
  run: (context: {
    owner: Pool;
    issuer: Pool;
    service: OAuthService;
    actor: Actor;
    grant: (
      resource?: string,
      approve?: boolean,
    ) => Promise<Record<string, unknown>>;
  }) => Promise<void>,
) {
  const owner = new Pool({ connectionString: databaseURL }),
    issuer = new Pool({ connectionString: identityURL ?? databaseURL });
  const userId = newId(),
    orgId = newId(),
    actor: Actor = {
      id: `user:${userId}`,
      kind: "session",
      userId,
      orgId,
      role: "owner",
      scopes: ["*"],
      targets: [],
      unrestricted: true,
    };
  await owner.query(
    "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
    [userId, "OAuth verification", `${userId.toLowerCase()}@oauth.example`],
  );
  await owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [orgId, "OAuth verification"],
  );
  await owner.query(
    "INSERT INTO rootset_control.memberships(id,user_id,org_id,role) VALUES($1,$2,$3,'owner')",
    [newId(), userId, orgId],
  );
  const service = new OAuthService(issuer, {
    baseURL,
    scopes: ["rows:read", "rows:write", "databases:read"],
    clients: [client],
    resolveSession: async (request) =>
      request.headers.get("cookie") === "test=session" ? actor : null,
  });
  const grant = async (resource = `${baseURL}/mcp`, approve = true) => {
    const verifier = randomBytes(40).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(`${baseURL}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: client.redirect_uris[0]!,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      organization_id: orgId,
      scope: "rows:read",
      state: "bound-state",
    }).toString();
    const authorization = (await service.handler(
      new Request(url, { headers: { Cookie: "test=session" } }),
    ))!;
    assert.equal(authorization.status, 302);
    const requestId = new URL(
      authorization.headers.get("location")!,
    ).searchParams.get("requestId")!;
    const consent = (await service.handler(
      new Request(`${baseURL}/api/internal/v1/oauth/requests/${requestId}`, {
        headers: { Cookie: "test=session" },
      }),
    ))!;
    assert.equal(consent.status, 200);
    assert.equal((await consent.json()).client.provenance, "registered");
    const decision = (await service.handler(
      new Request(
        `${baseURL}/api/internal/v1/oauth/requests/${requestId}/decision`,
        {
          method: "POST",
          headers: {
            Origin: baseURL,
            Cookie: "test=session",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ approve }),
        },
      ),
    ))!;
    assert.equal(decision.status, 200);
    const approved = await decision.json(),
      redirect = new URL(approved.redirectUri);
    assert.equal(redirect.searchParams.get("state"), "bound-state");
    assert.equal(redirect.searchParams.get("iss"), baseURL);
    if (!approve) {
      assert.equal(redirect.searchParams.get("error"), "access_denied");
      assert.equal(redirect.searchParams.has("code"), false);
      return { requestId, resource, denied: true };
    }
    const code = redirect.searchParams.get("code")!;
    return { code, verifier, requestId, grantId: approved.grantId, resource };
  };
  try {
    await run({ owner, issuer, service, actor, grant });
  } finally {
    await owner.query(
      "UPDATE rootset_control.oauth_grants SET revoked_at=now() WHERE user_id=$1",
      [userId],
    );
    await owner.query(
      "UPDATE rootset_control.users SET disabled=true WHERE id=$1",
      [userId],
    );
    await issuer.end();
    await owner.end();
  }
}
const form = (body: Record<string, string>) =>
  new Request(`${baseURL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const exchange = (g: Record<string, unknown>) => ({
  grant_type: "authorization_code",
  client_id: clientId,
  redirect_uri: client.redirect_uris[0]!,
  resource: g.resource as string,
  code: g.code as string,
  code_verifier: g.verifier as string,
});

test("OAuth discovery and metadata block unsafe network targets", async () => {
  await assert.rejects(
    fetchClientMetadata("http://client.example/metadata"),
    /HTTPS/,
  );
  await assert.rejects(
    fetchClientMetadata("https://127.0.0.1/metadata"),
    /private|reserved/,
  );
  await assert.rejects(
    fetchClientMetadata("https://10.0.0.1/metadata"),
    /private|reserved/,
  );
});
test(
  "real PostgreSQL consent denial is final and client-bound revocation invalidates the access and refresh family",
  { skip: !databaseURL },
  async () =>
    fixture(async ({ owner, service, grant }) => {
      const denied = await grant(undefined, false);
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM rootset_control.oauth_requests WHERE id=$1",
            [denied.requestId],
          )
        ).rows[0].status,
        "denied",
      );
      const repeated = (await service.handler(
        new Request(
          `${baseURL}/api/internal/v1/oauth/requests/${denied.requestId}/decision`,
          {
            method: "POST",
            headers: {
              Origin: baseURL,
              Cookie: "test=session",
              "Content-Type": "application/json",
            },
            body: '{"approve":true}',
          },
        ),
      ))!;
      assert.equal(repeated.status, 400);
      const approved = await grant(),
        tokens = await (await service.handler(
          form(exchange(approved)),
        ))!.json();
      const access = new Request(`${baseURL}/mcp`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const revoke = async (client_id: string) =>
        (await service.handler(
          new Request(`${baseURL}/oauth/revoke`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id,
              token: tokens.access_token,
            }),
          }),
        ))!;
      assert.equal((await revoke("unrelated-client")).status, 200);
      assert(await service.resolveActor(access, "mcp"));
      assert.equal((await revoke(clientId)).status, 200);
      assert.equal(await service.resolveActor(access, "mcp"), null);
      const refresh = (await service.handler(
        form({
          grant_type: "refresh_token",
          client_id: clientId,
          resource: approved.resource as string,
          refresh_token: tokens.refresh_token,
        }),
      ))!;
      assert.equal(refresh.status, 400);
      assert.equal((await refresh.json()).error, "invalid_grant");
    }),
);
test(
  "real PostgreSQL authorization code binding, refresh rotation, audience isolation and live revocation",
  { skip: !databaseURL },
  async () =>
    fixture(async ({ owner, service, actor, grant }) => {
      for (const malformed of [
        new Request(`${baseURL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencodedevil" },
          body: "grant_type=authorization_code",
        }),
        new Request(`${baseURL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: Uint8Array.from([0xff]),
        }),
        new Request(
          `${baseURL}/api/internal/v1/oauth/requests/${newId()}/decision`,
          {
            method: "POST",
            headers: {
              Origin: baseURL,
              Cookie: "test=session",
              "Content-Type": "application/json",
            },
            body: "null",
          },
        ),
      ]) {
        const denied = (await service.handler(malformed))!;
        assert.equal(denied.status, 400);
        assert.equal((await denied.json()).error, "invalid_request");
      }
      const metadata = (await service.handler(
        new Request(`${baseURL}/.well-known/oauth-authorization-server`),
      ))!;
      assert.deepEqual(
        (await metadata.json()).code_challenge_methods_supported,
        ["S256"],
      );
      const g = await grant();
      const wrong = (await service.handler(
        form({ ...exchange(g), code_verifier: "x".repeat(43) }),
      ))!;
      assert.equal(wrong.status, 400);
      const mismatch = (await service.handler(
        form({ ...exchange(g), resource: `${baseURL}/v1` }),
      ))!;
      assert.equal(mismatch.status, 400);
      const tokens = (await service.handler(form(exchange(g))))!;
      assert.equal(tokens.status, 200);
      const credentials = await tokens.json();
      assert.equal(credentials.expires_in, 900);
      const resolved = await service.resolveActor(
        new Request(`${baseURL}/mcp`, {
          headers: { Authorization: `Bearer ${credentials.access_token}` },
        }),
        "mcp",
      );
      assert.equal(ActorSchema.parse(resolved).orgId, actor.orgId);
      assert.equal(resolved?.unrestricted, true);
      assert.deepEqual(resolved?.targets, []);
      assert.equal(
        await service.resolveActor(
          new Request(`${baseURL}/v1`, {
            headers: { Authorization: `Bearer ${credentials.access_token}` },
          }),
          "api",
        ),
        null,
      );
      const refresh = {
        grant_type: "refresh_token",
        client_id: clientId,
        resource: g.resource as string,
        refresh_token: credentials.refresh_token,
      };
      const rotated = (await service.handler(form(refresh)))!;
      assert.equal(rotated.status, 200);
      const rotatedTokens = await rotated.json();
      assert.notEqual(rotatedTokens.refresh_token, credentials.refresh_token);
      const reused = (await service.handler(form(refresh)))!;
      assert.equal(reused.status, 400);
      assert.equal(
        await service.resolveActor(
          new Request(`${baseURL}/mcp`, {
            headers: { Authorization: `Bearer ${rotatedTokens.access_token}` },
          }),
          "mcp",
        ),
        null,
      );
      const next = await grant(),
        nextTokens = await (await service.handler(
          form(exchange(next)),
        ))!.json();
      await owner.query(
        "UPDATE rootset_control.memberships SET state='disabled' WHERE user_id=$1 AND org_id=$2",
        [actor.userId, actor.orgId],
      );
      assert.equal(
        await service.resolveActor(
          new Request(`${baseURL}/mcp`, {
            headers: { Authorization: `Bearer ${nextTokens.access_token}` },
          }),
          "mcp",
        ),
        null,
      );
      assert.equal(
        (await service.handler(
          form({
            grant_type: "refresh_token",
            client_id: clientId,
            resource: next.resource as string,
            refresh_token: nextTokens.refresh_token,
          }),
        ))!.status,
        400,
      );
    }),
);
test(
  "standard OAuth parameters bind the browser organisation and freeze exact consent targets despite later expansion",
  { skip: !databaseURL },
  async () =>
    fixture(async ({ service, actor }) => {
      actor.unrestricted = false;
      const databaseId = newId();
      actor.targets = [{ databaseId, level: "read" }];
      const verifier = randomBytes(40).toString("base64url"),
        challenge = createHash("sha256").update(verifier).digest("base64url");
      const url = new URL(`${baseURL}/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: client.redirect_uris[0]!,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${baseURL}/mcp`,
      }).toString();
      const authorization = (await service.handler(new Request(url)))!;
      assert.equal(authorization.status, 302);
      const requestId = new URL(
        authorization.headers.get("location")!,
      ).searchParams.get("requestId")!;
      const details = await (await service.handler(
        new Request(`${baseURL}/api/internal/v1/oauth/requests/${requestId}`, {
          headers: { Cookie: "test=session" },
        }),
      ))!.json();
      assert.equal(details.organizationId, actor.orgId);
      assert.deepEqual(details.targets, [{ databaseId, level: "read" }]);
      assert.equal(details.unrestricted, false);
      actor.unrestricted = true;
      actor.targets.push({ databaseId: newId(), level: "manage" });
      const decision = await (await service.handler(
        new Request(
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
        ),
      ))!.json();
      const code = new URL(decision.redirectUri).searchParams.get("code")!;
      const tokens = await (await service.handler(
        form({
          grant_type: "authorization_code",
          client_id: clientId,
          resource: `${baseURL}/mcp`,
          redirect_uri: client.redirect_uris[0]!,
          code,
          code_verifier: verifier,
        }),
      ))!.json();
      const resolved = ActorSchema.parse(
        await service.resolveActor(
          new Request(`${baseURL}/mcp`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          }),
          "mcp",
        ),
      );
      assert.equal(resolved.unrestricted, false);
      assert.deepEqual(resolved.targets, [{ databaseId, level: "read" }]);
      assert(
        !resolved.scopes.some(
          (s) => s.endsWith(":write") || s.endsWith(":manage"),
        ),
      );
    }),
);
test(
  "concurrent authorization exchanges and refresh reuse revoke all issued family access",
  { skip: !databaseURL },
  async () =>
    fixture(async ({ service, grant }) => {
      const g = await grant(),
        responses = await Promise.all([
          service.handler(form(exchange(g))),
          service.handler(form(exchange(g))),
        ]);
      assert.deepEqual(responses.map((r) => r!.status).sort(), [200, 400]);
      const issued = await responses.find((r) => r!.status === 200)!.json();
      assert.equal(
        await service.resolveActor(
          new Request(`${baseURL}/mcp`, {
            headers: { Authorization: `Bearer ${issued.access_token}` },
          }),
          "mcp",
        ),
        null,
      );
      const h = await grant(),
        tokens = await (await service.handler(form(exchange(h))))!.json();
      const refresh = {
        grant_type: "refresh_token",
        client_id: clientId,
        resource: h.resource as string,
        refresh_token: tokens.refresh_token,
      };
      const race = await Promise.all([
        service.handler(form(refresh)),
        service.handler(form(refresh)),
      ]);
      assert.deepEqual(race.map((r) => r!.status).sort(), [200, 400]);
      const newest = await race.find((r) => r!.status === 200)!.json();
      assert.equal(
        await service.resolveActor(
          new Request(`${baseURL}/mcp`, {
            headers: { Authorization: `Bearer ${newest.access_token}` },
          }),
          "mcp",
        ),
        null,
      );
    }),
);
test(
  "access, refresh inactivity and absolute expiry are enforced from persisted state",
  { skip: !databaseURL },
  async () =>
    fixture(async ({ owner, service, grant }) => {
      const g = await grant(),
        tokens = await (await service.handler(form(exchange(g))))!.json();
      await owner.query(
        "UPDATE rootset_control.oauth_tokens SET expires_at=now()-interval '1 second' WHERE digest=$1",
        [createHash("sha256").update(tokens.access_token).digest("hex")],
      );
      assert.equal(
        await service.resolveActor(
          new Request(`${baseURL}/mcp`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          }),
          "mcp",
        ),
        null,
      );
      await owner.query(
        "UPDATE rootset_control.oauth_families SET inactivity_expires_at=now()-interval '1 second' WHERE grant_id=$1",
        [g.grantId],
      );
      assert.equal(
        (await service.handler(
          form({
            grant_type: "refresh_token",
            client_id: clientId,
            resource: g.resource as string,
            refresh_token: tokens.refresh_token,
          }),
        ))!.status,
        400,
      );
      await owner.query(
        "UPDATE rootset_control.oauth_families SET inactivity_expires_at=now()+interval '1 day',absolute_expires_at=now()-interval '1 second' WHERE grant_id=$1",
        [g.grantId],
      );
      assert.equal(
        (await service.handler(
          form({
            grant_type: "refresh_token",
            client_id: clientId,
            resource: g.resource as string,
            refresh_token: tokens.refresh_token,
          }),
        ))!.status,
        400,
      );
    }),
);
