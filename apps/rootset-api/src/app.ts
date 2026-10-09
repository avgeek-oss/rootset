import { Hono, type Handler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Pool } from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CancelledNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  operations,
  RootsetError,
  errorEnvelope,
  newId,
  limits,
  parseStrictJson,
  generateOpenApi,
  generateMcpTools,
  generateCoverageInventory,
  getOperation,
  IdSchema,
  QuerySpecSchema,
  type Actor,
  type OperationDefinition,
  type NumberLexeme,
  assertSchemaNumberLexemes,
} from "@rootset/contracts";
import { z } from "zod";
import type { OAuthService } from "@rootset/oauth";
import { Admission } from "./admission.js";
import { readJson, numberLexemes } from "./json.js";
import { normaliseTransportError } from "./transport-errors.js";
import { McpReadRegistry, validMcpRequestId } from "./mcp-read-registry.js";

export interface OperationContext {
  requestId: string;
  idempotencyKey?: string;
  actionId?: string;
  surface: "browser" | "rest" | "mcp";
  responseBudget: number;
  request?: Request;
  signal?: AbortSignal;
  numericLexemes?: NumberLexeme[];
}
export function mcpOperationSignal(
  request: Request,
  signal: AbortSignal,
): AbortSignal {
  return signal === request.signal
    ? signal
    : AbortSignal.any([request.signal, signal]);
}
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export interface AdmissionLimits {
  principalRequestsPerMinute: number;
  organisationRequestsPerMinute: number;
  concurrentReads: number;
  concurrentMutations: number;
}
export interface ApiDependencies {
  pool: Pool;
  admissionPool?: Pool;
  config: { baseURL: string; webURL?: string; version?: string };
  core: {
    execute(
      id: string,
      actor: Actor,
      input: unknown,
      context: OperationContext,
    ): Promise<unknown>;
  };
  identity: {
    auth: { handler(request: Request): Promise<Response> };
    resolveActor(request: Request, audience: string): Promise<Actor | null>;
    setupStatus(): Promise<unknown>;
    claimSetup(input: unknown): Promise<unknown>;
    approveAction(id: string, actor: Actor): Promise<unknown>;
  };
  oauth: OAuthService;
  getAdmissionLimits?: () => Promise<AdmissionLimits> | AdmissionLimits;
  getReadiness?: () => Promise<{
    healthy: boolean;
    dependencies?: Record<string, string>;
  }>;
  observer?: {
    record(event: {
      requestId: string;
      operationId: string;
      status: number;
      durationMs: number;
      errorCode?: string;
    }): void | Promise<void>;
  };
  windowQuery?: (
    actor: Actor,
    input: unknown,
    context: OperationContext,
  ) => Promise<unknown>;
  downloadArtifact?: (
    actor: Actor,
    id: string,
  ) => Promise<{
    stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
    mediaType: string;
    fileName: string;
    byteLength: number;
    checksum: string;
  }>;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Request body must be an object.",
      400,
    );
  return value as Record<string, unknown>;
};
const pathNames = (path: string) =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
const httpPath = (path: string) => path.replace(/\{([^}]+)\}/g, ":$1");
const WindowInputSchema = z.strictObject({
  orgId: IdSchema,
  databaseId: IdSchema,
  query: QuerySpecSchema.optional(),
  position: z
    .union([
      z.enum(["first", "middle", "last"]),
      z
        .number()
        .int()
        .min(0)
        .max(limits.maxRows - 1),
    ])
    .optional(),
  sessionId: IdSchema.optional(),
});
function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
function expectedDelete(
  request: Request,
  rowId: string | undefined,
): string | undefined {
  const header = request.headers.get("if-match");
  if (!header) return undefined;
  const match = header.match(
    /^"([0-7][0-9A-HJKMNP-TV-Z]{25}):([1-9][0-9]{0,18})"$/i,
  );
  if (!match || match[1]!.toUpperCase() !== rowId?.toUpperCase())
    throw new RootsetError(
      "VALIDATION_FAILED",
      "If-Match must identify this row and its revision.",
      400,
    );
  return match[2];
}
function validate(operation: OperationDefinition, value: unknown) {
  const parsed = operation.inputSchema.safeParse(value);
  if (!parsed.success)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Operation input is invalid.",
      422,
      {
        fields: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
    );
  return parsed.data;
}
function validateOutput(
  operation: OperationDefinition,
  value: unknown,
): unknown {
  const parsed = operation.outputSchema.safeParse(value);
  if (!parsed.success)
    throw new RootsetError(
      "INTERNAL_ERROR",
      "Operation result does not match its declared contract.",
      500,
    );
  return parsed.data;
}
function errorResponse(
  error: unknown,
  requestId: string,
  origin: string,
  audience = "v1",
  scopes?: string,
) {
  const status = error instanceof RootsetError ? error.status : 500,
    headers: Record<string, string> = { "X-Request-Id": requestId };
  if (status === 401)
    headers["WWW-Authenticate"] =
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/${audience}", scope="${scopes ?? "rows:read"}"`;
  if (status === 403)
    headers["WWW-Authenticate"] =
      `Bearer error="insufficient_scope", resource_metadata="${origin}/.well-known/oauth-protected-resource/${audience}"${scopes ? `, scope="${scopes}"` : ""}`;
  if (
    status === 429 ||
    (status === 503 &&
      error instanceof RootsetError &&
      error.code === "DEPENDENCY_UNAVAILABLE")
  )
    headers["Retry-After"] = String(
      (error instanceof RootsetError &&
      error.details &&
      typeof error.details === "object" &&
      !Array.isArray(error.details)
        ? error.details.retryAfter
        : null) ?? 1,
    );
  return json(errorEnvelope(error, requestId), status, headers);
}

