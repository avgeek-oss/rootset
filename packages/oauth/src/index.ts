import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import type { Pool, PoolClient } from "pg";
import {
  newId,
  ActorSchema,
  decodeJsonBytes,
  parseStrictJson,
  RootsetError,
  limits,
  type Actor,
} from "@rootset/contracts";

import { keyScopes, roleAllows } from "@rootset/access";

const MINUTE = 60_000;
const DAY = 86_400_000;
const id = newId;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => `rs_oauth_${randomBytes(40).toString("base64url")}`;
const dateAfter = (duration: number) => new Date(Date.now() + duration);
const compare = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
type Metadata = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  logo_uri?: string;
};
type Client = {
  metadata: Metadata;
  provenance: "registered" | "metadata" | "dynamic";
};
export interface OAuthConfig {
  baseURL: string;
  webURL?: string;
  scopes: readonly string[];
  resolveSession: (request: Request) => Promise<Actor | null>;
  refreshActor: (actor: Actor) => Promise<Actor | null>;
  clients?: Metadata[];
  allowDynamicRegistration?: boolean;
  metadataCacheMilliseconds?: number;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0]! >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) ||
      (p[0] === 192 && p[1] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113)
    );
  }
  const a = address.toLowerCase(),
    prefix = parseInt(a.split(":")[0]!, 16);
  return (
    isIP(a) === 6 &&
    (prefix & 0xe000) === 0x2000 &&
    !a.startsWith("2001:db8:") &&
    !a.startsWith("2001:0:")
  );
}

