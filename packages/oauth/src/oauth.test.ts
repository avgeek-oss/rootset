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
  const existingOrg = (
    await owner.query("SELECT id FROM rootset_control.organisations LIMIT 1")
  ).rows[0];
  const userId = newId(),
    orgId = existingOrg?.id ?? newId(),
    actor: Actor = {
      id: `user:${userId}`,
      kind: "session",
      userId,
      orgId,
      role: "admin",
      scopes: ["*"],
      authenticatedAt: Date.now(),
    };
  await owner.query(
    "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
    [userId, "OAuth verification", `${userId.toLowerCase()}@oauth.example`],
  );
  if (!existingOrg)
    await owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
      [orgId, "OAuth verification"],
    );
  await owner.query(
    "INSERT INTO rootset_control.memberships(id,user_id,org_id,role) VALUES($1,$2,$3,'admin')",
    [newId(), userId, orgId],
  );
  const service = new OAuthService(issuer, {
    baseURL,
    scopes: ["rows:read", "rows:write", "databases:read"],
    clients: [client],
    refreshActor: async (credential) => {
      const row = (
        await owner.query(
          "SELECT m.role,m.version FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.org_id=$2",
          [credential.userId, credential.orgId],
        )
      ).rows[0];
      return row
        ? {
            ...credential,
            role: row.role,
            membershipVersion: Number(row.version),
          }
        : null;
    },
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
      "DELETE FROM rootset_control.memberships WHERE user_id=$1 AND org_id=$2",
      [userId, orgId],
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
      assert.equal(resolved?.role, "admin");
      assert.equal(resolved && "targets" in resolved, false);
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
        "DELETE FROM rootset_control.memberships WHERE user_id=$1 AND org_id=$2",
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
  "standard OAuth parameters bind the installation organisation and freeze operation consent",
  { skip: !databaseURL },
  async () =>
    fixture(async ({ service, actor }) => {
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
      assert.equal("targets" in details, false);
      assert.equal("unrestricted" in details, false);
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
      assert.equal("targets" in resolved, false);
      assert.equal("unrestricted" in resolved, false);
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

test("OAuth bearer authority follows live role demotion and user removal", async () => {
  const orgId = newId(),
    userId = newId(),
    grantId = newId();
  const saved: Actor = {
    kind: "oauth",
    id: `oauth:${grantId}`,
    credentialId: grantId,
    userId,
    orgId,
    role: "admin",
    scopes: ["rows:read", "rows:write"],
  };
  let liveRole: Actor["role"] | null = "editor";
  const pool = {
    query: async (_sql: string, values: unknown[]) => ({
      rows:
        values[1] === `${baseURL}/mcp`
          ? [
              {
                actor: saved,
                grant_id: grantId,
                scopes: saved.scopes,
                resource: `${baseURL}/mcp`,
                user_id: userId,
                org_id: orgId,
              },
            ]
          : [],
    }),
  } as unknown as Pool;
  const service = new OAuthService(pool, {
    baseURL,
    scopes: saved.scopes,
    clients: [client],
    resolveSession: async () => null,
    refreshActor: async (actor) =>
      liveRole ? { ...actor, role: liveRole } : null,
  });
  const request = new Request(`${baseURL}/mcp`, {
    headers: { Authorization: "Bearer rs_oauth_unit_token" },
  });
  assert.deepEqual((await service.resolveActor(request, "mcp"))?.scopes, [
    "rows:read",
    "rows:write",
  ]);
  liveRole = "viewer";
  const demoted = ActorSchema.parse(await service.resolveActor(request, "mcp"));
  assert.equal(demoted.role, "viewer");
  assert.deepEqual(demoted.scopes, ["rows:read"]);
  assert.equal(await service.resolveActor(request, "api"), null);
  liveRole = null;
  assert.equal(await service.resolveActor(request, "mcp"), null);
});

function consentUnitFixture() {
  const orgId = newId(),
    userId = newId(),
    requestId = newId();
  const actor: Actor = {
    kind: "session",
    id: `user:${userId}`,
    userId,
    orgId,
    role: "admin",
    scopes: [],
    authenticatedAt: Date.now(),
  };
  const row = {
    id: requestId,
    client_id: clientId,
    redirect_uri: client.redirect_uris[0],
    resource: `${baseURL}/mcp`,
    scopes: ["rows:read", "rows:write"],
    org_id: orgId,
    user_id: userId,
    state: "state",
    challenge: "x".repeat(43),
    expires_at: new Date(Date.now() + 60_000),
    status: "pending",
    reviewed_at: null as Date | null,
  };
  const writes: string[] = [];
  const query = async (sql: string) => {
    if (sql.startsWith("SELECT * FROM rootset_control.oauth_requests"))
      return { rows: [{ ...row }] };
    if (sql.includes("reviewed_at=now()")) row.reviewed_at = new Date();
    if (sql.startsWith("INSERT INTO rootset_control.oauth_grants"))
      writes.push(sql);
    return { rows: [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
  const service = new OAuthService(pool, {
    baseURL,
    scopes: row.scopes,
    clients: [client],
    resolveSession: async () => actor,
    refreshActor: async (credential) => ({ ...credential, role: actor.role }),
  });
  const inspect = () =>
    service.handler(
      new Request(`${baseURL}/api/internal/v1/oauth/requests/${requestId}`),
    );
  const decide = () =>
    service.handler(
      new Request(
        `${baseURL}/api/internal/v1/oauth/requests/${requestId}/decision`,
        {
          method: "POST",
          headers: { Origin: baseURL, "Content-Type": "application/json" },
          body: '{"approve":true}',
        },
      ),
    );
  return { actor, row, writes, service, inspect, decide };
}

test("OAuth approval requires reviewed real consent and rechecks the current role", async () => {
  const fixture = consentUnitFixture();
  const unreviewed = (await fixture.decide())!;
  assert.equal(unreviewed.status, 400);
  assert.equal(fixture.writes.length, 0);
  const consent = (await fixture.inspect())!;
  assert.equal(consent.status, 200);
  const detail = await consent.json();
  assert.deepEqual(detail.scopes, ["rows:read", "rows:write"]);
  assert.equal("targets" in detail, false);
  assert.equal("unrestricted" in detail, false);
  fixture.actor.role = "viewer";
  assert.equal((await fixture.decide())!.status, 403);
  assert.equal(fixture.writes.length, 0);
  fixture.actor.role = "admin";
  assert.equal((await fixture.decide())!.status, 200);
  assert.equal(fixture.writes.length, 1);
});

test("OAuth rejects resource whitelists and requires S256 PKCE", async () => {
  const fixture = consentUnitFixture();
  const authorize = async (extra: Record<string, string>) => {
    const url = new URL(`${baseURL}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: client.redirect_uris[0]!,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "x".repeat(43),
      resource: `${baseURL}/mcp`,
      scope: "rows:read",
      ...extra,
    }).toString();
    return (await fixture.service.handler(new Request(url)))!;
  };
  const invalidParameters: Record<string, string>[] = [
    { database_ids: newId() },
    { table_ids: newId() },
    { organization_id: newId() },
    { code_challenge_method: "plain" },
    { code_challenge: "short" },
  ];
  for (const extra of invalidParameters)
    assert.equal((await authorize(extra)).status, 400);
});
