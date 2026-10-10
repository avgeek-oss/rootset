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
  KeyCreatedSchema,
  RootsetError,
  newId,
  operations,
  generateClientSource,
  limits,
  rowBytes,
  type JsonValue,
} from "@rootset/contracts";
import { decryptProtected } from "../../../packages/email/src/index.js";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createRuntimeApp } from "./runtime-app.js";
import { httpServerOptions } from "./http-server.js";

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
      webURL: baseURL,
      port: address.port,
      databaseURL: db.app.options.connectionString!,
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
    const testRuntime = {
      ...runtime,
      getAdmissionLimits: () => ({
        principalRequestsPerMinute: 100000,
        organisationRequestsPerMinute: 1000000,
        concurrentReads: 10,
        concurrentMutations: 5,
      }),
    };
    app = createRuntimeApp(testRuntime);
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
    assert.equal(provision.state, "ready");
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*) FROM rootset_control.email_outbox WHERE template='account-verification'",
        )
      ).rows[0].count,
      "0",
    );
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
    const keyRequest = {
      access: "edit",
      includeAdmin: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
      orgId: provision.orgId,
      name: "Runtime read and write",
    };
    const key = await call("createPersonalKey", keyRequest, "browser");
    assert.equal(typeof key.secret, "string");
    restSecret = key.secret;
    const readKey = await call("createPersonalKey", {
      access: "read",
      includeAdmin: false,
      expiresAt: "2030-01-01T00:00:00.000Z",
      orgId: provision.orgId,
      name: "Read only",
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
        { type: "text", name: "NAME", charLimit: 120 },
        {
          type: "integer",
          name: "COUNT",
          min: 0,
          max: 9007199254740991,
        },
        { type: "float", name: "SCORE" },
        { type: "boolean", name: "ACTIVE" },
        { type: "date", name: "DATE" },
        { type: "time", name: "TIME" },
        { type: "date-time", name: "UPDATED" },
        { type: "json", name: "CONFIG" },
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
        const dependencyEventStart = dependencyEvents.length;
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
        const peerUserId = newId(),
          peerSessionId = newId();
        await db.owner.query(
          `INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Peer fixture',$2,true)`,
          [peerUserId, `peer-${peerUserId.toLowerCase()}@example.test`],
        );
        await db.owner.query(
          `INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'viewer')`,
          [newId(), orgId, peerUserId],
        );
        await db.owner.query(
          `INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 hour',now())`,
          [peerSessionId, peerUserId, newId()],
        );
        const peerKey = KeyCreatedSchema.parse(
          await runtime!.core.execute(
            "createPersonalKey",
            {
              kind: "session",
              id: peerSessionId,
              userId: peerUserId,
              orgId,
              role: "viewer",
              scopes: [],
              authenticatedAt: Date.now(),
            },
            {
              orgId,
              name: "Independent saturated workload credential",
              access: "read",
              includeAdmin: false,
              expiresAt: "2030-01-01T00:00:00.000Z",
            },
            { surface: "browser", idempotencyKey: newId() },
          ),
        );
        const peerPrincipal = `user:${peerUserId}`;
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
            if (
              active === 10 &&
              runtime!.pool.totalCount === 10 &&
              runtime!.pool.idleCount === 0
            )
              break;
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
            dependencyEvents
              .slice(dependencyEventStart)
              .filter((operation) =>
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
    const restrictedWrite = await request(
      `/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/rows`,
      "POST",
      { expectedSchemaVersion: 1, values: { NAME: "Denied" } },
      { token: readKey.secret, key: newId() },
    );
    assert.equal(restrictedWrite.status, 403);
    const editKey = await call("createPersonalKey", {
      orgId,
      name: "Edit ceiling",
      access: "edit",
      includeAdmin: false,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await call(
      "createDatabase",
      { orgId, name: "Edit allowed" },
      "rest",
      201,
      newId(),
      editKey.secret,
    );
    await t.test(
      "Team keys are workspace-owned, admin-managed and permission-limited across REST and MCP",
      async () => {
        const creatorId = newId(),
          creatorSession = newId();
        await db.owner.query(
          `INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Team key creator',$2,true)`,
          [creatorId, `team-${creatorId.toLowerCase()}@example.test`],
        );
        await db.owner.query(
          `INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')`,
          [newId(), orgId, creatorId],
        );
        await db.owner.query(
          `INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 hour',now())`,
          [creatorSession, creatorId, newId()],
        );
        const creator = {
          kind: "session" as const,
          id: creatorSession,
          userId: creatorId,
          orgId,
          role: "admin" as const,
          scopes: [],
          authenticatedAt: Date.now(),
        };
        const keys = [];
        for (const [access, includeAdmin] of [
          ["read", false],
          ["edit", false],
          ["edit", true],
        ] as const) {
          const input = {
            orgId,
            name: `Team ${access} ${includeAdmin}`,
            access,
            includeAdmin,
            expiresAt: "2030-01-01T00:00:00.000Z",
          };
          const key = KeyCreatedSchema.parse(
            await runtime!.core.execute("createTeamKey", creator, input, {
              surface: "browser",
              idempotencyKey: newId(),
            }),
          );
          assert.equal(key.key.scope, "team");
          assert.equal(key.key.userId, null);
          keys.push(key);
        }
        const [readTeam, editTeam, adminTeam] = keys;
        for (const role of ["member", "viewer"]) {
          await db.owner.query(
            `UPDATE rootset_control.memberships SET role=$2,version=version+1 WHERE user_id=$1`,
            [creatorId, role],
          );
          for (const [operation, input] of [
            ["listTeamKeys", { orgId }],
            [
              "createTeamKey",
              {
                orgId,
                name: "Denied member team key",
                access: "read",
                includeAdmin: false,
                expiresAt: null,
              },
            ],
            ["rotateTeamKey", { orgId, id: keys[0]!.key.id }],
            ["revokeTeamKey", { orgId, id: keys[0]!.key.id }],
          ] as const) {
            await assert.rejects(
              () =>
                runtime!.core.execute(operation, creator, input, {
                  surface: "browser",
                  idempotencyKey: newId(),
                }),
              (error) => error instanceof RootsetError && error.status === 403,
            );
          }
        }
        // Departure revokes personal authority, while workspace credentials stay valid.
        await db.owner.query(
          `DELETE FROM rootset_control.memberships WHERE user_id=$1`,
          [creatorId],
        );
        for (const team of keys) {
          const principal = await runtime!.identity.resolveActor(
            new Request(`${baseURL}/v1/context`, {
              headers: { Authorization: `Bearer ${team!.secret}` },
            }),
          );
          assert.equal(principal!.kind, "team_key");
          assert.equal(principal!.userId, undefined);
          await call(
            "queryRows",
            { ...ids, query: {} },
            "rest",
            undefined,
            newId(),
            team!.secret,
          );
          await call("getProfile", {}, "rest", 403, newId(), team!.secret);
          await call(
            "listTeamKeys",
            { orgId },
            "rest",
            403,
            newId(),
            team!.secret,
          );
          await call(
            "listPersonalKeys",
            {},
            "rest",
            403,
            newId(),
            team!.secret,
          );
        }
        await call(
          "createRow",
          {
            ...ids,
            expectedSchemaVersion: 1,
            values: { NAME: "Denied team read" },
          },
          "rest",
          403,
          newId(),
          readTeam!.secret,
        );
        const added = await call(
          "createRow",
          {
            ...ids,
            expectedSchemaVersion: 1,
            values: { NAME: "Team edit allowed" },
          },
          "rest",
          undefined,
          newId(),
          editTeam!.secret,
        );
        await call(
          "deleteRow",
          {
            ...ids,
            rowId: added.row.id,
            expectedSchemaVersion: 1,
            expectedVersion: added.row.version,
          },
          "rest",
          undefined,
          newId(),
          editTeam!.secret,
        );
        await call(
          "createDatabase",
          { orgId, name: "Team edit can create" },
          "rest",
          201,
          newId(),
          editTeam!.secret,
        );
        const organisation = await call("getOrganisation", { orgId });
        await call(
          "updateOrganisation",
          { orgId, name: organisation.name },
          "rest",
          undefined,
          newId(),
          adminTeam!.secret,
        );
        for (const team of [readTeam!, editTeam!, adminTeam!]) {
          const client = new Client({ name: "Team key fixture", version: "1" });
          try {
            await client.connect(
              new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
                requestInit: {
                  headers: { Authorization: `Bearer ${team.secret}` },
                },
              }),
            );
            assert.notEqual(
              (
                await client.callTool({
                  name: "rootset_query_rows",
                  arguments: { ...ids, query: {} },
                })
              ).isError,
              true,
            );
            if (team === editTeam) {
              const added = await client.callTool({
                name: "rootset_create_row",
                arguments: {
                  ...ids,
                  expectedSchemaVersion: 1,
                  values: { NAME: "Team MCP write" },
                  idempotencyKey: newId(),
                },
              });
              assert.notEqual(added.isError, true);
              const row = getOperation("createRow").outputSchema.parse(
                added.structuredContent,
              ) as { row: { id: string; version: string } };
              assert.notEqual(
                (
                  await client.callTool({
                    name: "rootset_delete_row",
                    arguments: {
                      ...ids,
                      rowId: row.row.id,
                      expectedSchemaVersion: 1,
                      expectedVersion: row.row.version,
                      idempotencyKey: newId(),
                    },
                  })
                ).isError,
                true,
              );
            }
            if (team === adminTeam) {
              assert.notEqual(
                (
                  await client.callTool({
                    name: "rootset_update_organisation",
                    arguments: {
                      orgId,
                      name: organisation.name,
                      idempotencyKey: newId(),
                    },
                  })
                ).isError,
                true,
              );
              continue;
            }
            const deleteDatabase = () =>
              client.callTool({
                name: "rootset_delete_database",
                arguments: { orgId, databaseId, idempotencyKey: newId() },
              });
            if (team === readTeam)
              await assert.rejects(
                deleteDatabase,
                (error) =>
                  error instanceof StreamableHTTPError && error.code === 403,
              );
            else {
              const denied = await deleteDatabase();
              assert.equal(denied.isError, true);
              assert.equal(
                (denied.structuredContent as { error: { code: string } }).error
                  .code,
                "FORBIDDEN",
              );
            }
            if (team === readTeam)
              await assert.rejects(
                () =>
                  client.callTool({
                    name: "rootset_create_row",
                    arguments: {
                      ...ids,
                      expectedSchemaVersion: 1,
                      values: { NAME: "Denied MCP team read" },
                    },
                  }),
                (error) =>
                  error instanceof StreamableHTTPError && error.code === 403,
              );
          } finally {
            await client.close();
          }
        }
        const exported = await call(
          "exportRows",
          { ...ids, format: "jsonl" },
          "rest",
          undefined,
          newId(),
          readTeam!.secret,
        );
        let job = await call(
          "getJob",
          { orgId, id: exported.jobId },
          "rest",
          undefined,
          newId(),
          readTeam!.secret,
        );
        for (
          let attempt = 0;
          attempt < 10 && ["queued", "running"].includes(job.state);
          attempt++
        ) {
          await runtime!.jobs.runOnce(orgId);
          job = await call(
            "getJob",
            { orgId, id: exported.jobId },
            "rest",
            undefined,
            newId(),
            readTeam!.secret,
          );
        }
        assert.equal(job.state, "succeeded", JSON.stringify(job.error ?? {}));
        const artifact = await call(
          "getArtifact",
          { orgId, id: job.result.artifactId },
          "rest",
          undefined,
          newId(),
          readTeam!.secret,
        );
        assert.equal(
          (
            await request(
              new URL(artifact.downloadUrl).pathname,
              "GET",
              undefined,
              { token: readTeam!.secret },
            )
          ).status,
          200,
        );
        const listed = await call("listTeamKeys", { orgId });
        assert.equal(
          listed.data.filter((key: { scope: string }) => key.scope === "team")
            .length,
          3,
        );
        assert.equal(
          (await call("listPersonalKeys", {})).data.some(
            (key: { id: string }) => key.id === readTeam!.key.id,
          ),
          false,
        );
        // A different administrator can rotate and revoke keys after the creator leaves.
        const rotationId = newId();
        const rotated = await call(
          "rotateTeamKey",
          { orgId, id: readTeam!.key.id },
          "browser",
          undefined,
          rotationId,
        );
        assert.equal(rotated.key.scope, "team");
        assert.equal(rotated.key.access, "read");
        assert.equal(rotated.key.includeAdmin, false);
        assert.equal(rotated.key.expiresAt, readTeam!.key.expiresAt);
        const replay = await call(
          "rotateTeamKey",
          { orgId, id: readTeam!.key.id },
          "browser",
          undefined,
          rotationId,
        );
        assert.equal(replay.replayed, true);
        assert.equal(replay.secret, undefined);
        await call(
          "queryRows",
          { ...ids, query: {} },
          "rest",
          401,
          newId(),
          readTeam!.secret,
        );
        await call("revokePersonalKey", { id: rotated.key.id }, "browser", 404);
        await call("revokeTeamKey", { orgId, id: key.key.id }, "browser", 404);
        await call("revokeTeamKey", { orgId, id: rotated.key.id });
        await call(
          "queryRows",
          { ...ids, query: {} },
          "rest",
          401,
          newId(),
          rotated.secret,
        );
        await db.owner.query(
          `UPDATE rootset_control.api_keys SET expires_at=now()-interval '1 second' WHERE id=$1`,
          [editTeam!.key.id],
        );
        await call(
          "queryRows",
          { ...ids, query: {} },
          "rest",
          401,
          newId(),
          editTeam!.secret,
        );
        await call("revokeTeamKey", { orgId, id: adminTeam!.key.id });
      },
    );
    const editedRow = await call(
      "createRow",
      { ...ids, expectedSchemaVersion: 1, values: { NAME: "Edit allowed" } },
      "rest",
      undefined,
      newId(),
      editKey.secret,
    );
    await call(
      "deleteRow",
      {
        ...ids,
        rowId: editedRow.row.id,
        expectedSchemaVersion: 1,
        expectedVersion: editedRow.row.version,
      },
      "rest",
      undefined,
      newId(),
      editKey.secret,
    );
    await call(
      "createPersonalKey",
      {
        orgId,
        name: "Read cannot delegate",
        access: "edit",
        includeAdmin: true,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      "rest",
      403,
      newId(),
      readKey.secret,
    );
    for (const [token, edit] of [
      [readKey.secret, false],
      [editKey.secret, true],
    ] as const) {
      const keyMcp = new Client({
        name: "Key permissions fixture",
        version: "1",
      });
      try {
        await keyMcp.connect(
          new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        const read = await keyMcp.callTool({
          name: "rootset_query_rows",
          arguments: { ...ids, query: {} },
        });
        assert.notEqual(read.isError, true);
        if (!edit)
          await assert.rejects(
            () =>
              keyMcp.callTool({
                name: "rootset_update_row",
                arguments: {
                  ...ids,
                  rowId,
                  expectedSchemaVersion: 1,
                  expectedVersion: "1",
                  values: { NAME: "Denied" },
                  idempotencyKey: newId(),
                },
              }),
            (error) =>
              error instanceof StreamableHTTPError && error.code === 403,
          );
        if (edit) {
          assert.notEqual(
            (
              await keyMcp.callTool({
                name: "rootset_create_database",
                arguments: {
                  orgId,
                  name: "MCP edit allowed",
                  idempotencyKey: newId(),
                },
              })
            ).isError,
            true,
          );
        }
        const deleteDatabase = () =>
          keyMcp.callTool({
            name: "rootset_delete_database",
            arguments: { orgId, databaseId, idempotencyKey: newId() },
          });
        if (!edit)
          await assert.rejects(
            deleteDatabase,
            (error) =>
              error instanceof StreamableHTTPError && error.code === 403,
          );
        else {
          const denied = await deleteDatabase();
          assert.equal(denied.isError, true);
          assert.equal(
            (denied.structuredContent as { error: { code: string } }).error
              .code,
            "FORBIDDEN",
          );
        }
      } finally {
        await keyMcp.close();
      }
    }
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
    const issueMcpGrant = async (scopes: string[]) => {
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
      "profile:manage",
      "rows:read",
      "rows:write",
      "history:read",
      "tables:read",
      "databases:read",
      "keys:manage",
      "exports:read",
      "jobs:read",
      "schema:manage",
    ]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      }),
    );
    const publishedTools = (await client.listTools()).tools;
    assert.equal(publishedTools.length, operations.length);
    for (const name of [
      "rootset_list_backups",
      "rootset_get_backup",
      "rootset_create_backup",
      "rootset_delete_backup",
      "rootset_preview_restore",
      "rootset_restore_backup",
      "rootset_list_notifications",
      "rootset_mark_all_notifications_read",
    ])
      assert.equal(
        publishedTools.some((tool) => tool.name === name),
        false,
      );
    assert(publishedTools.some((tool) => tool.name === "rootset_create_row"));
    for (const surface of ["/v1", "/api/internal/v1"])
      assert.equal(
        (
          await request(
            `${surface}/orgs/${orgId}/databases/${databaseId}/backups`,
            "GET",
          )
        ).status,
        404,
      );
    await t.test(
      "API-08 MCP genuine issued OAuth returns typed retryable dependency when the bounded work pool is occupied; readiness and liveness survive",
      async () => {
        const dependencyEventStart = dependencyEvents.length;
        const workConnections = await Promise.all(
          Array.from({ length: 10 }, () => runtime!.pool.connect()),
        );
        try {
          assert.equal((await request("/health/live")).status, 200);
          assert.equal(
            typeof (await runtime!.getReadiness()).healthy,
            "boolean",
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
            dependencyEvents
              .slice(dependencyEventStart)
              .filter((operation) => operation === "queryRows").length >= 1,
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
        access: "edit",
        includeAdmin: true,
        expiresAt: "2030-01-01T00:00:00.000Z",
        orgId,
        name: "Control replay verification",
      }),
      journalTokens = await issueMcpGrant([
        "members:manage",
        "keys:manage",
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
    };
    const journalResults: Record<string, Record<string, unknown>> = {};
    for (const mode of ["rest", "mcp"] as const) {
      journalResults[mode] = {};
      for (const [operationId, input] of Object.entries(journalInputs)) {
        const idempotencyKey = `runtime-shared-journal-${operationId}`;
        const executedInput: Record<string, unknown> = input;
        const [first, concurrent] = await Promise.all([
          journalCall(mode, operationId, executedInput, idempotencyKey),
          journalCall(mode, operationId, executedInput, idempotencyKey),
        ]);
        assert.deepEqual(
          concurrent,
          first,
          `${mode} ${operationId} concurrent publication`,
        );
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
        journalResults[mode]![operationId] = first;
        const changed = { ...input, role: "member" };
        await journalCall(
          mode,
          operationId,
          changed,
          idempotencyKey,
          "IDEMPOTENCY_CONFLICT",
        );
      }
    }
    const restInvitation = journalResults.rest!.inviteMember as { id: string },
      mcpInvitation = journalResults.mcp!.inviteMember as { id: string };
    assert.notEqual(
      restInvitation.id,
      mcpInvitation.id,
      "replay binding isolates credentials",
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
    const recorded = (
      await db.owner.query(
        "SELECT principal_binding,key_digest,input_digest,outcome FROM rootset_control.control_mutation_replays WHERE org_id=$1 AND operation_id=ANY($2::text[])",
        [orgId, Object.keys(journalInputs)],
      )
    ).rows;
    assert.equal(recorded.length, Object.keys(journalInputs).length * 2);
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
    assert.equal(
      (
        await request(
          `/v1/orgs/${orgId}/artifacts/${rowId}/upload`,
          "PUT",
          undefined,
        )
      ).status,
      404,
    );
    const directKeyInput = {
      access: "edit",
      includeAdmin: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
      orgId,
      name: "Delegated direct key",
      idempotencyKey: "runtime-direct-key",
    };
    const directKey = await client.callTool({
      name: "rootset_create_personal_key",
      arguments: directKeyInput,
    });
    assert.notEqual(directKey.isError, true);
    const issued = directKey.structuredContent as {
      key: { id: string };
      secret?: string;
    };
    assert.equal(typeof issued.secret, "string");
    const directReplay = await client.callTool({
      name: "rootset_create_personal_key",
      arguments: directKeyInput,
    });
    assert.notEqual(directReplay.isError, true);
    const directKeyReplay = directReplay.structuredContent as {
      key: { id: string };
      secret?: string;
    };
    assert.equal(directKeyReplay.key.id, issued.key.id);
    assert.equal(directKeyReplay.secret, undefined);
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
      (field: { name: string }) => field.name === "NAME",
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
    const readExportGrant = await issueMcpGrant([
      "rows:read",
      "tables:read",
      "exports:read",
    ]);
    const readExportDownload = await request(artifactPath, "GET", undefined, {
      token: readExportGrant.access_token,
    });
    assert.equal(readExportDownload.status, 200);
    assert.equal(await readExportDownload.text(), exportText);
    const missingExportGrant = await issueMcpGrant([
      "rows:read",
      "tables:read",
    ]);
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
    const personalDownload = await request(
      new URL(exportArtifact.downloadUrl).pathname,
      "GET",
      undefined,
      { token: readKey.secret },
    );
    assert.equal(personalDownload.status, 200);
    assert.equal(await personalDownload.text(), exportText);
    const fieldStarted = await client.callTool({
      name: "rootset_apply_schema_change",
      arguments: {
        ...ids,
        expectedSchemaVersion: 1,
        change: {
          kind: "add_field",
          field: {
            type: "text",
            name: "NOTES",
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
    assert.equal(journal.change.field.name, "NOTES");
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
        (field: { name: string }) => field.name === "NOTES",
      ).charLimit,
      240,
    );
    const staleSchema = await call(
      "createField",
      {
        ...ids,
        expectedSchemaVersion: 1,
        field: { type: "text", name: "STALE" },
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
    assert.equal(usage.databases, 4);
    assert.equal(usage.tables, 1);
    assert.equal(usage.rows, 1);
    assert(usage.dataBytes > 0);
    assert(usage.indexBytes > 0);
    assert(usage.historyBytes > 0);
    assert(usage.artifactBytes > 0);
    assert.equal(Object.hasOwn(usage, "storageQuotaBytes"), false);
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
            name: "PREVIEW_ONLY",
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
        (field: { name: string }) => field.name === "PREVIEW_ONLY",
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
            name: "SORT",
            charLimit: 65536,
          },
          { type: "integer", name: "VALUE" },
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
    const readGrant = await issueMcpGrant(["rows:read", "tables:read"]);
    await readOnlyClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${readGrant.access_token}` },
        },
      }),
    );
    for (const operationId of []) {
      const operation = getOperation(operationId);
      await assert.rejects(
        readOnlyClient.callTool({
          name: operation.toolName,
          arguments: operation.idempotencyRequired
            ? { idempotencyKey: newId() }
            : {},
        }),
        (error) => error instanceof StreamableHTTPError && error.code === 403,
      );
    }
    const readMutation = await readOnlyClient.callTool({
      name: "rootset_get_mutation",
      arguments: { orgId, id: updated.mutationId },
    });
    assert.notEqual(readMutation.isError, true);
    assert.equal(
      (readMutation.structuredContent as { mutationId: string }).mutationId,
      updated.mutationId,
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
      { token: readGrant.access_token, key: "runtime-read-only-reorder" },
    );
    assert.equal(reorderDenied.status, 401);
    const valueField = wideTable.fields.find(
        (field: { name: string }) => field.name === "VALUE",
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
      fields: [{ type: "text", name: "NAME" }],
    });
    const peerGrant = await issueMcpGrant([
      "rows:read",
      "tables:read",
      "exports:read",
    ]);
    assert.equal(
      (
        await request(artifactPath, "GET", undefined, {
          token: peerGrant.access_token,
        })
      ).status,
      200,
    );
    const hiddenJournal = await call(
      "getSchemaOperation",
      { ...ids, tableId: secondTable.table.id, id: fieldAccepted.jobId },
      "rest",
      404,
    );
    assert.equal(hiddenJournal.error.code, "RESOURCE_NOT_FOUND");
    const scoped = await call("createPersonalKey", {
      access: "edit",
      includeAdmin: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
      orgId,
      name: "Installation role access",
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
      200,
    );
    const scopedTables = await request(
      `/v1/orgs/${orgId}/databases/${databaseId}/tables`,
      "GET",
      undefined,
      { token: scoped.secret },
    );
    assert.equal(scopedTables.status, 200);
    assert.deepEqual(
      (await scopedTables.json()).data
        .map((table: { id: string }) => table.id)
        .sort(),
      [tableId, wideTable.table.id, secondTable.table.id].sort(),
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
      `/v1/auth/invitations/${invitationToken}/verify`,
      "POST",
      {},
      { headers: { Origin: baseURL } },
    );
    assert.equal(onboarding.status, 200);
    const viewerVerificationEnvelope = (
      await db.owner.query(
        "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template=$1 AND to_address=$2 ORDER BY created_at DESC LIMIT 1",
        ["invitation-verification", invitedEmail],
      )
    ).rows[0];
    assert(viewerVerificationEnvelope);
    const viewerVerification = decryptProtected<{ details: string }>(
      viewerVerificationEnvelope.payload_encrypted,
      config,
    );
    const proofResponse = await request(
      `/v1/auth/invitations/${invitationToken}/code`,
      "POST",
      {
        name: "Rootset verification viewer",
        code: viewerVerification.details.match(/\d{6}/)![0],
      },
      { headers: { Origin: baseURL } },
    );
    assert.equal(proofResponse.status, 200);
    const { setupToken } = await proofResponse.json();
    const viewerSignup = await request(
      `/v1/auth/invitations/${invitationToken}/signup`,
      "POST",
      { setupToken, password: "Rootset viewer verification password 2026!" },
      { headers: { Origin: baseURL } },
    );
    assert.equal(viewerSignup.status, 200, await viewerSignup.clone().text());
    cookie = viewerSignup.headers
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
      access: "read",
      includeAdmin: false,
      expiresAt: "2030-01-01T00:00:00.000Z",
      orgId,
      name: "Viewer read key",
    });
    assert(viewerKey.secret);
    for (const includeAdmin of [false, true]) {
      await call(
        "createPersonalKey",
        {
          orgId,
          name: "Viewer cannot elevate",
          access: "edit",
          includeAdmin,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        "browser",
        403,
      );
    }

    await call(
      "createPersonalKey",
      {
        access: "edit",
        includeAdmin: true,
        expiresAt: "2030-01-01T00:00:00.000Z",
        orgId,
        name: "Forbidden viewer write key",
        scopes: ["rows:write"],
      },
      "browser",
      422,
    );
    const viewerCookie = cookie;
    cookie = ownerCookie;
    let viewerMember = (
      await db.owner.query(
        "SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, viewerContext.principal.userId],
      )
    ).rows[0];
    await call("updateMember", {
      orgId,
      id: viewerMember.id,
      role: "admin",
      expectedVersion: String(viewerMember.version),
    });
    cookie = viewerCookie;
    const scopeKey = await call("createPersonalKey", {
        access: "edit",
        includeAdmin: true,
        expiresAt: "2030-01-01T00:00:00.000Z",
        orgId,
        name: "Current target authority replay verification",
      }),
      scopeTokens = await issueMcpGrant(["tables:read", "tables:manage"]),
      currentSchema = await call("getTableSchema", ids),
      targetInput = {
        ...ids,
        expectedSchemaVersion: currentSchema.table.schemaVersion,
      };
    await scopeClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${scopeTokens.access_token}` },
        },
      }),
    );
    cookie = ownerCookie;
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
    await call("listFields", ids, "rest", undefined, newId(), scopeKey.secret);
    assert.equal(
      (await scopeClient.listTools()).tools.length,
      operations.length,
    );
    const targetRestDenied = await call(
      "deleteTable",
      targetInput,
      "rest",
      403,
      "runtime-target-scope-rest-action",
      scopeKey.secret,
    );
    assert.equal(targetRestDenied.error.code, "FORBIDDEN");
    await assert.rejects(
      () =>
        scopeClient.callTool({
          name: getOperation("deleteTable").toolName,
          arguments: {
            ...targetInput,
            idempotencyKey: "runtime-target-scope-mcp-action",
          },
        }),
      (error) => error instanceof StreamableHTTPError && error.code === 403,
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
    assert.equal(restrictedWindow.status, 200);
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
      200,
    );
    const currentViewerMember = (
      await db.owner.query(
        "SELECT version::text version FROM rootset_control.memberships WHERE id=$1",
        [viewerMember.id],
      )
    ).rows[0];
    await call("removeMember", {
      orgId,
      id: viewerMember.id,
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
      {
        ...keyRequest,
        name: "Secret replay check",
      },
      "browser",
      undefined,
      "runtime-secret-once-001",
    );
    assert(keyReplay.secret);
    const redactedReplay = await call(
      "createPersonalKey",
      {
        ...keyRequest,
        name: "Secret replay check",
      },
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
      "DELETE FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
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