export async function fetchClientMetadata(clientId: string): Promise<Metadata> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError(
      "invalid_client",
      "Client identifier must be an HTTPS URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new OAuthError(
      "invalid_client",
      "Client metadata must use HTTPS on the standard port.",
    );
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await Promise.race([
      dns.lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () =>
            reject(
              new OAuthError(
                "invalid_client",
                "Client metadata DNS lookup timed out.",
              ),
            ),
          5000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(
      "invalid_client",
      "Client metadata hostname could not be resolved.",
    );
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new OAuthError(
      "invalid_client",
      "Client metadata cannot use private or reserved networks.",
    );
  const address = addresses[0]!;
  const body = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        rejectUnauthorized: true,
        headers: { Accept: "application/json" },
        // Pin the DNS answer we validated, retaining hostname certificate verification.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(
            res.headers["content-type"] ?? "",
          )
        ) {
          req.destroy(
            new OAuthError(
              "invalid_client",
              "Client metadata must return JSON directly without redirects.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536)
            req.destroy(
              new OAuthError(
                "invalid_client",
                "Client metadata exceeds 64 KiB.",
              ),
            );
          else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            );
          } catch {
            reject(
              new OAuthError(
                "invalid_client",
                "Client metadata must be valid UTF-8.",
              ),
            );
          }
        });
        res.on("error", reject);
      },
    );
    const timeout = setTimeout(
      () =>
        req.destroy(
          new OAuthError("invalid_client", "Client metadata fetch timed out."),
        ),
      5000,
    );
    req.on("close", () => clearTimeout(timeout));
    req.on("error", (error) =>
      reject(
        error instanceof OAuthError
          ? error
          : new OAuthError(
              "invalid_client",
              "Client metadata could not be fetched securely.",
            ),
      ),
    );
    req.end();
  });
  let value: unknown;
  try {
    value = parseStrictJson(body, { maxBytes: 65_536, maxDepth: 8 });
  } catch {
    throw new OAuthError("invalid_client", "Client metadata is invalid JSON.");
  }
  return validateMetadata(value, clientId);
}

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (
      !uri.includes("#") &&
      !u.username &&
      !u.password &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
export function redirectMatches(registered: string, supplied: string): boolean {
  if (!validRedirect(registered) || !validRedirect(supplied)) return false;
  if (registered === supplied) return true;
  const stripLoopbackPort = (value: string) =>
    value.replace(
      /^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d+)?(?=\/|\?|$)/,
      "$1",
    );
  // RFC 8252 allows a native client's literal loopback port to vary.
  return (
    /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(registered) &&
    stripLoopbackPort(registered) === stripLoopbackPort(supplied)
  );
}
async function boundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum))
    throw new OAuthError(
      "invalid_request",
      "Request body exceeds its limit.",
      413,
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new OAuthError("invalid_request", "Request body is required.");
  let length = 0,
    completed = false;
  const chunks: Uint8Array[] = [];
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new OAuthError(
            "invalid_request",
            "Request body exceeded its read deadline.",
            408,
          ),
        ),
      limits.requestTimeoutMs,
    );
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        completed = true;
        break;
      }
      length += value.length;
      if (length > maximum) {
        throw new OAuthError(
          "invalid_request",
          "Request body exceeds its limit.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout!);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
function validateMetadata(value: unknown, expectedId?: string): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OAuthError(
      "invalid_client",
      "Client metadata must be an object.",
    );
  const v = value as Record<string, unknown>;
  if (
    typeof v.client_id !== "string" ||
    v.client_id.length < 1 ||
    v.client_id.length > 2048 ||
    (expectedId && v.client_id !== expectedId) ||
    typeof v.client_name !== "string" ||
    v.client_name.length < 1 ||
    v.client_name.length > 200 ||
    !Array.isArray(v.redirect_uris) ||
    !v.redirect_uris.length ||
    v.redirect_uris.length > 20 ||
    !v.redirect_uris.every(
      (r) => typeof r === "string" && r.length <= 2048 && validRedirect(r),
    )
  )
    throw new OAuthError(
      "invalid_client",
      "Client metadata identifiers, name or redirects are invalid.",
    );
  if (v.token_endpoint_auth_method && v.token_endpoint_auth_method !== "none")
    throw new OAuthError(
      "invalid_client",
      "Only public PKCE clients using token_endpoint_auth_method none are supported.",
    );
  return {
    client_id: v.client_id,
    client_name: v.client_name,
    redirect_uris: v.redirect_uris as string[],
    token_endpoint_auth_method: "none",
  };
}

export function parseConfiguredClients(
  source: string | undefined,
): OAuthConfig["clients"] {
  if (source === undefined) return undefined;
  const value = parseStrictJson(source, { maxBytes: 65_536, maxDepth: 8 });
  if (!Array.isArray(value) || value.length > 100)
    throw new OAuthError(
      "invalid_client",
      "Configured OAuth clients must be an array containing 0 to 100 clients.",
    );
  const clients = value.map((entry) => validateMetadata(entry));
  if (new Set(clients.map((entry) => entry.client_id)).size !== clients.length)
    throw new OAuthError(
      "invalid_client",
      "Configured OAuth client IDs must be unique.",
    );
  return clients;
}

export class OAuthService {
  readonly origin: string;
  constructor(
    private readonly pool: Pool,
    private readonly config: OAuthConfig,
  ) {
    this.origin = new URL(config.baseURL).origin;
  }
  get defaultScopes(): string[] {
    return [
      "databases:read",
      "tables:read",
      "rows:read",
      "history:read",
    ].filter((s) => this.config.scopes.includes(s));
  }
  private resource(audience: string) {
    return `${this.origin}/${audience === "api" || audience === "v1" ? "v1" : "mcp"}`;
  }
  private async client(clientId: string): Promise<Client> {
    const configured = this.config.clients?.find(
      (c) => c.client_id === clientId,
    );
    if (configured)
      return {
        metadata: validateMetadata(configured),
        provenance: "registered",
      };
    const cached = await this.pool.query(
      "SELECT metadata,provenance FROM rootset_control.oauth_clients WHERE client_id=$1 AND (expires_at IS NULL OR expires_at>now())",
      [clientId],
    );
    if (cached.rows[0]) return cached.rows[0] as Client;
    const metadata = await fetchClientMetadata(clientId);
    await this.pool.query(
      "INSERT INTO rootset_control.oauth_clients(client_id,metadata,provenance,expires_at) VALUES($1,$2,'metadata',$3) ON CONFLICT(client_id) DO UPDATE SET metadata=excluded.metadata,provenance='metadata',expires_at=excluded.expires_at",
      [
        clientId,
        metadata,
        dateAfter(
          Math.min(
            this.config.metadataCacheMilliseconds ?? 3_600_000,
            3_600_000,
          ),
        ),
      ],
    );
    return { metadata, provenance: "metadata" };
  }
  private async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  private async session(request: Request) {
    const actor = await this.config.resolveSession(request);
    if (!actor)
      throw new OAuthError(
        "login_required",
        "Sign in to review this authorization request.",
        401,
      );
    return actor;
  }
  private originCheck(request: Request) {
    if (
      request.headers.get("origin") !==
      new URL(this.config.webURL ?? this.origin).origin
    )
      throw new OAuthError("access_denied", "Browser origin is required.", 403);
  }
  private grantActor(actor: Actor, orgId: string, scopes: string[]): Actor {
    if (!actor.userId || actor.kind !== "session" || actor.orgId !== orgId)
      throw new OAuthError(
        "access_denied",
        "Sign in to the installation organisation to approve this request.",
        403,
      );
    if (scopes.some((scope) => !roleAllows(actor.role, scope)))
      throw new OAuthError(
        "invalid_scope",
        "Requested operations exceed your current role.",
        403,
      );
    return { ...actor, kind: "oauth", scopes };
  }
  async resolveActor(
    request: Request,
    audience: string,
  ): Promise<Actor | null> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer rs_oauth_")) return null;
    const value = authorization.slice(7);
    const result = await this.pool.query(
      `SELECT g.actor,g.id AS grant_id,g.scopes,g.resource,g.user_id,g.org_id,g.client_id FROM rootset_control.oauth_tokens t
      JOIN rootset_control.oauth_families f ON f.id=t.family_id JOIN rootset_control.oauth_grants g ON g.id=f.grant_id
      WHERE t.digest=$1 AND t.kind='access' AND t.expires_at>now() AND f.revoked_at IS NULL AND g.revoked_at IS NULL
      AND f.absolute_expires_at>now() AND f.inactivity_expires_at>now() AND g.resource=$2 AND rootset_control.oauth_grant_active(g.id)`,
      [digest(value), this.resource(audience)],
    );
    const row = result.rows[0];
    if (!row) return null;
    const actor: Actor = {
      id: `oauth:${row.grant_id}`,
      kind: "oauth",
      credentialId: row.grant_id,
      userId: row.user_id,
      orgId: row.org_id,
      role: row.actor.role,
      scopes: row.scopes,
      clientId: row.client_id,
    };
    const current = await this.config.refreshActor(actor);
    if (
      !current ||
      current.userId !== row.user_id ||
      current.orgId !== row.org_id ||
      current.role !== actor.role
    )
      return null;
    const parsed = ActorSchema.safeParse({
      ...actor,
      role: current.role,
      membershipVersion: current.membershipVersion,
      scopes: row.scopes.filter((scope: string) =>
        roleAllows(current.role, scope),
      ),
    });
    return parsed.success ? parsed.data : null;
  }
  async handler(request: Request): Promise<Response | null> {
    const url = new URL(request.url),
      path = url.pathname;
    try {
      if (path.startsWith("/.well-known/") && request.method !== "GET")
        return response({ error: "invalid_request" }, 405, { Allow: "GET" });
      if (path.startsWith("/.well-known/oauth-protected-resource/")) {
        const audience = path.split("/").at(-1)!;
        if (!["mcp", "v1"].includes(audience)) return null;
        return response({
          resource: this.resource(audience),
          authorization_servers: [this.origin],
          scopes_supported: this.config.scopes,
          bearer_methods_supported: ["header"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server")
        return response({
          issuer: this.origin,
          authorization_endpoint: `${this.origin}/oauth/authorize`,
          token_endpoint: `${this.origin}/oauth/token`,
          revocation_endpoint: `${this.origin}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: this.config.scopes,
          client_id_metadata_document_supported: true,
          ...(this.config.allowDynamicRegistration
            ? { registration_endpoint: `${this.origin}/oauth/register` }
            : {}),
        });
      if (path === "/oauth/authorize" && request.method === "GET")
        return await this.authorize(request, url);
      if (path === "/oauth/token" && request.method === "POST")
        return await this.exchange(request);
      if (path === "/oauth/revoke" && request.method === "POST")
        return await this.revoke(request);
      if (
        path === "/oauth/register" &&
        request.method === "POST" &&
        this.config.allowDynamicRegistration
      )
        return await this.register(request);
      const consent = path.match(
        /^\/api\/internal\/v1\/oauth\/requests\/([A-Za-z0-9_-]+)(\/decision)?$/,
      );
      if (consent)
        return consent[2]
          ? await this.decide(request, consent[1]!)
          : await this.consent(request, consent[1]!);
      return null;
    } catch (error) {
      if (error instanceof OAuthError)
        return response(
          { error: error.code, error_description: error.message },
          error.status,
        );
      if (error instanceof RootsetError)
        return response(
          { error: "invalid_request", error_description: error.message },
          400,
        );
      return response(
        {
          error: "server_error",
          error_description:
            "Authorization service could not complete the request.",
        },
        500,
      );
    }
  }
  private async authorize(request: Request, url: URL) {
    const p = url.searchParams;
    const allowed = [
      "client_id",
      "redirect_uri",
      "response_type",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "scope",
      "state",
    ];
    if (
      [...p.keys()].some((k) => !allowed.includes(k)) ||
      (p.get("state")?.length ?? 0) > 1024 ||
      (p.get("client_id")?.length ?? 0) > 2048
    )
      throw new OAuthError(
        "invalid_request",
        "Authorization parameters are unsupported or exceed their limits.",
      );
    for (const key of allowed)
      if (p.getAll(key).length > 1)
        throw new OAuthError(
          "invalid_request",
          "Duplicate authorization parameters are not accepted.",
        );
    if (
      p.get("response_type") !== "code" ||
      p.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "")
    )
      throw new OAuthError(
        "invalid_request",
        "Authorization code with S256 PKCE is required.",
      );
    const clientId = p.get("client_id") ?? "",
      client = await this.client(clientId),
      redirect = p.get("redirect_uri") ?? "";
    if (
      !client.metadata.redirect_uris.some((uri) =>
        redirectMatches(uri, redirect),
      )
    )
      throw new OAuthError(
        "invalid_request",
        "Redirect URI does not match client registration.",
      );
    const actor = await this.config.resolveSession(request);
    const resource = p.get("resource") ?? "",
      orgId = actor?.orgId ?? "";
    if (
      ![this.resource("api"), this.resource("mcp")].includes(resource) ||
      (orgId && !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(orgId))
    )
      throw new OAuthError(
        "invalid_target",
        "One Rootset resource and a valid organisation are required.",
      );
    const defaultScopes = this.defaultScopes;
    const scopes = (p.get("scope") ?? defaultScopes.join(" "))
      .split(" ")
      .filter(Boolean);
    if (
      !scopes.length ||
      scopes.length > 50 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((s) => !this.config.scopes.includes(s))
    )
      throw new OAuthError(
        "invalid_scope",
        "Select explicit supported scopes.",
      );
    const requestId = id();
    await this.pool.query(
      "INSERT INTO rootset_control.oauth_requests(id,client_id,redirect_uri,resource,scopes,org_id,user_id,state,challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        requestId,
        clientId,
        redirect,
        resource,
        scopes,
        orgId || null,
        (actor as { userId?: string } | null)?.userId ?? null,
        p.get("state"),
        p.get("code_challenge"),
        dateAfter(10 * MINUTE),
      ],
    );
    return Response.redirect(
      `${this.config.webURL ?? this.origin}/oauth/consent?requestId=${encodeURIComponent(requestId)}`,
      302,
    );
  }
  private async consent(request: Request, requestId: string) {
    if (request.method !== "GET")
      throw new OAuthError("invalid_request", "Use GET to inspect consent.");
    const actor = await this.session(request),
      row = await this.transaction(async (db) => {
        const bound = (
          await db.query(
            "SELECT * FROM rootset_control.oauth_requests WHERE id=$1 AND expires_at>now() AND status='pending' FOR UPDATE",
            [requestId],
          )
        ).rows[0];
        if (!bound || (bound.user_id && bound.user_id !== actor.userId))
          throw new OAuthError(
            "invalid_request",
            "Authorization request is unavailable.",
          );
        const orgId = bound.org_id || actor.orgId;
        this.grantActor(actor, orgId, []);
        await db.query(
          "UPDATE rootset_control.oauth_requests SET org_id=$2,user_id=$3,reviewed_at=now() WHERE id=$1",
          [requestId, orgId, actor.userId],
        );
        return { ...bound, org_id: orgId, user_id: actor.userId };
      });
    this.grantActor(actor, row.org_id, []);
    const client = await this.client(row.client_id);
    return response({
      id: row.id,
      client: {
        id: row.client_id,
        name: client.metadata.client_name,
        provenance: client.provenance,
        trust:
          client.provenance === "registered"
            ? "operator_registered"
            : "unverified_client",
      },
      organizationId: row.org_id,
      availableAccessLevels:
        actor.role === "admin"
          ? ["read", "write", "admin"]
          : actor.role === "member"
            ? ["read", "write"]
            : ["read"],
      resource: row.resource,
      scopes: row.scopes,
      expiresAt: row.expires_at,
    });
  }
  private async decide(request: Request, requestId: string) {
    if (request.method !== "POST")
      throw new OAuthError("invalid_request", "Use POST to decide consent.");
    this.originCheck(request);
    const actor = await this.session(request),
      body = decodeJsonBytes(await boundedBody(request, 4096), {
        maxBytes: 4096,
        maxDepth: 4,
      }) as { approve?: unknown; accessLevel?: unknown };
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.approve !== "boolean" ||
      (body.approve &&
        (typeof body.accessLevel !== "string" ||
          !["read", "write", "admin"].includes(body.accessLevel))) ||
      (!body.approve && body.accessLevel !== undefined) ||
      Object.keys(body).some((k) => k !== "approve" && k !== "accessLevel")
    )
      throw new OAuthError(
        "invalid_request",
        "Choose an access level when approving this connection.",
      );
    if (
      body.approve &&
      (actor.kind !== "session" ||
        !actor.authenticatedAt ||
        Date.now() - actor.authenticatedAt > 300000)
    )
      throw new OAuthError(
        "interaction_required",
        "Authenticate again before approving access.",
        403,
      );
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM rootset_control.oauth_requests WHERE id=$1 FOR UPDATE",
          [requestId],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== "pending" ||
        row.expires_at <= new Date() ||
        (row.user_id && row.user_id !== (actor as { userId?: string }).userId)
      )
        throw new OAuthError(
          "invalid_request",
          "Authorization request is unavailable.",
        );
      if (!row.reviewed_at)
        throw new OAuthError(
          "invalid_request",
          "Review the bound request before deciding consent.",
        );
      const redirect = new URL(row.redirect_uri);
      if (row.state !== null) redirect.searchParams.set("state", row.state);
      redirect.searchParams.set("iss", this.origin);
      await db.query(
        "UPDATE rootset_control.oauth_requests SET status=$2,user_id=$3,org_id=$4 WHERE id=$1",
        [
          requestId,
          body.approve ? "approved" : "denied",
          (actor as { userId?: string }).userId,
          row.org_id,
        ],
      );
      if (!body.approve) {
        redirect.searchParams.set("error", "access_denied");
        return response({ redirectUri: redirect.toString() });
      }
      const membership = (
        await db.query<{ role: Actor["role"] }>(
          "SELECT role FROM rootset_control.memberships WHERE user_id=$1 AND org_id=$2 FOR SHARE",
          [actor.userId, row.org_id],
        )
      ).rows[0];
      if (
        !membership ||
        (body.accessLevel === "admin" && membership.role !== "admin") ||
        (body.accessLevel === "write" && membership.role === "viewer")
      )
        throw new OAuthError(
          "access_denied",
          "Selected access exceeds your current role.",
          403,
        );
      const scopes = keyScopes(
        body.accessLevel === "read" ? "read" : "edit",
        body.accessLevel === "admin",
      ).filter(
        (scope) =>
          scope !== "installation:manage" && this.config.scopes.includes(scope),
      );
      const granted = {
        ...this.grantActor(
          { ...actor, role: membership.role },
          row.org_id,
          scopes,
        ),
        clientId: row.client_id,
      };
      const grantId = id(),
        code = token();
      await db.query(
        "INSERT INTO rootset_control.oauth_grants(id,client_id,user_id,org_id,resource,scopes,actor) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          grantId,
          row.client_id,
          (actor as { userId?: string }).userId,
          row.org_id,
          row.resource,
          scopes,
          granted,
        ],
      );
      await db.query(
        "INSERT INTO rootset_control.oauth_codes(digest,grant_id,request_id,redirect_uri,challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          digest(code),
          grantId,
          row.id,
          row.redirect_uri,
          row.challenge,
          dateAfter(2 * MINUTE),
        ],
      );
      redirect.searchParams.set("code", code);
      return response({ redirectUri: redirect.toString(), grantId });
    });
  }
  private async form(request: Request) {
    if (
      !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      throw new OAuthError("invalid_request", "Use form URL encoded requests.");
    const bytes = await boundedBody(request, 16_384);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new OAuthError(
        "invalid_request",
        "OAuth parameters must use valid UTF-8.",
      );
    }
    const form = new URLSearchParams(text);
    for (const key of form.keys())
      if (form.getAll(key).length > 1)
        throw new OAuthError(
          "invalid_request",
          "Duplicate OAuth parameters are not accepted.",
        );
    return form;
  }
  private async issue(
    db: PoolClient,
    familyId: string,
    grant: { scopes: string[]; resource: string },
  ) {
    const access = token(),
      refresh = token();
    await db.query(
      "INSERT INTO rootset_control.oauth_tokens(digest,family_id,kind,expires_at) VALUES($1,$2,$3,$4),($5,$2,$6,$7)",
      [
        digest(access),
        familyId,
        "access",
        dateAfter(15 * MINUTE),
        digest(refresh),
        "refresh",
        dateAfter(7 * DAY),
      ],
    );
    return response({
      access_token: access,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: refresh,
      scope: grant.scopes.join(" "),
      resource: grant.resource,
    });
  }
  private async currentGrant(db: PoolClient, grantId: string) {
    const grant = (
      await db.query(
        "SELECT * FROM rootset_control.oauth_grants WHERE id=$1 AND revoked_at IS NULL",
        [grantId],
      )
    ).rows[0];
    if (!grant) return null;
    const active = (
      await db.query(
        "SELECT rootset_control.oauth_grant_active($1) AS active",
        [grant.id],
      )
    ).rows[0]?.active;
    if (!active) return null;
    const current = await this.config.refreshActor({
      ...grant.actor,
      kind: "oauth",
      credentialId: grant.id,
      userId: grant.user_id,
      orgId: grant.org_id,
      scopes: grant.scopes,
    } as Actor);
    if (
      !current ||
      current.userId !== grant.user_id ||
      current.orgId !== grant.org_id ||
      current.role !== grant.actor.role
    )
      return null;
    const effectiveScopes = grant.scopes.filter((scope: string) =>
      roleAllows(current.role, scope),
    );
    if (!effectiveScopes.length) return null;
    return { ...grant, scopes: effectiveScopes, actor: current };
  }
  private async exchange(request: Request) {
    const f = await this.form(request),
      clientId = f.get("client_id") ?? "",
      resource = f.get("resource") ?? "";
    if (
      !clientId ||
      ![this.resource("api"), this.resource("mcp")].includes(resource)
    )
      throw new OAuthError(
        "invalid_request",
        "Client and explicit resource are required.",
      );
    return this.transaction(async (db) => {
      if (f.get("grant_type") === "authorization_code") {
        const row = (
          await db.query(
            "SELECT * FROM rootset_control.oauth_codes WHERE digest=$1 FOR UPDATE",
            [digest(f.get("code") ?? "")],
          )
        ).rows[0];
        if (!row || row.expires_at <= new Date())
          return response({ error: "invalid_grant" }, 400);
        const grant = await this.currentGrant(db, row.grant_id);
        if (
          !grant ||
          grant.client_id !== clientId ||
          grant.resource !== resource ||
          row.redirect_uri !== f.get("redirect_uri")
        )
          return response({ error: "invalid_grant" }, 400);
        const verifier = f.get("code_verifier") ?? "";
        if (
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !compare(
            createHash("sha256").update(verifier).digest("base64url"),
            row.challenge,
          )
        )
          return response({ error: "invalid_grant" }, 400);
        // A replayed code revokes its grant, but only once the request has
        // proved it holds the code verifier; a request without it is refused
        // above and leaves the grant alone.
        if (row.consumed_at) {
          await db.query(
            "UPDATE rootset_control.oauth_grants SET revoked_at=now() WHERE id=$1",
            [row.grant_id],
          );
          return response({ error: "invalid_grant" }, 400);
        }
        await db.query(
          "UPDATE rootset_control.oauth_codes SET consumed_at=now() WHERE digest=$1",
          [row.digest],
        );
        const familyId = id();
        await db.query(
          "INSERT INTO rootset_control.oauth_families(id,grant_id,absolute_expires_at,inactivity_expires_at) VALUES($1,$2,$3,$4)",
          [familyId, grant.id, dateAfter(30 * DAY), dateAfter(7 * DAY)],
        );
        return this.issue(db, familyId, grant);
      }
      if (f.get("grant_type") === "refresh_token") {
        const tokenRow = (
          await db.query(
            "SELECT * FROM rootset_control.oauth_tokens WHERE digest=$1 AND kind='refresh' FOR UPDATE",
            [digest(f.get("refresh_token") ?? "")],
          )
        ).rows[0];
        if (!tokenRow) return response({ error: "invalid_grant" }, 400);
        const family = (
            await db.query(
              "SELECT * FROM rootset_control.oauth_families WHERE id=$1 FOR UPDATE",
              [tokenRow.family_id],
            )
          ).rows[0],
          grant = await this.currentGrant(db, family.grant_id);
        if (
          !grant ||
          grant.client_id !== clientId ||
          grant.resource !== resource
        )
          return response({ error: "invalid_grant" }, 400);
        if (tokenRow.consumed_at) {
          await db.query(
            "UPDATE rootset_control.oauth_families SET revoked_at=now() WHERE id=$1",
            [family.id],
          );
          return response({ error: "invalid_grant" }, 400);
        }
        if (
          family.revoked_at ||
          family.absolute_expires_at <= new Date() ||
          family.inactivity_expires_at <= new Date() ||
          tokenRow.expires_at <= new Date()
        )
          return response({ error: "invalid_grant" }, 400);
        await db.query(
          "UPDATE rootset_control.oauth_tokens SET consumed_at=now() WHERE digest=$1",
          [tokenRow.digest],
        );
        await db.query(
          "UPDATE rootset_control.oauth_families SET inactivity_expires_at=LEAST(absolute_expires_at,$2) WHERE id=$1",
          [family.id, dateAfter(7 * DAY)],
        );
        return this.issue(db, family.id, grant);
      }
      return response({ error: "unsupported_grant_type" }, 400);
    });
  }
  private async revoke(request: Request) {
    const f = await this.form(request);
    await this.pool.query(
      `UPDATE rootset_control.oauth_families SET revoked_at=now() WHERE id IN
      (SELECT t.family_id FROM rootset_control.oauth_tokens t JOIN rootset_control.oauth_families x ON x.id=t.family_id JOIN rootset_control.oauth_grants g ON g.id=x.grant_id WHERE t.digest=$1 AND g.client_id=$2)`,
      [digest(f.get("token") ?? ""), f.get("client_id") ?? ""],
    );
    return response({});
  }
  private async register(request: Request) {
    const body = decodeJsonBytes(await boundedBody(request, 16_384), {
        maxBytes: 16_384,
        maxDepth: 4,
      }) as Record<string, unknown>,
      clientId = `${this.origin}/oauth/clients/${id()}`;
    const metadata = validateMetadata({ ...body, client_id: clientId });
    await this.pool.query(
      "INSERT INTO rootset_control.oauth_clients(client_id,metadata,provenance) VALUES($1,$2,'dynamic')",
      [clientId, metadata],
    );
    return response(
      { ...metadata, client_id_issued_at: Math.floor(Date.now() / 1000) },
      201,
    );
  }
}