export function buildOpenAPI(origin: string, internal = false) {
  return generateOpenApi({ baseUrl: origin, internal });
}

export function createApp(deps: ApiDependencies) {
  const app = new Hono<{
      Variables: { requestId: string; operationId: string; errorCode: string };
    }>(),
    origin = new URL(deps.config.baseURL).origin,
    webOrigin = new URL(deps.config.webURL ?? deps.config.baseURL).origin,
    admission = new Admission(deps.admissionPool ?? deps.pool),
    mcpReads = new McpReadRegistry();
  const publicSpec = buildOpenAPI(origin),
    internalSpec = buildOpenAPI(origin, true),
    coverage = generateCoverageInventory(),
    tools = generateMcpTools();
  const observedOperations = new Map(
    operations.flatMap((operation) => [
      [`${operation.httpMethod}:${httpPath(operation.path)}`, operation.id],
      [
        `${operation.httpMethod}:${httpPath(operation.path.replace(/^\/v1/, "/api/internal/v1"))}`,
        operation.id,
      ],
    ]),
  );
  const fixedObservedOperations = new Map([
    ["/health/live", "healthLive"],
    ["/health/ready", "healthReady"],
    ["/v1/setup", "installationSetup"],
    ["/v1/auth/*", "authentication"],
    ["/oauth/authorize", "oauthAuthorize"],
    ["/oauth/token", "oauthToken"],
    ["/oauth/revoke", "oauthRevoke"],
    ["/oauth/register", "oauthRegister"],
    ["/mcp", "mcpControl"],
    ["/v1/openapi.json", "getOpenApi"],
    ["/v1/operation-coverage", "getOperationCoverage"],
    ["/api/internal/v1/context", "getContext"],
    ["/api/internal/v1/tables/:id/windows/query", "queryRows"],
    ["/.well-known/*", "oauthMetadata"],
    ["/api/internal/v1/oauth/requests/*", "oauthConsent"],
    ["/api/internal/v1/account-actions/:id/approve", "approveAccountAction"],
    ["/api/internal/v1/oauth/requests/:id", "oauthConsentPreview"],
    ["/api/internal/v1/oauth/requests/:id/decision", "oauthConsentDecision"],
  ]);
  const enterActor = async (
    actor: Actor,
    readOnly: boolean,
    leaseSeconds = 120,
  ) => {
    const settings = (await deps.getAdmissionLimits?.()) ?? {
      principalRequestsPerMinute: limits.principalRequestsPerMinute,
      organisationRequestsPerMinute: 1200,
      concurrentReads: limits.concurrentReads,
      concurrentMutations: limits.concurrentMutations,
    };
    await (
      await admission.enter(
        `organisation:${actor.orgId}`,
        readOnly,
        true,
        settings.organisationRequestsPerMinute,
      )
    )();
    return admission.enter(
      actor.userId
        ? `user:${actor.userId}`
        : `credential:${actor.credentialId ?? actor.id}`,
      readOnly,
      false,
      settings.principalRequestsPerMinute,
      readOnly ? settings.concurrentReads : settings.concurrentMutations,
      leaseSeconds,
    );
  };
  app.use("*", async (c, next) => {
    const requestId = newId();
    c.set("requestId", requestId);
    const started = performance.now();
    try {
      await next();
    } finally {
      if (deps.observer) {
        const route = c.req.routePath;
        try {
          await deps.observer.record({
            requestId,
            operationId:
              c.get("operationId") ??
              observedOperations.get(`${c.req.method}:${route}`) ??
              fixedObservedOperations.get(c.req.path) ??
              fixedObservedOperations.get(route) ??
              "request",
            status: c.res.status,
            durationMs: Math.max(0, performance.now() - started),
            ...((c.get("errorCode") ??
            (c.res.status >= 400 ? `HTTP_${c.res.status}` : undefined))
              ? { errorCode: c.get("errorCode") ?? `HTTP_${c.res.status}` }
              : {}),
          });
        } catch {
          console.warn(
            JSON.stringify({
              event: "rootset_observer_unavailable",
              requestId,
            }),
          );
        }
      }
    }
  });
  app.use("*", async (c, next) => {
    const requestId = c.get("requestId");
    c.header("X-Request-Id", requestId);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.header("Origin") === webOrigin) {
      c.header("Access-Control-Allow-Origin", webOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header(
        "Access-Control-Allow-Methods",
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      c.header(
        "Access-Control-Allow-Headers",
        "Accept, Authorization, Content-Type, Idempotency-Key, If-Match, X-Rootset-Action-ID, X-Rootset-Organisation-Id",
      );
      c.header("Access-Control-Expose-Headers", "X-Request-ID");
      c.header("Vary", "Origin");
      if (c.req.method === "OPTIONS") return c.body(null, 204);
    }
    if (
      c.req.header("Origin") !== webOrigin &&
      (c.req.path.startsWith("/.well-known/") ||
        ["/oauth/token", "/oauth/revoke", "/oauth/register"].includes(
          c.req.path,
        ))
    ) {
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type");
      if (c.req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
    }
    await next();
    if (c.req.header("Origin") === webOrigin) {
      c.header("Access-Control-Allow-Origin", webOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Expose-Headers", "X-Request-ID");
      c.header("Vary", "Origin");
    }
  });
  app.onError((error, c) => {
    const failure = normaliseTransportError(error);
    c.set(
      "errorCode",
      failure instanceof RootsetError ? failure.code : "INTERNAL_ERROR",
    );
    return errorResponse(
      failure,
      c.get("requestId"),
      origin,
      c.req.path === "/mcp" ? "mcp" : "v1",
    );
  });
  app.notFound((c) =>
    errorResponse(
      new RootsetError("RESOURCE_NOT_FOUND", "Endpoint unavailable.", 404),
      c.get("requestId"),
      origin,
      c.req.path === "/mcp" ? "mcp" : "v1",
    ),
  );
  app.get("/health/live", () => json({ status: "live" }));
  app.get("/health/ready", async () => {
    try {
      const readiness = deps.getReadiness
        ? await deps.getReadiness()
        : { healthy: Boolean((await deps.pool.query("SELECT 1")).rowCount) };
      const dependencies = Object.fromEntries(
        Object.entries(readiness.dependencies ?? {}).filter(
          ([name, state]) =>
            [
              "postgresql",
              "migrations",
              "worker",
              "objectStorage",
              "smtp",
            ].includes(name) &&
            [
              "healthy",
              "unavailable",
              "stale",
              "pending",
              "mismatch",
              "degraded",
            ].includes(state),
        ),
      );
      return json(
        { status: readiness.healthy ? "ready" : "not_ready", dependencies },
        readiness.healthy ? 200 : 503,
      );
    } catch {
      return json({ status: "not_ready" }, 503);
    }
  });
  app.get("/v1/openapi.json", () => json(publicSpec));
  app.get("/api/internal/v1/openapi.json", async (c) => {
    if (!(await deps.identity.resolveActor(c.req.raw, "browser")))
      throw new RootsetError("UNAUTHENTICATED", "Sign in.", 401);
    return json(internalSpec);
  });
  app.get("/v1/operation-coverage", () => json(coverage));
  app.get("/v1/setup", async () => json(await deps.identity.setupStatus()));
  app.post("/v1/setup", async (c) =>
    json(await deps.identity.claimSetup(await readJson(c.req.raw)), 201),
  );
  const handleIdentity: Handler = async (c) => {
    const headers = new Headers(c.req.raw.headers);
    let ip = "in-process";
    try {
      ip = getConnInfo(c).remote.address ?? "unknown";
    } catch {}
    headers.set("x-rootset-client-address", ip);
    headers.delete("content-length");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.raw.body) {
      const body = await readJson(c.req.raw);
      const url = new URL(c.req.url);
      if (url.pathname === "/v1/public/auth/request-verification-email")
        url.pathname = "/v1/auth/request-verification-email";
      return deps.identity.auth.handler(
        new Request(url, {
          method: c.req.method,
          headers,
          body: JSON.stringify(body),
        }),
      );
    }
    return deps.identity.auth.handler(new Request(c.req.raw, { headers }));
  };
  app.post("/v1/public/auth/request-verification-email", handleIdentity);
  app.all("/v1/auth/*", handleIdentity);
  app.get("/api/internal/v1/context", async (c) => {
    const actor = await authenticate(deps, c.req.raw, true),
      release = await enterActor(actor, true);
    try {
      return json(
        validateOutput(
          getOperation("getContext"),
          await deps.core.execute(
            "getContext",
            actor,
            {},
            {
              requestId: c.get("requestId"),
              surface: "browser",
              responseBudget: limits.restResultBytes,
              request: c.req.raw,
            },
          ),
        ),
      );
    } finally {
      await release();
    }
  });
  app.on(
    ["GET", "PUT"],
    "/api/internal/v1/view-preferences/:tableId",
    async (c) => {
      if (c.req.method === "PUT") assertBrowserOrigin(c.req.raw, webOrigin);
      const actor = await authenticate(deps, c.req.raw, true),
        operation = operations.find(
          (op) =>
            op.id ===
            (c.req.method === "GET"
              ? "getViewPreferences"
              : "updateViewPreferences"),
        )!;
      const value =
        c.req.method === "PUT" ? object(await readJson(c.req.raw)) : {};
      const idempotencyKey = c.req.header("Idempotency-Key");
      if (
        operation.idempotencyRequired &&
        (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey))
      )
        throw new RootsetError(
          "VALIDATION_FAILED",
          "A valid Idempotency-Key is required.",
          400,
        );
      const release = await enterActor(actor, operation.readOnly);
      try {
        return json(
          validateOutput(
            operation,
            await deps.core.execute(
              operation.id,
              actor,
              validate(operation, {
                ...value,
                tableId: c.req.param("tableId"),
              }),
              {
                requestId: c.get("requestId"),
                surface: "browser",
                responseBudget: limits.restResultBytes,
                request: c.req.raw,
                ...(idempotencyKey ? { idempotencyKey } : {}),
              },
            ),
          ),
        );
      } finally {
        await release();
      }
    },
  );
  app.all(
    "/.well-known/*",
    async (c) =>
      (await deps.oauth.handler(c.req.raw)) ??
      json(
        {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Endpoint unavailable",
          },
        },
        404,
      ),
  );
  app.all("/oauth/*", async (c) => {
    let ip = "in-process";
    try {
      ip = getConnInfo(c).remote.address ?? "unknown";
    } catch {}
    const release = await admission.enter(`oauth:ip:${ip}`, true, true);
    try {
      return (
        (await deps.oauth.handler(c.req.raw)) ??
        json({ error: "invalid_request" }, 404)
      );
    } finally {
      await release();
    }
  });
  app.all(
    "/api/internal/v1/oauth/requests/*",
    async (c) =>
      (await deps.oauth.handler(c.req.raw)) ??
      json({ error: "invalid_request" }, 404),
  );
  app.post("/api/internal/v1/account-actions/:id/approve", async (c) => {
    assertBrowserOrigin(c.req.raw, webOrigin);
    const actor = await authenticate(deps, c.req.raw, true);
    return json(await deps.identity.approveAction(c.req.param("id"), actor));
  });
  app.post("/api/internal/v1/tables/:id/windows/query", async (c) => {
    assertBrowserOrigin(c.req.raw, webOrigin);
    const actor = await authenticate(deps, c.req.raw, true),
      decoded = await readJson(c.req.raw),
      numericLexemes = numberLexemes(decoded);
    assertSchemaNumberLexemes(WindowInputSchema, numericLexemes);
    const parsed = WindowInputSchema.safeParse(decoded);
    if (!parsed.success)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Grid window input is invalid.",
        422,
      );
    const input = parsed.data;
    if (!deps.windowQuery)
      throw new RootsetError(
        "INTERNAL_ERROR",
        "Grid query service is unavailable.",
        503,
      );
    const context: OperationContext = {
      requestId: c.get("requestId"),
      surface: "browser",
      responseBudget: limits.restResultBytes,
      request: c.req.raw,
      numericLexemes,
    };
    const release = await enterActor(actor, true);
    try {
      const tableId = IdSchema.safeParse(c.req.param("id"));
      if (!tableId.success)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Resource unavailable.",
          404,
        );
      const result = await deps.windowQuery(
        actor,
        { ...input, tableId: tableId.data },
        context,
      );
      if (Buffer.byteLength(JSON.stringify(result)) > limits.restResultBytes)
        throw new RootsetError(
          "PAYLOAD_TOO_LARGE",
          "Grid result exceeds the response budget; narrow the projection.",
          413,
        );
      return json(result);
    } finally {
      await release();
    }
  });
  if (deps.downloadArtifact)
    for (const internal of [false, true])
      app.get(
        `${internal ? "/api/internal/v1" : "/v1"}/orgs/:orgId/artifacts/:id/download`,
        async (c) => {
          c.set("operationId", "downloadArtifactBytes");
          const actor = internal
            ? await authenticate(deps, c.req.raw, true)
            : await authenticateArtifactBearer(deps, c.req.raw);
          const organisation = IdSchema.safeParse(c.req.param("orgId")),
            artifactId = IdSchema.safeParse(c.req.param("id"));
          if (!organisation.success || !artifactId.success)
            throw new RootsetError(
              "RESOURCE_NOT_FOUND",
              "Resource unavailable.",
              404,
            );
          const orgId = organisation.data,
            id = artifactId.data;
          if (actor.orgId !== orgId)
            throw new RootsetError(
              "RESOURCE_NOT_FOUND",
              "Resource unavailable.",
              404,
            );
          const release = await enterActor(actor, true);
          let artifact: Awaited<
            ReturnType<NonNullable<ApiDependencies["downloadArtifact"]>>
          >;
          try {
            artifact = await deps.downloadArtifact!(actor, id);
          } finally {
            await release();
          }
          const stream =
            artifact.stream instanceof ReadableStream
              ? artifact.stream
              : (await import("node:stream")).Readable.toWeb(
                  artifact.stream as import("node:stream").Readable,
                );
          return new Response(stream as ReadableStream<Uint8Array>, {
            headers: {
              "Content-Type": artifact.mediaType,
              "Content-Length": String(artifact.byteLength),
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
              "Cache-Control": "no-store",
              Digest: `sha-256=${Buffer.from(artifact.checksum, "hex").toString("base64")}`,
            },
          });
        },
      );
  for (const operation of operations)
    for (const internal of [false, true]) {
      const path = httpPath(
        internal
          ? operation.path.replace(/^\/v1\b/, "/api/internal/v1")
          : operation.path,
      );
      app.on(operation.httpMethod, path, async (c) => {
        if (internal && !operation.readOnly)
          assertBrowserOrigin(c.req.raw, webOrigin);
        const actor = await authenticate(deps, c.req.raw, internal),
          requestId = c.get("requestId");
        const pathInput: Record<string, unknown> = {};
        for (const name of pathNames(operation.path))
          pathInput[name] = c.req.param(name);
        let body: Record<string, unknown> = {},
          numericLexemes: NumberLexeme[] = [];
        if (operation.httpMethod === "GET") {
          for (const [name, value] of new URL(c.req.url).searchParams) {
            if (name in body)
              throw new RootsetError(
                "VALIDATION_FAILED",
                "Duplicate query parameters are not accepted.",
                400,
              );
            body[name] = ["limit", "expectedSchemaVersion"].includes(name)
              ? Number(value)
              : name === "select"
                ? value.startsWith("[")
                  ? parseStrictJson(value, { maxBytes: 16_384, maxDepth: 4 })
                  : value.split(",")
                : name === "orderBy"
                  ? parseStrictJson(value, { maxBytes: 4096, maxDepth: 8 })
                  : value;
          }
        } else if (c.req.raw.body) {
          const decoded = await readJson(c.req.raw);
          body = object(decoded);
          numericLexemes = numberLexemes(decoded);
        }
        for (const name of Object.keys(pathInput))
          if (name in body && body[name] !== pathInput[name])
            throw new RootsetError(
              "RESOURCE_NOT_FOUND",
              "Resource unavailable.",
              404,
            );
        if (operation.id === "queryRows" && !("query" in body)) {
          body = { query: body };
          numericLexemes = numericLexemes.map((info) => ({
            ...info,
            path: ["query", ...info.path],
            pointer: `/query${info.pointer}`,
          }));
        }
        const input = { ...body, ...pathInput };
        if (operation.id === "deleteRow")
          input.expectedVersion = expectedDelete(
            c.req.raw,
            pathInput.rowId as string,
          );
        const idempotencyKey = c.req.header("Idempotency-Key"),
          actionId = c.req.header("Rootset-Action-Id");
        if (
          operation.idempotencyRequired &&
          (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey))
        )
          throw new RootsetError(
            "VALIDATION_FAILED",
            "A valid Idempotency-Key is required.",
            400,
          );
        const context: OperationContext = {
          requestId,
          surface: internal ? "browser" : "rest",
          responseBudget: limits.restResultBytes,
          request: c.req.raw,
          numericLexemes,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(actionId ? { actionId } : {}),
        };
        const release = await enterActor(actor, operation.readOnly);
        try {
          assertSchemaNumberLexemes(operation.inputSchema, numericLexemes);
          const result = validateOutput(
            operation,
            await deps.core.execute(
              operation.id,
              actor,
              validate(operation, input),
              context,
            ),
          );
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded) > limits.restResultBytes)
            throw new RootsetError(
              "PAYLOAD_TOO_LARGE",
              "Result exceeds the response budget; narrow the query or export it.",
              413,
            );
          const accepted =
            operation.job &&
            result &&
            typeof result === "object" &&
            ("jobId" in result ||
              ("state" in result &&
                (result as { state: string }).state === "queued"));
          return json(
            result,
            accepted
              ? 202
              : operation.successStatus === 202
                ? operation.httpMethod === "POST"
                  ? 201
                  : 200
                : operation.successStatus,
            { "X-Request-Id": requestId },
          );
        } finally {
          await release();
        }
      });
    }
  app.all("/mcp", async (c) => {
    const request = c.req.raw;
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== origin
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "MCP origin is not allowed.",
        403,
      );
    const actor = await deps.identity.resolveActor(request, "mcp");
    if (!actor || !["oauth", "personal_key", "team_key"].includes(actor.kind))
      return errorResponse(
        new RootsetError(
          "UNAUTHENTICATED",
          "An API key or MCP-resource OAuth bearer token is required.",
          401,
        ),
        c.get("requestId"),
        origin,
        "mcp",
        deps.oauth.defaultScopes.join(" "),
      );
    const settings = await deps.getAdmissionLimits?.();
    await (
      await admission.enter(
        `mcp-http:${actor.userId ?? actor.id}`,
        true,
        true,
        settings?.principalRequestsPerMinute ??
          limits.principalRequestsPerMinute,
      )
    )();
    let parsedBody: unknown,
      numericLexemes: NumberLexeme[] = [];
    if (request.method === "POST") {
      try {
        parsedBody = await readJson(request, limits.requestBytes);
        numericLexemes = numberLexemes(parsedBody);
      } catch (error) {
        const status =
          error instanceof RootsetError &&
          [408, 413, 415].includes(error.status)
            ? error.status
            : 400;
        return json(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: status === 400 ? -32700 : -32000,
              message:
                status === 400
                  ? "Invalid JSON request."
                  : "Request body is unavailable or exceeds its budget.",
              data: errorEnvelope(error, c.get("requestId")),
            },
          },
          status,
        );
      }
      if (
        Array.isArray(parsedBody) ||
        (parsedBody &&
          typeof parsedBody === "object" &&
          "id" in parsedBody &&
          ((typeof parsedBody.id === "string" && parsedBody.id.length > 128) ||
            (typeof parsedBody.id === "number" &&
              (!Number.isSafeInteger(parsedBody.id) ||
                numericLexemes.some(
                  (number) =>
                    number.path.length === 1 &&
                    number.path[0] === "id" &&
                    (!number.integer || !number.safeInteger),
                )))))
      )
        return json(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message:
                "Use one request with a bounded string or safe integer identifier.",
            },
          },
          400,
        );
    }
    if (
      parsedBody &&
      typeof parsedBody === "object" &&
      "method" in parsedBody &&
      parsedBody.method === "notifications/cancelled"
    ) {
      const notification = CancelledNotificationSchema.safeParse(parsedBody);
      const id = notification.success
        ? notification.data.params.requestId
        : undefined;
      if (
        !notification.success ||
        "id" in parsedBody ||
        (id !== undefined &&
          (!validMcpRequestId(id) ||
            (typeof id === "number" &&
              numericLexemes.some(
                (number) =>
                  number.path.length === 2 &&
                  number.path[0] === "params" &&
                  number.path[1] === "requestId" &&
                  (!number.integer || !number.safeInteger),
              ))))
      )
        return json(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message:
                "Use a cancellation notification with a bounded string or safe integer identifier.",
            },
          },
          400,
        );
    }
    if (
      parsedBody &&
      typeof parsedBody === "object" &&
      "method" in parsedBody &&
      parsedBody.method === "tools/call" &&
      "params" in parsedBody &&
      parsedBody.params &&
      typeof parsedBody.params === "object" &&
      "name" in parsedBody.params
    ) {
      const toolName = parsedBody.params.name;
      const operation = operations.find((op) => op.toolName === toolName);
      if (operation) c.set("operationId", operation.id);
      if (
        operation &&
        !actor.scopes.includes("*") &&
        operation.scopes.some((scope) => !actor.scopes.includes(scope))
      ) {
        c.set("errorCode", "ACCESS_DENIED");
        return errorResponse(
          new RootsetError(
            "ACCESS_DENIED",
            "The credential lacks the required operation scopes.",
            403,
          ),
          c.get("requestId"),
          origin,
          "mcp",
          [...new Set([...actor.scopes, ...operation.scopes])].sort().join(" "),
        );
      }
    }
    const server = new Server(
      { name: "Rootset", version: deps.config.version ?? "1.0.0" },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setNotificationHandler(
      CancelledNotificationSchema,
      (notification) => {
        if (notification.params.requestId !== undefined)
          mcpReads.cancel(actor, notification.params.requestId);
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools as { name: string; inputSchema: { type: "object" } }[],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
      const requestId = c.get("requestId");
      let read: ReturnType<McpReadRegistry["begin"]> | undefined;
      try {
        const operation = operations.find(
          (op) => op.toolName === message.params.name,
        );
        if (!operation)
          throw new RootsetError(
            "RESOURCE_NOT_FOUND",
            "Tool unavailable.",
            404,
          );
        c.set("operationId", operation.id);
        const args = object(message.params.arguments ?? {}),
          { idempotencyKey, ...input } = args;
        const argumentLexemes = numericLexemes
          .filter(
            (info) => info.path[0] === "params" && info.path[1] === "arguments",
          )
          .map((info) => ({
            ...info,
            path: info.path.slice(2),
            pointer: info.pointer.replace(/^\/params\/arguments/, ""),
          }));
        assertSchemaNumberLexemes(operation.inputSchema, argumentLexemes);
        if (
          operation.idempotencyRequired &&
          (typeof idempotencyKey !== "string" ||
            !/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey))
        )
          throw new RootsetError(
            "VALIDATION_FAILED",
            "A valid idempotencyKey is required.",
            400,
          );
        if (
          operation.id === "queryRows" &&
          input.query &&
          typeof input.query === "object"
        )
          input.query = { limit: limits.mcpDefaultRows, ...input.query };
        mcpReads.assertAvailable(actor, extra.requestId);
        if (operation.id === "listRows" || operation.id === "queryRows")
          read = mcpReads.begin(
            actor,
            extra.requestId,
            mcpOperationSignal(request, extra.signal),
          );
        const release = await enterActor(actor, operation.readOnly);
        let result: unknown;
        try {
          result = validateOutput(
            operation,
            await deps.core.execute(
              operation.id,
              actor,
              validate(operation, input),
              {
                requestId,
                surface: "mcp",
                responseBudget: limits.mcpResultBytes - 1024,
                request,
                signal:
                  read?.signal ?? mcpOperationSignal(request, extra.signal),
                numericLexemes: argumentLexemes,
                ...(typeof idempotencyKey === "string"
                  ? { idempotencyKey }
                  : {}),
              },
            ),
          );
        } finally {
          await release();
        }
        const content = {
          content: [
            {
              type: "text" as const,
              text:
                result && typeof result === "object" && "jobId" in result
                  ? "Operation accepted; inspect the returned job for terminal state."
                  : "Operation completed.",
            },
          ],
          structuredContent: object(result),
        };
        if (Buffer.byteLength(JSON.stringify(content)) > limits.mcpResultBytes)
          throw new RootsetError(
            "PAYLOAD_TOO_LARGE",
            "Result exceeds the MCP budget; narrow your query or start an export.",
            413,
          );
        return content;
      } catch (error) {
        const failure = normaliseTransportError(error);
        c.set(
          "errorCode",
          failure instanceof RootsetError ? failure.code : "INTERNAL_ERROR",
        );
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                failure instanceof RootsetError
                  ? `${failure.code}: ${failure.message}`
                  : "INTERNAL_ERROR: Operation could not be completed.",
            },
          ],
          structuredContent: errorEnvelope(failure, requestId),
        };
      } finally {
        read?.release();
      }
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (message) => {
      const match = message.params.uri.match(
        /^rootset:\/\/artifacts\/([0-7][0-9A-HJKMNP-TV-Z]{25})$/i,
      );
      if (!match)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Resource unavailable.",
          404,
        );
      const release = await enterActor(actor, true);
      let result: unknown;
      try {
        result = validateOutput(
          getOperation("getArtifact"),
          await deps.core.execute(
            "getArtifact",
            actor,
            { orgId: actor.orgId, id: match[1] },
            {
              requestId: c.get("requestId"),
              surface: "mcp",
              responseBudget: limits.mcpResultBytes,
            },
          ),
        );
      } finally {
        await release();
      }
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > limits.mcpResultBytes - 1024)
        throw new RootsetError(
          "PAYLOAD_TOO_LARGE",
          "Artifact metadata exceeds the MCP budget.",
          413,
        );
      return {
        contents: [
          { uri: message.params.uri, mimeType: "application/json", text },
        ],
      };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody });
    } finally {
      await server.close();
    }
  });
  return app;
}
function assertBrowserOrigin(request: Request, webOrigin: string) {
  if (
    request.headers.get("origin") !== webOrigin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new RootsetError(
      "ACCESS_DENIED",
      "Browser origin validation failed.",
      403,
    );
}
async function authenticate(
  deps: ApiDependencies,
  request: Request,
  internal: boolean,
) {
  if (
    !internal &&
    !/^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? "")
  )
    throw new RootsetError(
      "UNAUTHENTICATED",
      "A bearer credential is required.",
      401,
    );
  const actor = await deps.identity.resolveActor(
    request,
    internal ? "browser" : "api",
  );
  if (!actor)
    throw new RootsetError(
      "UNAUTHENTICATED",
      "The credential is unavailable or expired.",
      401,
    );
  return actor;
}

async function authenticateArtifactBearer(
  deps: ApiDependencies,
  request: Request,
) {
  if (!/^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? ""))
    throw new RootsetError(
      "UNAUTHENTICATED",
      "A bearer credential is required.",
      401,
    );
  const apiActor = await deps.identity.resolveActor(request, "api"),
    mcpActor = apiActor
      ? null
      : await deps.identity.resolveActor(request, "mcp"),
    actor = apiActor ?? (mcpActor?.kind === "oauth" ? mcpActor : null);
  if (!actor)
    throw new RootsetError(
      "UNAUTHENTICATED",
      "The credential is unavailable or expired.",
      401,
    );
  return actor;
}
