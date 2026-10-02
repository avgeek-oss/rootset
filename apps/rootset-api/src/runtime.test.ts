import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import {
  getOperation,
  newId,
  operations,
  scopeNames,
  generateClientSource,
  limits,
  rowBytes,
  type JsonValue,
} from "@rootset/contracts";
import { decryptProtected } from "../../../packages/email/src/index.js";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createRuntimeApp } from "./runtime-app.js";
import { httpServerOptions } from "./http-server.js";
import { MCP_PROTOCOL_VERSION } from "./app.js";

test("actual runtime: bootstrap, Better Auth, personal keys, REST/browser/MCP parity, history, concurrency and immediate revocation", async (t) => {
  const db = await isolatedDatabase();
  let app: ReturnType<typeof createRuntimeApp> | undefined,
    runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
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
      name: "Rootset actual runtime verification",
      version: "1.0.0",
    }),
    journalClient = new Client({
      name: "Rootset actual replay verification",
      version: "1.0.0",
    }),
    readOnlyClient = new Client({
      name: "Rootset read-only operation verification",
      version: "1.0.0",
    }),
    scopeClient = new Client({
      name: "Rootset current target permission verification",
      version: "1.0.0",
    }),
    oauthClientId = "rootset-runtime-verification",
    redirectUri = "https://client.example/rootset-callback";
  let cookie = "",
    restSecret = "";
  const positiveOperations = new Set<string>();
  const dependencyEvents: string[] = [];
  try {
    const config = {
      ...loadConfig(),
      baseURL,
      port: address.port,
      databaseURL: db.app.options.connectionString!,
      ddlDatabaseURL: db.ddl.options.connectionString!,
      identityDatabaseURL: db.identity.options.connectionString!,
    };
    runtime = await createRuntime(config, {
      oauthClients: [
        {
          client_id: oauthClientId,
          client_name: "Actual runtime verification",
          redirect_uris: [redirectUri],
        },
      ],
    });
    const record = runtime.observer.record.bind(runtime.observer);
    runtime.observer.record = (event) => {
      if (event.errorCode === "DEPENDENCY_UNAVAILABLE")
        dependencyEvents.push(event.operationId);
      if (
        event.status >= 200 &&
        event.status < 300 &&
        !event.errorCode &&
        operations.some((operation) => operation.id === event.operationId)
      )
        positiveOperations.add(event.operationId);
      record(event);
    };
    const execute = runtime.core.execute.bind(runtime.core);
    runtime.core.execute = async (...args) => {
      try {
        return await execute(...args);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          /^[0-9A-Z]{5}$/.test(String(error.code))
        )
          t.diagnostic(
            `Database failure in ${args[0]}: SQLSTATE ${String(error.code)}.`,
          );
        throw error;
      }
    };
    app = createRuntimeApp(runtime);
    const request = async (
      path: string,
      method = "GET",
      body?: unknown,
      options: {
        token?: string;
        browser?: boolean;
        key?: string;
        headers?: Record<string, string>;
      } = {},
    ) => {
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.browser ? { Cookie: cookie, Origin: baseURL } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
        ...options.headers,
      };
      return fetch(`${baseURL}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
      });
    };
    const setup = await request("/v1/setup", "POST", {
      bootstrapSecret: config.bootstrapSecret,
      name: "Rootset verification owner",
      email: `runtime-${newId().toLowerCase()}@rootset.example`,
      password: "Rootset verification password 2026!",
      organisationName: "Runtime verification",
    });
    assert.equal(setup.status, 201);
    const provision = (await setup.json()) as {
      orgId: string;
      userId: string;
      state: string;
    };
    assert.equal(provision.state, "awaiting_verification");
    const email = (
      await db.owner.query(
        "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template=$1 ORDER BY created_at DESC LIMIT 1",
        ["account-verification"],
      )
    ).rows[0];
    assert(email);
    const message = decryptProtected<{ actionUrl: string }>(
        email.payload_encrypted,
        config,
      ),
      verification = await fetch(message.actionUrl, { redirect: "manual" });
    assert([200, 302].includes(verification.status));
    const user = (
      await db.owner.query(
        "SELECT email,email_verified FROM rootset_control.users WHERE id=$1",
        [provision.userId],
      )
    ).rows[0];
    assert.equal(user.email_verified, true);
    const login = await request(
      "/v1/auth/sign-in/email",
      "POST",
      { email: user.email, password: "Rootset verification password 2026!" },
      { headers: { Origin: baseURL } },
    );
    assert.equal(login.status, 200);
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert(cookie.includes("rootset.session_token="));
    const caller = await request("/api/internal/v1/context", "GET", undefined, {
      browser: true,
    });
    assert.equal(caller.status, 200);
    const context = await caller.json();
    assert.equal(context.principal.userId, provision.userId);
    assert.equal(context.principal.operator, false);
    const call = async (
      operationId: string,
      input: Record<string, unknown>,
      mode: "browser" | "rest" = "browser",
      expectedStatus?: number,
      key = newId(),
      token = restSecret,
    ) => {
      const op = getOperation(operationId),
        body = { ...input };
      let path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
        const value = body[name];
        assert.equal(typeof value, "string");
        delete body[name];
        return encodeURIComponent(String(value));
      });
      if (mode === "browser") path = path.replace(/^\/v1/, "/api/internal/v1");
      const headers: Record<string, string> = {};
      if (operationId === "deleteRow")
        headers["If-Match"] = `"${input.rowId}:${input.expectedVersion}"`;
      if (op.httpMethod === "GET") {
        const params = new URLSearchParams();
        for (const [name, value] of Object.entries(body))
          if (value !== undefined)
            params.set(
              name,
              typeof value === "object" ? JSON.stringify(value) : String(value),
            );
        if (params.size) path += `?${params}`;
      }
      const result = await request(
        path,
        op.httpMethod,
        op.httpMethod === "GET" ? undefined : body,
        {
          browser: mode === "browser",
          token: mode === "rest" ? token : undefined,
          key: op.idempotencyRequired ? key : undefined,
          headers,
        },
      );
      if (expectedStatus !== undefined) {
        assert.equal(result.status, expectedStatus, `${operationId} status`);
        return result.json();
      }
      const value = await result.json();
      assert(
        result.ok,
        `${operationId}: ${JSON.stringify(value.error ?? { status: result.status })}`,
      );
      const parsed = op.outputSchema.safeParse(value);
      assert(
        parsed.success,
        `${operationId} response schema: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`,
      );
      return value;
    };
    await runtime.identity.bindOperator(provision.userId, {
      reason:
        "Isolated transport replay matrix requires higher admission ceilings",
    });
    const admissionConfiguration = await call(
      "updateInstallationConfiguration",
      {
        limits: {
          principalRequestsPerMinute: 1000,
          organisationRequestsPerMinute: 10000,
        },
      },
    );
    assert.equal(
      admissionConfiguration.limits.principalRequestsPerMinute,
      1000,
    );
    const keyRequest = {
      orgId: provision.orgId,
      name: "Runtime read and write",
      scopes: scopeNames.filter((scope) => !scope.startsWith("installation:")),
      targets: [],
      unrestricted: true,
    };
    const key = await call("createPersonalKey", keyRequest, "browser");
    assert.equal(typeof key.secret, "string");
    restSecret = key.secret;
    const readKey = await call("createPersonalKey", {
      orgId: provision.orgId,
      name: "Read only",
      scopes: ["databases:read", "tables:read", "rows:read", "history:read"],
      targets: [],
      unrestricted: true,
    });
    const d = await call("createDatabase", {
        orgId: provision.orgId,
        name: "Airline MDM",
      }),
      orgId = provision.orgId,
      databaseId = d.id;
    const schema = await call("createTable", {
      orgId,
      databaseId,
      name: "Airlines",
      fields: [
        { type: "text", apiKey: "NAME", label: "Name", charLimit: 120 },
        {
          type: "integer",
          apiKey: "COUNT",
          label: "Count",
          min: 0,
          max: 9007199254740991,
        },
        { type: "float", apiKey: "SCORE", label: "Score" },
        { type: "boolean", apiKey: "ACTIVE", label: "Active" },
        { type: "date", apiKey: "DATE", label: "Date" },
        { type: "time", apiKey: "TIME", label: "Time" },
        { type: "date-time", apiKey: "UPDATED", label: "Updated" },
        { type: "json", apiKey: "CONFIG", label: "Config" },
      ],
    });
    const tableId = schema.table.id,
      ids = { orgId, databaseId, tableId };
    const created = await call(
      "createRow",
      {
        ...ids,
        expectedSchemaVersion: 1,
        values: {
          NAME: "Example Air",
          COUNT: 2,
          SCORE: 1e20,
          ACTIVE: true,
          DATE: "2026-10-02",
          TIME: "12:34:56Z",
          UPDATED: "2026-10-02T12:34:56Z",
          CONFIG: { codes: ["EA"], active: true },
        },
      },
      "rest",
    );
    assert.equal(created.row.values.SCORE, 1e20);
    assert.equal(created.row.values.UPDATED, "2026-10-02T12:34:56.000Z");
    const rowId = created.row.id;
    await t.test(
      "API-08 default ten active HTTP reads retain independent admission capacity; exhausted reservations return redacted retryable503",
      async () => {
        assert.equal(runtime!.pool.options.max, 10);
        assert.equal(runtime!.admissionPool.options.max, 2);
        assert.notEqual(runtime!.pool, runtime!.admissionPool);
        const nativeBefore = (
          await db.owner.query(
            "SELECT row_count FROM rootset_control.tables WHERE id=$1",
            [tableId],
          )
        ).rows[0].row_count;
        const principal = `user:${provision.userId}`;
        const queryPath = `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`;
        const peerKey = await call("createTeamKey", {
          orgId,
          name: "Independent saturated workload credential",
          scopes: ["rows:read"],
          targets: [],
          unrestricted: true,
        });
        const peerPrincipal = `credential:${peerKey.key.id}`;
        const blocker = await db.owner.connect();
        const pending: Promise<Response>[] = [];
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "LOCK TABLE rootset_control.tables IN ACCESS EXCLUSIVE MODE",
          );
          for (let index = 0; index < 10; index++)
            pending.push(
              request(
                queryPath,
                "POST",
                { query: { limit: 1 } },
                { token: restSecret },
              ),
            );
          let active = 0;
          for (let attempt = 0; attempt < 100; attempt++) {
            active = Number(
              (
                await db.owner.query(
                  "SELECT count(*)::int count FROM rootset_control.api_admissions WHERE principal=$1 AND read_only AND expires_at>clock_timestamp()",
                  [principal],
                )
              ).rows[0].count,
            );
            if (active === 10) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(active, 10);
          assert.equal(runtime!.pool.totalCount, 10);
          assert.equal(runtime!.pool.idleCount, 0);
          const excess = await request(
            queryPath,
            "POST",
            { query: { limit: 1 } },
            { token: restSecret },
          );
          assert.equal(excess.status, 429);
          assert.equal((await excess.json()).error.code, "RATE_LIMITED");
          assert.ok(Number(excess.headers.get("retry-after")) > 0);
          assert.equal((await request("/health/live")).status, 200);
          const [peerRest, mixedMutation] = await Promise.all([
            request(
              queryPath,
              "POST",
              { query: { limit: 1 } },
              { token: peerKey.secret },
            ),
            request(
              `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows`,
              "POST",
              {
                expectedSchemaVersion: 1,
                values: { NAME: "Within-quota overload mutation" },
              },
              { token: restSecret, key: newId() },
            ),
          ]);
          assert.equal(peerRest.status, 503);
          assert.equal(peerRest.headers.get("retry-after"), "1");
          const peerEnvelope = await peerRest.json();
          assert.equal(peerEnvelope.error.code, "DEPENDENCY_UNAVAILABLE");
          assert.equal(peerEnvelope.error.details.retryAfter, 1);
          assert.equal(mixedMutation.status, 503);
          assert.equal(mixedMutation.headers.get("retry-after"), "1");
          const mutationFailure = await mixedMutation.json();
          assert.equal(mutationFailure.error.code, "DEPENDENCY_UNAVAILABLE");
          assert.ok(
            !/timeout exceeded|SELECT|rootset_control|password|stack/i.test(
              JSON.stringify([peerEnvelope, mutationFailure]),
            ),
          );
          assert.equal(
            Number(
              (
                await db.owner.query(
                  "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=$1",
                  [peerPrincipal],
                )
              ).rows[0].count,
            ),
            0,
          );
          assert.ok(
            dependencyEvents.filter((operation) =>
              ["queryRows", "createRow"].includes(operation),
            ).length >= 2,
          );
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          for (const response of await Promise.all(pending))
            assert.equal(response.status, 200);
        }
        assert.equal(
          (
            await db.owner.query(
              "SELECT row_count FROM rootset_control.tables WHERE id=$1",
              [tableId],
            )
          ).rows[0].row_count,
          nativeBefore,
        );
        assert.equal(
          (
            await request(
              queryPath,
              "POST",
              { query: { limit: 1 } },
              { token: peerKey.secret },
            )
          ).status,
          200,
        );
        assert.equal(
          Number(
            (
              await db.owner.query(
                "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=$1",
                [principal],
              )
            ).rows[0].count,
          ),
          0,
        );
        const held = await Promise.all([
          runtime!.admissionPool.connect(),
          runtime!.admissionPool.connect(),
        ]);
        try {
          const response = await request(
            queryPath,
            "POST",
            { query: { limit: 1 } },
            { token: restSecret },
          );
          assert.equal(response.status, 503);
          const envelope = await response.json();
          assert.equal(envelope.error.code, "DEPENDENCY_UNAVAILABLE");
          assert.equal(response.headers.get("retry-after"), "1");
          assert.ok(!JSON.stringify(envelope).includes(restSecret));
          assert.ok(
            !/timeout exceeded|connectionString|rootset_control|SELECT|password|stack/i.test(
              JSON.stringify(envelope),
            ),
          );
        } finally {
          for (const connection of held) connection.release();
        }
        assert.equal(
          (
            await request(
              queryPath,
              "POST",
              { query: { limit: 1 } },
              { token: restSecret },
            )
          ).status,
          200,
        );
        assert.equal(
          Number(
            (
              await db.owner.query(
                "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=$1",
                [principal],
              )
            ).rows[0].count,
          ),
          0,
        );
      },
    );
    const generatedSource =
      stripTypeScriptTypes(generateClientSource(), { mode: "transform" }) +
      "\n//# sourceURL=rootset-generated-client-test.js";
    const generated = (await import(
      `data:text/javascript;base64,${Buffer.from(generatedSource).toString("base64")}`
    )) as {
      RootsetClient: new (
        baseURL: string,
        options: { bearer: string },
      ) => {
        getRow(input: object): Promise<unknown>;
        queryRows(input: object): Promise<unknown>;
        createRow(
          input: object,
          options: { idempotencyKey: string },
        ): Promise<{ row: { id: string; version: string } }>;
        updateRow(
          input: object,
          options: { idempotencyKey: string },
        ): Promise<{ row: { id: string; version: string } }>;
        deleteRow(
          input: object,
          options: { idempotencyKey: string },
        ): Promise<unknown>;
      };
    };
    const publicClient = new generated.RootsetClient(baseURL, {
      bearer: restSecret,
    });
    assert.deepEqual(await publicClient.getRow({ ...ids, rowId }), created.row);
    getOperation("queryRows").outputSchema.parse(
      await publicClient.queryRows({
        ...ids,
        query: { select: ["NAME"], limit: 1 },
      }),
    );
    const disposable = await publicClient.createRow(
      {
        ...ids,
        expectedSchemaVersion: 1,
        values: { NAME: "Generated client row" },
      },
      { idempotencyKey: "runtime-generated-client-create" },
    );
    getOperation("createRow").outputSchema.parse(disposable);
    const disposablePatch = await publicClient.updateRow(
      {
        ...ids,
        rowId: disposable.row.id,
        expectedSchemaVersion: 1,
        expectedVersion: disposable.row.version,
        values: { NAME: "Generated client updated" },
      },
      { idempotencyKey: "runtime-generated-client-patch" },
    );
    getOperation("updateRow").outputSchema.parse(disposablePatch);
    for (const [ifMatch, status] of [
      [undefined, 422],
      [`"${newId()}:2"`, 400],
      [`"${disposable.row.id}:1"`, 409],
    ] as const) {
      const rejected = await request(
        `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows/${disposable.row.id}`,
        "DELETE",
        { expectedSchemaVersion: 1, expectedVersion: "2" },
        {
          token: restSecret,
          key: newId(),
          headers: ifMatch ? { "If-Match": ifMatch } : {},
        },
      );
      assert.equal(rejected.status, status);
    }
    const disposableDelete = await publicClient.deleteRow(
      {
        ...ids,
        rowId: disposable.row.id,
        expectedSchemaVersion: 1,
        expectedVersion: disposablePatch.row.version,
      },
      { idempotencyKey: "runtime-generated-client-delete" },
    );
    getOperation("deleteRow").outputSchema.parse(disposableDelete);
    await assert.rejects(
      publicClient.getRow({ ...ids, rowId: disposable.row.id }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { status?: number }).status === 404,
    );
    for (const values of [
      '{"COUNT":9007199254740990.5}',
      '{"COUNT":9007199254740993}',
      '{"CONFIG":{"nested":100000000000000000000}}',
    ]) {
      const lexical = await fetch(
        `${baseURL}/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${restSecret}`,
            "Content-Type": "application/json",
            "Idempotency-Key": newId(),
          },
          body: `{"expectedSchemaVersion":1,"values":${values}}`,
        },
      );
      assert.equal(lexical.status, 422);
      assert.equal((await lexical.json()).error.code, "VALIDATION_FAILED");
    }
    const unsafeFilter =
      '{"where":{"field":"COUNT","op":"eq","value":9007199254740990.5}}';
    for (const [path, body, browser] of [
      [
        `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
        `{"query":${unsafeFilter}}`,
        false,
      ],
      [
        `/api/internal/v1/tables/${tableId}/windows/query`,
        `{"orgId":"${orgId}","databaseId":"${databaseId}","query":${unsafeFilter}}`,
        true,
      ],
    ] as const) {
      const response = await fetch(`${baseURL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(browser
            ? { Cookie: cookie, Origin: baseURL }
            : { Authorization: `Bearer ${restSecret}` }),
        },
        body,
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
    }
    const queried = await request(
      `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
      "POST",
      { query: {} },
      { token: readKey.secret },
    );
    assert.equal(queried.status, 200);
    assert.equal((await queried.json()).data[0].id, rowId);
    const deniedWrite = await request(
      `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows`,
      "POST",
      { expectedSchemaVersion: 1, values: { NAME: "Denied" } },
      { token: readKey.secret, key: newId() },
    );
    assert.equal(deniedWrite.status, 403);
    const mismatch = await call(
      "getRow",
      { ...ids, databaseId: newId(), rowId },
      "rest",
      404,
    );
    assert.equal(mismatch.error.code, "RESOURCE_NOT_FOUND");
    const unknown = await call(
      "createRow",
      { ...ids, expectedSchemaVersion: 1, values: { UNKNOWN: 1 } },
      "rest",
      422,
    );
    assert.equal(unknown.error.code, "VALIDATION_FAILED");
    const invalidUTC = await call(
      "createRow",
      {
        ...ids,
        expectedSchemaVersion: 1,
        values: { UPDATED: "2026-10-02T12:34:56+05:30" },
      },
      "rest",
      422,
    );
    assert.equal(invalidUTC.error.code, "VALIDATION_FAILED");
    const issueMcpGrant = async (scopes: string[], tableIds: string[] = []) => {
      const verifier = randomBytes(40).toString("base64url"),
        challenge = createHash("sha256").update(verifier).digest("base64url"),
        authorization = new URL(`${baseURL}/oauth/authorize`);
      authorization.search = new URLSearchParams({
        client_id: oauthClientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${baseURL}/mcp`,
        organization_id: orgId,
        ...(tableIds.length ? { table_ids: tableIds.join(",") } : {}),
        scope: scopes.join(" "),
        state: "actual-runtime-state",
      }).toString();
      const authorizeResponse = await fetch(authorization, {
        headers: { Cookie: cookie },
        redirect: "manual",
      });
      assert.equal(authorizeResponse.status, 302);
      const consentId = new URL(
        authorizeResponse.headers.get("location")!,
      ).searchParams.get("requestId")!;
      assert.equal(
        (
          await request(
            `/api/internal/v1/oauth/requests/${consentId}`,
            "GET",
            undefined,
            { browser: true },
          )
        ).status,
        200,
      );
      const decision = await request(
        `/api/internal/v1/oauth/requests/${consentId}/decision`,
        "POST",
        { approve: true },
        { browser: true },
      );
      assert.equal(decision.status, 200);
      const callback = new URL((await decision.json()).redirectUri);
      assert.equal(callback.searchParams.get("state"), "actual-runtime-state");
      const tokensResponse = await fetch(`${baseURL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: oauthClientId,
          redirect_uri: redirectUri,
          resource: `${baseURL}/mcp`,
          code: callback.searchParams.get("code")!,
          code_verifier: verifier,
        }),
      });
      assert.equal(tokensResponse.status, 200);
      return tokensResponse.json() as Promise<{
        access_token: string;
        refresh_token: string;
      }>;
    };
    const tokens = await issueMcpGrant([
      "rows:read",
      "rows:write",
      "history:read",
      "tables:read",
      "databases:read",
      "keys:manage",
      "exports:read",
      "jobs:read",
      "schema:manage",
      "imports:write",
    ]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      }),
    );
    assert.equal((await client.listTools()).tools.length, operations.length);
    await t.test(
      "API-08 MCP genuine issued OAuth returns typed retryable dependency when the bounded work pool is occupied; operator status and liveness survive",
      async () => {
        const workConnections = await Promise.all(
          Array.from({ length: 10 }, () => runtime!.pool.connect()),
        );
        try {
          assert.equal((await request("/health/live")).status, 200);
          getOperation("getInstallationStatus").outputSchema.parse(
            await call("getInstallationStatus", {}, "browser"),
          );
          const failure = await client.callTool({
            name: getOperation("queryRows").toolName,
            arguments: { ...ids, query: { limit: 1 } },
          });
          assert.equal(failure.isError, true);
          const envelope = failure.structuredContent as {
            error: { code: string; details: { retryAfter: number } };
          };
          assert.equal(envelope.error.code, "DEPENDENCY_UNAVAILABLE");
          assert.equal(envelope.error.details.retryAfter, 1);
          assert.ok(
            !/timeout exceeded|SELECT|rootset_control|password|stack/i.test(
              JSON.stringify(failure),
            ),
          );
          assert.ok(
            dependencyEvents.filter((operation) => operation === "queryRows")
              .length >= 2,
          );
          assert.equal(
            Number(
              (
                await db.owner.query(
                  "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=$1",
                  [`user:${provision.userId}`],
                )
              ).rows[0].count,
            ),
            0,
          );
        } finally {
          workConnections.forEach((connection) => connection.release());
        }
        const recovered = await client.callTool({
          name: getOperation("queryRows").toolName,
          arguments: { ...ids, query: { limit: 1 } },
        });
        assert.notEqual(recovered.isError, true);
        getOperation("queryRows").outputSchema.parse(
          recovered.structuredContent,
        );
      },
    );

    const mcpOperation = async (
      id: string,
      input: Record<string, unknown>,
      key = newId(),
    ) => {
      const operation = getOperation(id),
        result = await client.callTool({
          name: operation.toolName,
          arguments: {
            ...input,
            ...(operation.idempotencyRequired ? { idempotencyKey: key } : {}),
          },
        });
      assert.notEqual(
        result.isError,
        true,
        JSON.stringify(result.structuredContent),
      );
      return operation.outputSchema.parse(result.structuredContent) as Record<
        string,
        unknown
      >;
    };
    const terminalJob = async (id: string) => {
      let job = await call("getJob", { orgId, id }, "rest");
      for (
        let attempt = 0;
        attempt < 10 &&
        ["queued", "running", "cancel_requested"].includes(job.state);
        attempt++
      ) {
        await runtime!.jobs.runOnce(orgId);
        job = await call("getJob", { orgId, id }, "rest");
      }
      assert.equal(job.state, "succeeded", JSON.stringify(job.error ?? {}));
      return job;
    };
    const journalKey = await call("createPersonalKey", {
        orgId,
        name: "Control replay verification",
        scopes: [
          "members:manage",
          "keys:manage",
          "backups:manage",
          "backups:read",
          "databases:read",
        ],
        targets: [],
        unrestricted: true,
      }),
      journalTokens = await issueMcpGrant([
        "members:manage",
        "keys:manage",
        "backups:manage",
        "backups:read",
        "databases:read",
      ]);
    await journalClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${journalTokens.access_token}` },
        },
      }),
    );
    const journalCall = async (
      mode: "rest" | "mcp",
      operationId: string,
      input: Record<string, unknown>,
      idempotencyKey: string,
      errorCode?: string,
    ) => {
      const operation = getOperation(operationId);
      if (mode === "rest") {
        const result = await call(
          operationId,
          input,
          "rest",
          errorCode ? 409 : undefined,
          idempotencyKey,
          journalKey.secret,
        );
        if (errorCode) assert.equal(result.error.code, errorCode);
        return result;
      }
      const result = await journalClient.callTool({
        name: operation.toolName,
        arguments: { ...input, idempotencyKey },
      });
      if (errorCode) {
        assert.equal(result.isError, true);
        assert.equal(
          (result.structuredContent as { error: { code: string } }).error.code,
          errorCode,
        );
        return result.structuredContent;
      }
      assert.notEqual(
        result.isError,
        true,
        JSON.stringify(result.structuredContent),
      );
      return operation.outputSchema.parse(result.structuredContent);
    };
    const journalInputs = {
      inviteMember: {
        orgId,
        email: `replay-${newId().toLowerCase()}@rootset.example`,
        role: "viewer",
      },
      beginAccountAction: {
        orgId,
        type: "create_key",
        operationId: "createPersonalKey",
        input: {
          orgId,
          name: "Replay-bound key approval",
          scopes: ["rows:read"],
          targets: [],
          unrestricted: true,
        },
      },
      setBackupPolicy: {
        orgId,
        databaseId,
        enabled: true,
        cron: "0 4 * * *",
        timezone: "UTC",
        destination: "installation",
        retentionDays: 30,
        retentionCount: 10,
        encryption: true,
        maxRuntimeSeconds: 3600,
        notifications: false,
      },
    };
    const journalResults: Record<string, Record<string, unknown>> = {};
    for (const mode of ["rest", "mcp"] as const) {
      journalResults[mode] = {};
      for (const [operationId, input] of Object.entries(journalInputs)) {
        const idempotencyKey = `runtime-shared-journal-${operationId}`;
        let executedInput: Record<string, unknown> = input;
        if (operationId === "setBackupPolicy") {
          const boundApproval = (await journalCall(
            mode,
            "beginAccountAction",
            {
              orgId,
              type: "set_backup_policy",
              operationId,
              input,
            },
            "runtime-shared-journal-policy-approval",
          )) as { id: string; state: string };
          assert.equal(boundApproval.state, "pending");
          const boundRequest = {
              orgId,
              type: "set_backup_policy",
              operationId,
              input,
            },
            rawReplay = JSON.stringify(
              mode === "rest"
                ? boundRequest
                : {
                    jsonrpc: "2.0",
                    id: 91,
                    method: "tools/call",
                    params: {
                      name: "rootset_begin_account_action",
                      arguments: {
                        ...boundRequest,
                        idempotencyKey:
                          "runtime-shared-journal-policy-approval",
                      },
                    },
                  },
            ).replace(
              '"retentionDays":30',
              '"retentionDays":30.00000000000000001',
            );
          const malformedReplay = await fetch(
            `${baseURL}${mode === "rest" ? "/v1/me/actions" : "/mcp"}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${mode === "rest" ? journalKey.secret : journalTokens.access_token}`,
                ...(mode === "rest"
                  ? {
                      "Idempotency-Key":
                        "runtime-shared-journal-policy-approval",
                    }
                  : { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION }),
              },
              body: rawReplay,
            },
          );
          assert.equal(malformedReplay.status, mode === "rest" ? 422 : 200);
          const malformedEnvelope = await malformedReplay.json();
          assert.equal(
            mode === "rest"
              ? malformedEnvelope.error.code
              : malformedEnvelope.result.structuredContent.error.code,
            "VALIDATION_FAILED",
          );
          assert.equal(
            (
              await db.owner.query(
                "SELECT count(*)::int count FROM rootset_control.account_actions WHERE id=$1",
                [boundApproval.id],
              )
            ).rows[0].count,
            1,
          );
          const approve = await request(
            `/api/internal/v1/account-actions/${boundApproval.id}/approve`,
            "POST",
            {},
            { browser: true },
          );
          assert.equal(approve.status, 200);
          assert.equal((await approve.json()).state, "approved");
          executedInput = { ...input, approvalId: boundApproval.id };
        }
        const [first, concurrent] = await Promise.all([
          journalCall(mode, operationId, executedInput, idempotencyKey),
          journalCall(mode, operationId, executedInput, idempotencyKey),
        ]);
        assert.deepEqual(
          concurrent,
          first,
          `${mode} ${operationId} concurrent publication`,
        );
        const policyTimestamp =
          operationId === "setBackupPolicy"
            ? (
                await db.owner.query(
                  "SELECT updated_at::text FROM rootset_control.backup_policies WHERE database_id=$1",
                  [databaseId],
                )
              ).rows[0].updated_at
            : undefined;
        const replay = await journalCall(
          mode,
          operationId,
          executedInput,
          idempotencyKey,
        );
        assert.deepEqual(
          replay,
          first,
          `${mode} ${operationId} stable outcome`,
        );
        if (policyTimestamp)
          assert.equal(
            (
              await db.owner.query(
                "SELECT updated_at::text FROM rootset_control.backup_policies WHERE database_id=$1",
                [databaseId],
              )
            ).rows[0].updated_at,
            policyTimestamp,
            `${mode} policy replay has no SQL mutation`,
          );
        journalResults[mode]![operationId] = first;
        const changed =
          operationId === "inviteMember"
            ? { ...input, role: "editor" }
            : operationId === "beginAccountAction"
              ? {
                  ...input,
                  input: {
                    ...journalInputs.beginAccountAction.input,
                    name: "Different bound approval",
                  },
                }
              : { ...executedInput, cron: "0 5 * * *" };
        await journalCall(
          mode,
          operationId,
          changed,
          idempotencyKey,
          "IDEMPOTENCY_CONFLICT",
        );
        if (operationId === "setBackupPolicy")
          assert.equal(
            (
              await db.owner.query(
                "SELECT cron FROM rootset_control.backup_policies WHERE database_id=$1",
                [databaseId],
              )
            ).rows[0].cron,
            journalInputs.setBackupPolicy.cron,
            `${mode} conflict leaves native policy intact`,
          );
      }
    }
    const restInvitation = journalResults.rest!.inviteMember as { id: string },
      mcpInvitation = journalResults.mcp!.inviteMember as { id: string },
      restAction = journalResults.rest!.beginAccountAction as { id: string },
      mcpAction = journalResults.mcp!.beginAccountAction as { id: string };
    assert.notEqual(
      restInvitation.id,
      mcpInvitation.id,
      "replay binding isolates credentials",
    );
    assert.notEqual(
      restAction.id,
      mcpAction.id,
      "approval binding isolates credentials",
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*)::int count FROM rootset_control.invitations WHERE org_id=$1 AND email=$2",
          [orgId, journalInputs.inviteMember.email],
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*)::int count FROM rootset_control.email_outbox WHERE template='invitation' AND to_address=$1",
          [journalInputs.inviteMember.email],
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*)::int count FROM rootset_control.account_actions WHERE id=ANY($1::varchar[])",
          [[restAction.id, mcpAction.id]],
        )
      ).rows[0].count,
      2,
    );
    const recorded = (
      await db.owner.query(
        "SELECT principal_binding,key_digest,input_digest,outcome FROM rootset_control.control_mutation_replays WHERE org_id=$1 AND operation_id=ANY($2::text[])",
        [orgId, Object.keys(journalInputs)],
      )
    ).rows;
    assert.equal(recorded.length, 8);
    for (const replay of recorded) {
      for (const column of ["principal_binding", "key_digest", "input_digest"])
        assert.match(replay[column], /^[a-f0-9]{64}$/);
      assert.equal(
        JSON.stringify(replay.outcome).includes(journalKey.secret),
        false,
      );
      assert.equal(
        JSON.stringify(replay.outcome).includes(journalTokens.access_token),
        false,
      );
    }
    const uploadBytes = Buffer.from("NAME,COUNT\nHTTP Upload,5\n"),
      uploadChecksum = createHash("sha256").update(uploadBytes).digest("hex"),
      upload = await call(
        "prepareImportUpload",
        {
          ...ids,
          format: "csv",
          byteLength: uploadBytes.length,
          checksum: uploadChecksum,
        },
        "rest",
      );
    assert.equal(new URL(upload.uploadUrl).origin, baseURL);
    assert.equal(upload.method, "PUT");
    assert.equal(upload.headers["content-type"], "application/octet-stream");
    const transfer = (
      url: string,
      bytes: Uint8Array,
      headers: Record<string, string>,
    ) =>
      fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", ...headers },
        body: Uint8Array.from(bytes),
      });
    assert.equal(
      (await transfer(upload.uploadUrl, uploadBytes, {})).status,
      401,
    );
    assert.equal(
      (
        await transfer(upload.uploadUrl, uploadBytes, {
          Cookie: cookie,
          Origin: "https://foreign.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await transfer(upload.uploadUrl, uploadBytes, {
          Authorization: `Bearer ${readKey.secret}`,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await transfer(upload.uploadUrl, uploadBytes, {
          Authorization: `Bearer ${restSecret}`,
          "Content-Type": "text/csv",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await transfer(upload.uploadUrl.replace(orgId, newId()), uploadBytes, {
          Authorization: `Bearer ${restSecret}`,
        })
      ).status,
      404,
    );
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === uploadBytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(uploadBytes.subarray(offset, offset + 3));
        offset = Math.min(uploadBytes.length, offset + 3);
      },
    });
    const streamed = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { ...upload.headers, Cookie: cookie, Origin: baseURL },
      body: source,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal(
      streamed.status,
      200,
      JSON.stringify(await streamed.clone().json()),
    );
    assert.deepEqual(await streamed.json(), {
      artifactId: upload.artifactId,
      byteLength: uploadBytes.length,
      checksum: uploadChecksum,
    });
    const replayUpload = await transfer(upload.uploadUrl, uploadBytes, {
      Authorization: `Bearer ${restSecret}`,
    });
    assert.equal(replayUpload.status, 200);
    const changedBytes = Buffer.from(uploadBytes);
    changedBytes[0] = 88;
    assert.equal(
      (
        await transfer(upload.uploadUrl, changedBytes, {
          Authorization: `Bearer ${restSecret}`,
        })
      ).status,
      409,
    );
    const staged = (
      await db.owner.query(
        "SELECT metadata FROM rootset_control.artifacts WHERE id=$1",
        [upload.artifactId],
      )
    ).rows[0];
    assert.equal(staged.metadata.uploadedBytes, uploadBytes.length);
    assert.equal(staged.metadata.uploadedChecksum, uploadChecksum);
    const prepareMcp = await client.callTool({
      name: "rootset_prepare_import_upload",
      arguments: {
        ...ids,
        format: "csv",
        byteLength: uploadBytes.length,
        checksum: uploadChecksum,
        idempotencyKey: "runtime-mcp-raw-upload",
      },
    });
    assert.notEqual(prepareMcp.isError, true);
    const mcpUpload = getOperation("prepareImportUpload").outputSchema.parse(
      prepareMcp.structuredContent,
    ) as { uploadUrl: string; artifactId: string };
    assert.equal(
      (
        await transfer(mcpUpload.uploadUrl, uploadBytes, {
          Authorization: `Bearer ${tokens.access_token}`,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows/${rowId}`,
          "GET",
          undefined,
          { token: tokens.access_token },
        )
      ).status,
      401,
    );
    const shortUpload = await call(
      "prepareImportUpload",
      { ...ids, format: "csv", byteLength: uploadBytes.length + 1 },
      "rest",
    );
    assert.equal(
      (
        await transfer(shortUpload.uploadUrl, uploadBytes, {
          Authorization: `Bearer ${restSecret}`,
        })
      ).status,
      422,
    );
    const corruptUpload = await call(
      "prepareImportUpload",
      {
        ...ids,
        format: "csv",
        byteLength: uploadBytes.length,
        checksum: "0".repeat(64),
      },
      "rest",
    );
    assert.equal(
      (
        await transfer(corruptUpload.uploadUrl, uploadBytes, {
          Authorization: `Bearer ${restSecret}`,
        })
      ).status,
      422,
    );
    for (const failedId of [shortUpload.artifactId, corruptUpload.artifactId]) {
      const metadata = (
        await db.owner.query(
          "SELECT metadata FROM rootset_control.artifacts WHERE id=$1",
          [failedId],
        )
      ).rows[0].metadata;
      assert.equal(metadata.uploadedObjectKey, undefined);
    }
    const approvedKeyInput = {
      orgId,
      name: "Delegated approved read key",
      scopes: ["rows:read"],
      targets: [],
      unrestricted: true,
    };
    const withoutApproval = await client.callTool({
      name: "rootset_create_personal_key",
      arguments: {
        ...approvedKeyInput,
        idempotencyKey: "runtime-approved-key-unapproved",
      },
    });
    assert.equal(withoutApproval.isError, true);
    assert.equal(
      (withoutApproval.structuredContent as { error: { code: string } }).error
        .code,
      "STEP_UP_REQUIRED",
    );
    const startedAction = await client.callTool({
      name: "rootset_begin_account_action",
      arguments: {
        orgId,
        type: "create_key",
        operationId: "createPersonalKey",
        input: approvedKeyInput,
        idempotencyKey: "runtime-approved-key-begin",
      },
    });
    assert.notEqual(startedAction.isError, true);
    const action = startedAction.structuredContent as {
      id: string;
      state: string;
    };
    assert.equal(action.state, "pending");
    const earlyCompletion = await client.callTool({
      name: "rootset_complete_account_action",
      arguments: {
        id: action.id,
        idempotencyKey: "runtime-approved-key-early",
      },
    });
    assert.equal(earlyCompletion.isError, true);
    const approval = await request(
      `/api/internal/v1/account-actions/${action.id}/approve`,
      "POST",
      {},
      { browser: true },
    );
    assert.equal(approval.status, 200);
    assert.equal((await approval.json()).state, "approved");
    const completedAction = await client.callTool({
      name: "rootset_complete_account_action",
      arguments: {
        id: action.id,
        idempotencyKey: "runtime-approved-key-complete",
      },
    });
    assert.notEqual(completedAction.isError, true);
    const completed = completedAction.structuredContent as {
      state: string;
      result: { key: { id: string }; secret?: string };
    };
    assert.equal(completed.state, "consumed");
    assert.equal(typeof completed.result.secret, "string");
    const completedReplay = await client.callTool({
      name: "rootset_complete_account_action",
      arguments: {
        id: action.id,
        idempotencyKey: "runtime-approved-key-different-replay",
      },
    });
    assert.notEqual(completedReplay.isError, true);
    const completedAgain = completedReplay.structuredContent as {
      state: string;
      result: { key: { id: string }; secret?: string };
    };
    assert.equal(completedAgain.state, "consumed");
    assert.equal(completedAgain.result.key.id, completed.result.key.id);
    assert.equal(completedAgain.result.secret, undefined);
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*)::int count FROM rootset_control.api_keys WHERE name=$1",
          ["Delegated approved read key"],
        )
      ).rows[0].count,
      1,
    );
    const mcpRead = await client.callTool({
      name: "rootset_get_row",
      arguments: { ...ids, rowId },
    });
    assert.deepEqual(mcpRead.structuredContent, created.row);
    const patch = await client.callTool({
      name: "rootset_update_row",
      arguments: {
        ...ids,
        rowId,
        expectedSchemaVersion: 1,
        expectedVersion: created.row.version,
        values: { NAME: "Example Airways" },
        idempotencyKey: "runtime-mcp-edit-0001",
      },
    });
    assert.notEqual(patch.isError, true);
    const updated = patch.structuredContent as {
      row: { version: string; values: Record<string, JsonValue> };
      mutationId: string;
    };
    assert.equal(updated.row.values.NAME, "Example Airways");
    assert.equal(updated.row.version, "2");
    const readBack = await call("getRow", { ...ids, rowId }, "rest");
    assert.deepEqual(readBack, updated.row);
    const inspectedMutation = await call(
      "getMutation",
      { orgId, id: updated.mutationId },
      "rest",
    );
    assert.equal(inspectedMutation.mutationId, updated.mutationId);
    assert.deepEqual(
      await mcpOperation("getMutation", { orgId, id: updated.mutationId }),
      inspectedMutation,
    );
    assert.equal(
      JSON.stringify(inspectedMutation).includes("physicalName"),
      false,
    );
    assert.equal(
      JSON.stringify(inspectedMutation).includes("schemaName"),
      false,
    );
    const nameField = schema.fields.find(
      (field: { apiKey: string }) => field.apiKey === "NAME",
    );
    const history = await call(
      "getCellHistory",
      { ...ids, rowId, fieldId: nameField.id },
      "rest",
    );
    assert.equal(history.data.length, 2);
    assert(
      history.data.some(
        (event: { before: JsonValue; after: JsonValue }) =>
          event.before === "Example Air" && event.after === "Example Airways",
      ),
    );
    const stale = await call(
      "updateRow",
      {
        ...ids,
        rowId,
        expectedSchemaVersion: 1,
        expectedVersion: "1",
        values: { NAME: "Stale" },
      },
      "rest",
      409,
    );
    assert.equal(stale.error.code, "ROW_VERSION_CONFLICT");
    const replay = await client.callTool({
      name: "rootset_update_row",
      arguments: {
        ...ids,
        rowId,
        expectedSchemaVersion: 1,
        expectedVersion: "1",
        values: { NAME: "Example Airways" },
        idempotencyKey: "runtime-mcp-edit-0001",
      },
    });
    assert.deepEqual(replay.structuredContent, patch.structuredContent);
    const afterReplay = await call(
      "getCellHistory",
      { ...ids, rowId, fieldId: nameField.id },
      "rest",
    );
    assert.equal(afterReplay.data.length, 2);
    const changedReplay = await client.callTool({
      name: "rootset_update_row",
      arguments: {
        ...ids,
        rowId,
        expectedSchemaVersion: 1,
        expectedVersion: "1",
        values: { NAME: "Changed payload" },
        idempotencyKey: "runtime-mcp-edit-0001",
      },
    });
    assert.equal(changedReplay.isError, true);
    assert.equal(
      (changedReplay.structuredContent as { error: { code: string } }).error
        .code,
      "IDEMPOTENCY_CONFLICT",
    );
    const window = await request(
      `/api/internal/v1/tables/${tableId}/windows/query`,
      "POST",
      { orgId, databaseId, query: { limit: 200 }, position: "last" },
      { browser: true },
    );
    assert.equal(window.status, 200);
    const viewport = await window.json();
    assert.equal(viewport.data[0].id, rowId);
    assert.equal(viewport.window.total, 1);
    const browserRow = await call("getRow", { ...ids, rowId }, "browser");
    assert.deepEqual(browserRow, updated.row);
    const exportStart = await client.callTool({
      name: "rootset_export_rows",
      arguments: {
        ...ids,
        format: "jsonl",
        idempotencyKey: "runtime-mcp-export-001",
      },
    });
    assert.notEqual(exportStart.isError, true);
    const acceptedExport = getOperation("exportRows").outputSchema.parse(
      exportStart.structuredContent,
    ) as { jobId: string; state: string };
    assert.equal(acceptedExport.state, "queued");
    const exportReplay = await client.callTool({
      name: "rootset_export_rows",
      arguments: {
        ...ids,
        format: "jsonl",
        idempotencyKey: "runtime-mcp-export-001",
      },
    });
    assert.notEqual(exportReplay.isError, true);
    assert.deepEqual(
      exportReplay.structuredContent,
      exportStart.structuredContent,
    );
    const changedExportReplay = await client.callTool({
      name: "rootset_export_rows",
      arguments: {
        ...ids,
        format: "csv",
        idempotencyKey: "runtime-mcp-export-001",
      },
    });
    assert.equal(changedExportReplay.isError, true);
    assert.equal(
      (changedExportReplay.structuredContent as { error: { code: string } })
        .error.code,
      "IDEMPOTENCY_CONFLICT",
    );
    let exportJob = await call(
      "getJob",
      { orgId, id: acceptedExport.jobId },
      "rest",
    );
    for (
      let attempt = 0;
      attempt < 10 &&
      ["queued", "running", "cancel_requested"].includes(exportJob.state);
      attempt++
    ) {
      await runtime.jobs.runOnce(orgId);
      exportJob = await call(
        "getJob",
        { orgId, id: acceptedExport.jobId },
        "rest",
      );
    }
    assert.equal(
      exportJob.state,
      "succeeded",
      JSON.stringify(exportJob.error ?? {}),
    );
    assert.equal(exportJob.result.rowCount, 1);
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*)::int count FROM rootset_control.artifacts WHERE job_id=$1 AND purpose='export'",
          [acceptedExport.jobId],
        )
      ).rows[0].count,
      1,
    );
    const exportArtifact = await call(
      "getArtifact",
      { orgId, id: exportJob.result.artifactId },
      "rest",
    );
    const mcpArtifact = await client.callTool({
      name: "rootset_get_artifact",
      arguments: { orgId, id: exportJob.result.artifactId },
    });
    assert.notEqual(mcpArtifact.isError, true);
    assert.deepEqual(mcpArtifact.structuredContent, exportArtifact);
    const resource = await client.readResource({
      uri: exportArtifact.resourceUri,
    });
    assert.equal(resource.contents.length, 1);
    assert.deepEqual(
      JSON.parse((resource.contents[0] as { text: string }).text),
      exportArtifact,
    );
    const downloaded = await request(
      new URL(exportArtifact.downloadUrl).pathname,
      "GET",
      undefined,
      { token: restSecret },
    );
    assert.equal(downloaded.status, 200);
    const exportText = await downloaded.text();
    assert.deepEqual(JSON.parse(exportText.trim()), updated.row.values);
    assert.equal(
      createHash("sha256").update(exportText).digest("hex"),
      exportArtifact.checksum,
    );
    assert.equal(
      downloaded.headers.get("digest"),
      `sha-256=${createHash("sha256").update(exportText).digest("base64")}`,
    );
    const artifactPath = new URL(exportArtifact.downloadUrl).pathname;
    const browserArtifactPath = artifactPath.replace(
      /^\/v1\//,
      "/api/internal/v1/",
    );
    const browserDownload = await request(
      browserArtifactPath,
      "GET",
      undefined,
      { browser: true },
    );
    assert.equal(browserDownload.status, 200);
    assert.equal(await browserDownload.text(), exportText);
    assert.equal(
      browserDownload.headers.get("digest"),
      downloaded.headers.get("digest"),
    );
    assert.equal(
      (await request(artifactPath, "GET", undefined, { browser: true })).status,
      401,
    );
    assert.equal(
      (
        await request(browserArtifactPath, "GET", undefined, {
          token: restSecret,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          browserArtifactPath.replace(orgId, newId()),
          "GET",
          undefined,
          { browser: true },
        )
      ).status,
      404,
    );
    const mcpDownload = await request(artifactPath, "GET", undefined, {
      token: tokens.access_token,
    });
    assert.equal(mcpDownload.status, 200);
    assert.equal(await mcpDownload.text(), exportText);
    assert.equal(
      mcpDownload.headers.get("digest"),
      downloaded.headers.get("digest"),
    );
    assert.equal(
      (
        await request(artifactPath.replace(orgId, newId()), "GET", undefined, {
          token: tokens.access_token,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows/${rowId}`,
          "GET",
          undefined,
          { token: tokens.access_token },
        )
      ).status,
      401,
    );
    const readExportGrant = await issueMcpGrant(
      ["rows:read", "tables:read", "exports:read"],
      [tableId],
    );
    const readExportDownload = await request(artifactPath, "GET", undefined, {
      token: readExportGrant.access_token,
    });
    assert.equal(readExportDownload.status, 200);
    assert.equal(await readExportDownload.text(), exportText);
    const missingExportGrant = await issueMcpGrant(
      ["rows:read", "tables:read"],
      [tableId],
    );
    assert.equal(
      (
        await request(artifactPath, "GET", undefined, {
          token: missingExportGrant.access_token,
        })
      ).status,
      403,
    );
    const revokedExportGrant = await fetch(`${baseURL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthClientId,
        token: readExportGrant.refresh_token,
      }),
    });
    assert.equal(revokedExportGrant.status, 200);
    assert.equal(
      (
        await request(artifactPath, "GET", undefined, {
          token: readExportGrant.access_token,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          new URL(exportArtifact.downloadUrl).pathname,
          "GET",
          undefined,
          { token: readKey.secret },
        )
      ).status,
      403,
    );
    const fieldStarted = await client.callTool({
      name: "rootset_apply_schema_change",
      arguments: {
        ...ids,
        expectedSchemaVersion: 1,
        change: {
          kind: "add_field",
          field: {
            type: "text",
            apiKey: "NOTES",
            label: "Notes",
            charLimit: 240,
          },
        },
        idempotencyKey: "runtime-generic-schema-field",
      },
    });
    assert.notEqual(fieldStarted.isError, true);
    const fieldAccepted = fieldStarted.structuredContent as {
      jobId: string;
      state: string;
    };
    assert.equal(fieldAccepted.state, "queued");
    let fieldJob = await call(
      "getJob",
      { orgId, id: fieldAccepted.jobId },
      "rest",
    );
    for (
      let attempt = 0;
      attempt < 10 &&
      ["queued", "running", "cancel_requested"].includes(fieldJob.state);
      attempt++
    ) {
      await runtime.jobs.runOnce(orgId);
      fieldJob = await call(
        "getJob",
        { orgId, id: fieldAccepted.jobId },
        "rest",
      );
    }
    assert.equal(
      fieldJob.state,
      "succeeded",
      JSON.stringify(fieldJob.error ?? {}),
    );
    assert.equal(fieldJob.result.table.schemaVersion, 2);
    assert.equal(typeof fieldJob.result.schemaOperationId, "string");
    const journal = await call(
      "getSchemaOperation",
      { ...ids, id: fieldAccepted.jobId },
      "rest",
    );
    assert.equal(journal.id, fieldJob.result.schemaOperationId);
    assert.equal(journal.jobId, fieldAccepted.jobId);
    assert.equal(journal.phase, "committed");
    assert.equal(journal.change.field.apiKey, "NOTES");
    assert.equal(journal.before.table.schemaVersion, 1);
    const journalById = await client.callTool({
      name: "rootset_get_schema_operation",
      arguments: { ...ids, id: journal.id },
    });
    assert.notEqual(journalById.isError, true);
    assert.deepEqual(journalById.structuredContent, journal);
    const latestSchema = await call("getTableSchema", ids, "rest");
    assert.equal(latestSchema.table.schemaVersion, 2);
    assert.equal(latestSchema.fields.length, 9);
    assert.equal(
      latestSchema.fields.find(
        (field: { apiKey: string }) => field.apiKey === "NOTES",
      ).charLimit,
      240,
    );
    const staleSchema = await call(
      "createField",
      {
        ...ids,
        expectedSchemaVersion: 1,
        field: { type: "text", apiKey: "STALE", label: "Stale" },
      },
      "rest",
      409,
    );
    assert.equal(staleSchema.error.code, "SCHEMA_VERSION_CONFLICT");
    const historyFirst = await call(
      "queryHistory",
      { ...ids, rowId, fieldId: nameField.id, limit: 1 },
      "rest",
    );
    assert.equal(historyFirst.data.length, 1);
    assert.equal(historyFirst.hasMore, true);
    assert(historyFirst.nextCursor);
    const historySecond = await call(
      "queryHistory",
      {
        ...ids,
        rowId,
        fieldId: nameField.id,
        limit: 1,
        cursor: historyFirst.nextCursor,
      },
      "rest",
    );
    assert.equal(historySecond.data.length, 1);
    assert.equal(historySecond.hasMore, false);
    assert.notEqual(historySecond.data[0].id, historyFirst.data[0].id);
    const usage = await call("getUsage", { orgId }, "rest");
    assert.equal(usage.databases, 1);
    assert.equal(usage.tables, 1);
    assert.equal(usage.rows, 1);
    assert(usage.dataBytes > 0);
    assert(usage.indexBytes > 0);
    assert(usage.historyBytes > 0);
    assert(usage.artifactBytes > 0);
    assert.equal(usage.storageQuotaBytes, null);
    const activeFields = await call("listFields", ids, "rest");
    assert.equal(activeFields.data.length, schema.fields.length + 1);
    assert.deepEqual(await mcpOperation("listFields", ids), activeFields);
    const previewInput = {
        ...ids,
        expectedSchemaVersion: 2,
        change: {
          kind: "add_field",
          field: {
            type: "text",
            apiKey: "PREVIEW_ONLY",
            label: "Preview only",
            charLimit: 128,
          },
        },
      },
      restPreview = await call("previewSchemaChange", previewInput, "rest"),
      mcpPreview = await mcpOperation("previewSchemaChange", previewInput);
    assert.equal(restPreview.valid, true);
    assert.equal(restPreview.rowCount, 1);
    assert.deepEqual(mcpPreview, restPreview);
    assert.equal(
      (await call("getTableSchema", ids, "rest")).fields.some(
        (field: { apiKey: string }) => field.apiKey === "PREVIEW_ONLY",
      ),
      false,
    );
    const restStats = await call("getTableStatistics", ids, "rest"),
      mcpStats = await mcpOperation("getTableStatistics", ids);
    assert.equal(restStats.liveRows, 1);
    assert.equal(mcpStats.liveRows, restStats.liveRows);
    assert.equal(mcpStats.historyEvents, restStats.historyEvents);
    const liveCount = await call("countRows", ids, "rest"),
      mcpCount = await mcpOperation("countRows", ids);
    assert.equal(liveCount.count, 1);
    assert.equal(mcpCount.count, liveCount.count);
    const exactCount = await mcpOperation("countRows", { ...ids, exact: true });
    assert.equal(
      (await terminalJob(exactCount.jobId as string)).result.count,
      1,
    );
    const wideTable = await call("createTable", {
        orgId,
        databaseId,
        name: "Wide sort cursor traversal",
        fields: [
          {
            type: "text",
            apiKey: "SORT",
            label: "Wide sort value",
            charLimit: 65536,
          },
          { type: "integer", apiKey: "VALUE", label: "Value" },
        ],
      }),
      wideIds = { orgId, databaseId, tableId: wideTable.table.id };
    const sortLength =
      limits.rowBytes - rowBytes(wideTable.fields, { SORT: "", VALUE: 1 });
    for (const [sortValue, value] of [
      ["A".repeat(sortLength), 1],
      ["B".repeat(sortLength), 2],
    ] as const)
      await call(
        "createRow",
        {
          ...wideIds,
          expectedSchemaVersion: 1,
          values: { SORT: sortValue, VALUE: value },
        },
        "rest",
      );
    const widePageInput = {
        ...wideIds,
        select: ["VALUE"],
        orderBy: [{ field: "SORT", direction: "asc" }],
        limit: 1,
      },
      wideFirst = await call("listRows", widePageInput, "rest");
    assert.equal(wideFirst.data[0].values.VALUE, 1);
    assert(wideFirst.page.nextCursor.length > 81920);
    assert(wideFirst.page.nextCursor.length <= 131200);
    const wideSecond = await call(
      "listRows",
      { ...widePageInput, cursor: wideFirst.page.nextCursor },
      "rest",
    );
    assert.equal(wideSecond.data[0].values.VALUE, 2);
    assert.equal(wideSecond.page.hasMore, false);
    t.diagnostic(
      `Actual GET wide-sort traversal: cursor ${wideFirst.page.nextCursor.length} characters; native row values at ${limits.rowBytes} bytes; Node request/header budget ${httpServerOptions.maxHeaderSize} bytes.`,
    );
    const reverseFieldIds = wideTable.fields
        .map((field: { id: string }) => field.id)
        .reverse(),
      reordered = await mcpOperation("reorderFields", {
        ...wideIds,
        expectedSchemaVersion: 1,
        fieldIds: reverseFieldIds,
      });
    assert.equal(
      (reordered.table as { schemaVersion: number }).schemaVersion,
      2,
    );
    assert.deepEqual(
      (reordered.fields as { id: string }[]).map((field) => field.id),
      reverseFieldIds,
    );
    const readGrant = await issueMcpGrant(
      ["rows:read", "tables:read"],
      [wideIds.tableId],
    );
    await readOnlyClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${readGrant.access_token}` },
        },
      }),
    );
    const hiddenMutation = await readOnlyClient.callTool({
      name: "rootset_get_mutation",
      arguments: { orgId, id: updated.mutationId },
    });
    assert.equal(hiddenMutation.isError, true);
    assert.equal(
      (hiddenMutation.structuredContent as { error: { code: string } }).error
        .code,
      "RESOURCE_NOT_FOUND",
    );
    await assert.rejects(
      readOnlyClient.callTool({
        name: "rootset_reorder_fields",
        arguments: {
          ...wideIds,
          expectedSchemaVersion: 2,
          fieldIds: reverseFieldIds,
          idempotencyKey: "runtime-read-only-reorder",
        },
      }),
      (error) => error instanceof StreamableHTTPError && error.code === 403,
    );
    const reorderDenied = await request(
      `/v1/orgs/${orgId}/databases/${databaseId}/tables/${wideIds.tableId}/field-order`,
      "PUT",
      { expectedSchemaVersion: 2, fieldIds: reverseFieldIds },
      { token: readKey.secret, key: "runtime-read-only-reorder" },
    );
    assert.equal(reorderDenied.status, 403);
    const valueField = wideTable.fields.find(
        (field: { apiKey: string }) => field.apiKey === "VALUE",
      ),
      uniqueStarted = await mcpOperation("createUniqueRule", {
        ...wideIds,
        expectedSchemaVersion: 2,
        fieldIds: [valueField.id],
      });
    await terminalJob(uniqueStarted.jobId as string);
    const ruleSchema = await call("getTableSchema", wideIds, "rest");
    assert.equal(ruleSchema.table.schemaVersion, 3);
    assert.equal(ruleSchema.uniqueRules.length, 1);
    const uniqueDeleted = await mcpOperation("deleteUniqueRule", {
      ...wideIds,
      expectedSchemaVersion: 3,
      id: ruleSchema.uniqueRules[0].id,
    });
    assert.equal(uniqueDeleted.deleted, true);
    assert.equal(
      (await call("getTableSchema", wideIds, "rest")).uniqueRules.length,
      0,
    );
    const secondTable = await call("createTable", {
      orgId,
      databaseId,
      name: "Restricted peer",
      fields: [{ type: "text", apiKey: "NAME", label: "Name" }],
    });
    const peerGrant = await issueMcpGrant(
      ["rows:read", "tables:read", "exports:read"],
      [secondTable.table.id],
    );
    assert.equal(
      (
        await request(artifactPath, "GET", undefined, {
          token: peerGrant.access_token,
        })
      ).status,
      404,
    );
    const hiddenJournal = await call(
      "getSchemaOperation",
      { ...ids, tableId: secondTable.table.id, id: fieldAccepted.jobId },
      "rest",
      404,
    );
    assert.equal(hiddenJournal.error.code, "RESOURCE_NOT_FOUND");
    const scoped = await call("createPersonalKey", {
      orgId,
      name: "One table only",
      scopes: ["databases:read", "tables:read", "rows:read"],
      targets: [{ databaseId, tableId, level: "read" }],
      unrestricted: false,
    });
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
          "POST",
          { query: {} },
          { token: scoped.secret },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${secondTable.table.id}/query`,
          "POST",
          { query: {} },
          { token: scoped.secret },
        )
      ).status,
      404,
    );
    const scopedTables = await request(
      `/v1/orgs/${orgId}/databases/${databaseId}/tables`,
      "GET",
      undefined,
      { token: scoped.secret },
    );
    assert.equal(scopedTables.status, 200);
    assert.deepEqual(
      (await scopedTables.json()).data.map((table: { id: string }) => table.id),
      [tableId],
    );
    const ownerCookie = cookie,
      invitedEmail = `viewer-${newId().toLowerCase()}@rootset.example`;
    await call("inviteMember", { orgId, email: invitedEmail, role: "viewer" });
    const invitationEnvelope = (
      await db.owner.query(
        "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template=$1 AND to_address=$2 ORDER BY created_at DESC LIMIT 1",
        ["invitation", invitedEmail],
      )
    ).rows[0];
    assert(invitationEnvelope);
    const invitation = decryptProtected<{ actionUrl: string }>(
        invitationEnvelope.payload_encrypted,
        config,
      ),
      invitationToken = new URL(invitation.actionUrl).pathname
        .split("/")
        .at(-1)!;
    const onboarding = await request(
      "/v1/auth/invitations/accept",
      "POST",
      {
        token: invitationToken,
        name: "Rootset verification viewer",
        password: "Rootset viewer verification password 2026!",
      },
      { headers: { Origin: baseURL } },
    );
    assert.equal(onboarding.status, 202);
    const viewerVerificationEnvelope = (
      await db.owner.query(
        "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template=$1 AND to_address=$2 ORDER BY created_at DESC LIMIT 1",
        ["account-verification", invitedEmail],
      )
    ).rows[0];
    assert(viewerVerificationEnvelope);
    const viewerVerification = decryptProtected<{ actionUrl: string }>(
      viewerVerificationEnvelope.payload_encrypted,
      config,
    );
    assert(
      [200, 302].includes(
        (await fetch(viewerVerification.actionUrl, { redirect: "manual" }))
          .status,
      ),
    );
    const viewerLogin = await request(
      "/v1/auth/sign-in/email",
      "POST",
      {
        email: invitedEmail,
        password: "Rootset viewer verification password 2026!",
      },
      { headers: { Origin: baseURL } },
    );
    assert.equal(viewerLogin.status, 200);
    cookie = viewerLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const accepted = await request(
      "/v1/auth/invitations/accept",
      "POST",
      { token: invitationToken },
      { browser: true },
    );
    assert.equal(accepted.status, 200);
    const viewerContext = await (
      await request("/api/internal/v1/context", "GET", undefined, {
        browser: true,
      })
    ).json();
    assert.equal(viewerContext.principal.role, "viewer");
    await call("queryRows", { ...ids, query: {} }, "browser");
    await call(
      "createRow",
      { ...ids, expectedSchemaVersion: 1, values: { NAME: "Viewer denied" } },
      "browser",
      403,
    );
    const viewerKey = await call("createPersonalKey", {
      orgId,
      name: "Viewer read key",
      scopes: ["rows:read", "tables:read", "databases:read"],
      targets: [],
      unrestricted: true,
    });
    assert(viewerKey.secret);
    await call(
      "createPersonalKey",
      {
        orgId,
        name: "Forbidden viewer write key",
        scopes: ["rows:write"],
        targets: [],
        unrestricted: true,
      },
      "browser",
      403,
    );
    const viewerCookie = cookie;
    cookie = ownerCookie;
    let viewerMember = (
      await db.owner.query(
        "SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, viewerContext.principal.userId],
      )
    ).rows[0];
    const editorMember = await call("updateMember", {
      orgId,
      id: viewerMember.id,
      role: "editor",
      expectedVersion: String(viewerMember.version),
    });
    await call("updateGrants", {
      orgId,
      grants: [
        {
          membershipId: editorMember.id,
          version: Number(editorMember.version),
          unrestricted: false,
          targets: [{ databaseId, tableId, level: "manage" }],
        },
      ],
    });
    cookie = viewerCookie;
    const scopeKey = await call("createPersonalKey", {
        orgId,
        name: "Current target authority replay verification",
        scopes: ["tables:read", "tables:manage"],
        targets: [{ databaseId, tableId, level: "manage" }],
        unrestricted: false,
      }),
      scopeTokens = await issueMcpGrant(
        ["tables:read", "tables:manage"],
        [tableId],
      ),
      currentSchema = await call("getTableSchema", ids),
      targetActionInput = {
        orgId,
        type: "delete_table",
        operationId: "deleteTable",
        input: {
          ...ids,
          expectedSchemaVersion: currentSchema.table.schemaVersion,
        },
      };
    await scopeClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${scopeTokens.access_token}` },
        },
      }),
    );
    const targetRestAction = await call(
        "beginAccountAction",
        targetActionInput,
        "rest",
        undefined,
        "runtime-target-scope-rest-action",
        scopeKey.secret,
      ),
      targetMcpResult = await scopeClient.callTool({
        name: getOperation("beginAccountAction").toolName,
        arguments: {
          ...targetActionInput,
          idempotencyKey: "runtime-target-scope-mcp-action",
        },
      });
    assert.notEqual(targetMcpResult.isError, true);
    const targetMcpAction = getOperation(
      "beginAccountAction",
    ).outputSchema.parse(targetMcpResult.structuredContent) as {
      id: string;
      state: string;
    };
    assert.equal(targetRestAction.state, "pending");
    assert.equal(targetMcpAction.state, "pending");
    assert.notEqual(targetRestAction.id, targetMcpAction.id);
    cookie = ownerCookie;
    viewerMember = (
      await db.owner.query(
        "SELECT id,version FROM rootset_control.memberships WHERE id=$1",
        [viewerMember.id],
      )
    ).rows[0];
    await call("updateGrants", {
      orgId,
      grants: [
        {
          membershipId: viewerMember.id,
          version: Number(viewerMember.version),
          unrestricted: false,
          targets: [{ databaseId, tableId, level: "read" }],
        },
      ],
    });
    await call("listFields", ids, "rest", undefined, newId(), scopeKey.secret);
    assert.equal(
      (await scopeClient.listTools()).tools.length,
      operations.length,
    );
    const targetRestDenied = await call(
        "beginAccountAction",
        targetActionInput,
        "rest",
        403,
        "runtime-target-scope-rest-action",
        scopeKey.secret,
      ),
      targetMcpDenied = await scopeClient.callTool({
        name: getOperation("beginAccountAction").toolName,
        arguments: {
          ...targetActionInput,
          idempotencyKey: "runtime-target-scope-mcp-action",
        },
      });
    assert.equal(targetRestDenied.error.code, "FORBIDDEN");
    assert.equal(targetMcpDenied.isError, true);
    assert.equal(
      (targetMcpDenied.structuredContent as { error: { code: string } }).error
        .code,
      "FORBIDDEN",
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*)::int count FROM rootset_control.account_actions WHERE id=ANY($1::text[]) AND consumed_at IS NULL",
          [[targetRestAction.id, targetMcpAction.id]],
        )
      ).rows[0].count,
      2,
    );
    viewerMember = (
      await db.owner.query(
        "SELECT id,version FROM rootset_control.memberships WHERE id=$1",
        [viewerMember.id],
      )
    ).rows[0];
    await call("updateMember", {
      orgId,
      id: viewerMember.id,
      role: "viewer",
      expectedVersion: String(viewerMember.version),
    });
    const restrictedWindow = await fetch(
      `${baseURL}/api/internal/v1/tables/${secondTable.table.id}/windows/query`,
      {
        method: "POST",
        headers: {
          Cookie: viewerCookie,
          Origin: baseURL,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orgId,
          databaseId,
          query: { limit: 200 },
          position: "first",
        }),
      },
    );
    assert.equal(restrictedWindow.status, 404);
    assert.equal(
      (await restrictedWindow.json()).error.code,
      "RESOURCE_NOT_FOUND",
    );
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
          "POST",
          { query: {} },
          { token: viewerKey.secret },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${secondTable.table.id}/query`,
          "POST",
          { query: {} },
          { token: viewerKey.secret },
        )
      ).status,
      404,
    );
    const currentViewerMember = (
      await db.owner.query(
        "SELECT version::text version FROM rootset_control.memberships WHERE id=$1",
        [viewerMember.id],
      )
    ).rows[0];
    await call("updateMember", {
      orgId,
      id: viewerMember.id,
      state: "disabled",
      expectedVersion: currentViewerMember.version,
    });
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
          "POST",
          { query: {} },
          { token: viewerKey.secret },
        )
      ).status,
      401,
    );
    const keyReplay = await call(
      "createPersonalKey",
      { ...keyRequest, name: "Secret replay check" },
      "browser",
      undefined,
      "runtime-secret-once-001",
    );
    assert(keyReplay.secret);
    const redactedReplay = await call(
      "createPersonalKey",
      { ...keyRequest, name: "Secret replay check" },
      "browser",
      undefined,
      "runtime-secret-once-001",
    );
    assert.equal(redactedReplay.secret, undefined);
    assert.equal(redactedReplay.replayed, true);
    for (const operation of operations) {
      const path = operation.path.replace(/\{([^}]+)\}/g, () => newId());
      const response = await request(
        path,
        operation.httpMethod,
        operation.httpMethod === "GET" ? undefined : {},
        { token: "invalid-credential" },
      );
      assert.equal(
        response.status,
        401,
        `${operation.id} route authentication`,
      );
    }
    await call("revokePersonalKey", { id: readKey.key.id }, "browser");
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/query`,
          "POST",
          { query: {} },
          { token: readKey.secret },
        )
      ).status,
      401,
    );
    await call("revokePersonalKey", { id: journalKey.key.id }, "browser");
    for (const [operationId, input] of Object.entries(journalInputs)) {
      const denied = await call(
        operationId,
        input,
        "rest",
        401,
        `runtime-shared-journal-${operationId}`,
        journalKey.secret,
      );
      assert.equal(denied.error.code, "UNAUTHENTICATED");
    }
    assert.equal(
      (
        await fetch(`${baseURL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: oauthClientId,
            token: journalTokens.refresh_token,
          }),
        })
      ).status,
      200,
    );
    for (const [operationId, input] of Object.entries(journalInputs))
      await assert.rejects(
        journalClient.callTool({
          name: getOperation(operationId).toolName,
          arguments: {
            ...input,
            idempotencyKey: `runtime-shared-journal-${operationId}`,
          },
        }),
      );
    await db.owner.query(
      "UPDATE rootset_control.memberships SET state='disabled',version=version+1 WHERE org_id=$1 AND user_id=$2",
      [orgId, provision.userId],
    );
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows/${rowId}`,
          "GET",
          undefined,
          { token: restSecret },
        )
      ).status,
      401,
    );
    await assert.rejects(client.listTools());
    assert.equal(
      (
        await request(artifactPath, "GET", undefined, {
          token: tokens.access_token,
        })
      ).status,
      401,
    );
    t.diagnostic(
      `Successful actual transport operation classes: ${[...positiveOperations].sort().join(", ")}; all ${operations.length} tool discoveries and route authentication checks are separate evidence.`,
    );
  } finally {
    await client.close();
    await journalClient.close();
    await readOnlyClient.close();
    await scopeClient.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (runtime) await runtime.close();
    await db.close();
  }
});
