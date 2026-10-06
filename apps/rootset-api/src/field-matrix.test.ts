import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRuntime } from "@rootset/core/runtime";
import { loadConfig } from "@rootset/core/config";
import {
  getOperation,
  newId,
  type JsonValue,
  type FieldDefinition,
} from "@rootset/contracts";
import { decryptProtected } from "../../../packages/email/src/index.js";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createRuntimeApp } from "./runtime-app.js";
import { MCP_PROTOCOL_VERSION } from "./app.js";
import { fieldCases } from "./field-cases.js";
import { httpServerOptions } from "./http-server.js";

type Values = Record<string, JsonValue>;
type Row = { id: string; version: string; values: Values };
type Result = {
  ok: boolean;
  status: number;
  value: unknown;
  error?: { code: string };
};
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

// FLD-15: each named case below runs unchanged through real REST and delegated OAuth MCP.
// PostgreSQL native columns and trigger history are the independent persistence oracle.
test("FLD-15 actual REST/MCP eight-type create/patch boundary matrix with native PostgreSQL revision and history", async (t) => {
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
  const client = new Client({ name: "Rootset field matrix", version: "1.0.0" });
  let cookie = "",
    restSecret = "",
    oauthToken = "",
    rpcId = 0;
  const browserFetch = (path: string, method = "GET", body?: unknown) =>
    fetch(`${baseURL}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        Origin: baseURL,
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", "Idempotency-Key": newId() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function rest(
    operationId: string,
    input: Record<string, unknown>,
    browser = false,
    rawValues?: string,
  ): Promise<Result> {
    const operation = getOperation(operationId),
      body = { ...input };
    let path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      const value = body[key];
      delete body[key];
      return encodeURIComponent(String(value));
    });
    if (browser) path = path.replace(/^\/v1/, "/api/internal/v1");
    const response = await fetch(`${baseURL}${path}`, {
      method: operation.httpMethod,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": newId(),
        ...(browser
          ? { Cookie: cookie, Origin: baseURL }
          : { Authorization: `Bearer ${restSecret}` }),
      },
      body:
        rawValues === undefined
          ? JSON.stringify(body)
          : JSON.stringify({ ...body, values: "__RAW_VALUES__" }).replace(
              '"__RAW_VALUES__"',
              rawValues,
            ),
    });
    const value = await response.json();
    if (response.ok) operation.outputSchema.parse(value);
    return {
      ok: response.ok,
      status: response.status,
      value,
      error: value.error,
    };
  }
  async function invoke(
    surface: "rest" | "mcp",
    operationId: string,
    input: Record<string, unknown>,
    rawValues?: string,
  ): Promise<Result> {
    if (surface === "rest") return rest(operationId, input, false, rawValues);
    const operation = getOperation(operationId),
      args = { ...input, idempotencyKey: newId() };
    if (rawValues === undefined) {
      const value = await client.callTool({
        name: operation.toolName,
        arguments: args,
      });
      const structured = value.structuredContent as {
        error?: { code: string };
      };
      assert(structured);
      if (!value.isError) operation.outputSchema.parse(structured);
      return {
        ok: !value.isError,
        status: 200,
        value: structured,
        error: structured.error,
      };
    }
    const response = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${oauthToken}`,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: {
          name: operation.toolName,
          arguments: { ...args, values: "__RAW_VALUES__" },
        },
      }).replace('"__RAW_VALUES__"', rawValues),
    });
    const envelope = await response.json();
    if (envelope.error) {
      assert.equal(envelope.error.code, -32700);
      assert(envelope.error.data?.error);
      return {
        ok: false,
        status: response.status,
        value: envelope,
        error: envelope.error.data.error,
      };
    }
    const value = envelope.result.structuredContent;
    if (!envelope.result.isError) operation.outputSchema.parse(value);
    return {
      ok: !envelope.result.isError,
      status: response.status,
      value,
      error: value.error,
    };
  }
  async function must(
    operationId: string,
    input: Record<string, unknown>,
    browser = true,
  ) {
    const result = await rest(operationId, input, browser);
    assert(result.ok, `${operationId}: ${JSON.stringify(result.value)}`);
    return result.value as Record<string, unknown>;
  }
  try {
    const config = {
      ...loadConfig(),
      baseURL,
      port: address.port,
      databaseURL: db.app.options.connectionString!,
      ddlDatabaseURL: db.ddl.options.connectionString!,
      identityDatabaseURL: db.identity.options.connectionString!,
    };
    const clientId = "rootset-field-matrix",
      redirectUri = "https://client.example/field-matrix";
    runtime = await createRuntime(config, {
      oauthClients: [
        {
          client_id: clientId,
          client_name: "Field boundary verification",
          redirect_uris: [redirectUri],
        },
      ],
    });
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
    const email = `fields-${newId().toLowerCase()}@rootset.example`,
      password = "Rootset matrix password 2026!";
    const setup = await browserFetch("/v1/setup", "POST", {
      bootstrapSecret: config.bootstrapSecret,
      name: "Field matrix owner",
      email,
      password,
      organisationName: "Field matrix",
    });
    assert.equal(setup.status, 201);
    const provision = await setup.json();
    const message = (
      await db.owner.query(
        "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='account-verification' ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    const verification = await fetch(
      decryptProtected<{ actionUrl: string }>(message.payload_encrypted, config)
        .actionUrl,
      { redirect: "manual" },
    );
    assert([200, 302].includes(verification.status));
    const login = await browserFetch("/v1/auth/sign-in/email", "POST", {
      email,
      password,
    });
    assert.equal(login.status, 200);
    cookie = login.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const orgId = provision.orgId;
    restSecret = (
      await must("createPersonalKey", {
        orgId,
        name: "Field matrix REST",
      })
    ).secret as string;
    const databaseId = (
      await must("createDatabase", { orgId, name: "Field matrix" })
    ).id as string;
    const verifier = randomBytes(40).toString("base64url"),
      authorize = new URL(`${baseURL}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: `${baseURL}/mcp`,
      scope:
        "rows:read rows:write history:read tables:read databases:read exports:read jobs:read",
      state: "field-matrix",
    }).toString();
    const authorization = await fetch(authorize, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    assert.equal(authorization.status, 302);
    const requestId = new URL(
      authorization.headers.get("location")!,
    ).searchParams.get("requestId")!;
    assert.equal(
      (await browserFetch(`/api/internal/v1/oauth/requests/${requestId}`))
        .status,
      200,
    );
    const consent = await browserFetch(
      `/api/internal/v1/oauth/requests/${requestId}/decision`,
      "POST",
      { approve: true },
    );
    assert.equal(consent.status, 200);
    const callback = new URL((await consent.json()).redirectUri);
    const token = await fetch(`${baseURL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: `${baseURL}/mcp`,
        code: callback.searchParams.get("code")!,
        code_verifier: verifier,
      }),
    });
    assert.equal(token.status, 200);
    oauthToken = (await token.json()).access_token;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${oauthToken}` } },
      }),
    );

    for (const fixture of fieldCases) {
      const fields = [
        {
          type: fixture.type,
          name: "TEST",
          ...fixture.options,
        },
        {
          type: fixture.type,
          name: "DEFAULT",
          default: fixture.default,
          ...fixture.options,
        },
        {
          type: fixture.type,
          name: "REQUIRED",
          required: true,
          ...fixture.options,
        },
        {
          type: fixture.type,
          name: "REQUIRED_DEFAULT",
          required: true,
          default: fixture.requiredDefault,
          ...fixture.options,
        },
        ...(fixture.bounded
          ? [
              {
                type: fixture.type,
                name: "BOUNDED",
                min: fixture.bounded.min,
                max: fixture.bounded.max,
                default: fixture.bounded.default,
              },
            ]
          : []),
      ];
      const schema = await must("createTable", {
        orgId,
        databaseId,
        name: fixture.type,
        fields,
      });
      const tableId = (schema.table as { id: string }).id,
        definitions = schema.fields as FieldDefinition[];
      const identifiers = (
        await db.owner.query(
          "SELECT t.physical_name,d.schema_name FROM rootset_control.tables t JOIN rootset_control.databases d ON d.id=t.database_id WHERE t.id=$1",
          [tableId],
        )
      ).rows[0];
      const physical = `${quote(identifiers.schema_name)}.${quote(identifiers.physical_name)}`;
      const native = definitions
        .map((field) => {
          const column = quote(`f_${field.id.toLowerCase()}`);
          const expression =
            field.type === "date"
              ? `to_char(${column},'YYYY-MM-DD')`
              : field.type === "time"
                ? `to_char('2000-01-01'::date + ${column},'HH24:MI:SS.MS')||'Z'`
                : field.type === "date-time"
                  ? `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
                  : column;
          return `'${field.name}',to_jsonb(${expression})`;
        })
        .join(",");
      const types = (
        await db.owner.query(
          `SELECT ${definitions.map((field) => `pg_typeof(${quote(`f_${field.id.toLowerCase()}`)})::text AS ${quote(field.name)}`).join(",")} FROM ${physical} LIMIT 0`,
        )
      ).fields;
      assert.equal(types.length, definitions.length);
      const expectedNativeType = {
        text: "text",
        integer: "bigint",
        float: "double precision",
        boolean: "boolean",
        date: "date",
        time: "time(3) without time zone",
        "date-time": "timestamp(3) with time zone",
        json: "jsonb",
      }[fixture.type];
      const nativeTypes = await db.owner.query(
        "SELECT format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attname LIKE 'f_%' ORDER BY a.attnum",
        [physical],
      );
      assert.deepEqual(
        nativeTypes.rows.map((row) => row.type),
        definitions.map(() => expectedNativeType),
      );
      const ids = { orgId, databaseId, tableId, expectedSchemaVersion: 1 };
      const baselineValues: Values = {
        TEST: fixture.baseline,
        REQUIRED: fixture.baseline,
      };
      const baselineExpected: Values = {
        TEST: fixture.canonical,
        DEFAULT: fixture.defaultCanonical,
        REQUIRED: fixture.canonical,
        REQUIRED_DEFAULT: fixture.requiredDefaultCanonical,
        ...(fixture.bounded ? { BOUNDED: fixture.bounded.canonical } : {}),
      };
      async function counters() {
        return (
          await db.owner.query(
            `SELECT (SELECT count(*)::int FROM ${physical}) AS rows,(SELECT count(*)::int FROM rootset_control.cell_changes WHERE table_id=$1) AS cells,(SELECT count(*)::int FROM rootset_control.row_events WHERE table_id=$1) AS events,(SELECT count(*)::int FROM rootset_control.mutations WHERE table_id=$1) AS mutations`,
            [tableId],
          )
        ).rows[0];
      }
      async function assertStored(row: Row, expected: Values, before?: Values) {
        const changed = before
          ? Object.keys(expected).filter(
              (key) => !isDeepStrictEqual(before[key], expected[key]),
            )
          : [];
        const revision = changed.length ? "2" : "1";
        assert.equal(row.version, revision);
        assert.deepEqual(row.values, expected);
        const stored = (
          await db.owner.query(
            `SELECT row_version::text AS version,jsonb_build_object(${native}) AS values FROM ${physical} WHERE row_id=$1`,
            [row.id],
          )
        ).rows[0];
        assert.deepEqual(stored, { version: revision, values: expected });
        const history = (
          await db.owner.query(
            "SELECT field_id,old_value,new_value,old_version::text,new_version::text,operation FROM rootset_control.cell_changes WHERE table_id=$1 AND row_id=$2 ORDER BY id",
            [tableId, row.id],
          )
        ).rows;
        const initial = before ?? expected;
        const expectedHistory: {
          field_id: string;
          old_value: JsonValue | undefined;
          new_value: JsonValue | undefined;
          old_version: string | null;
          new_version: string;
          operation: string;
        }[] = definitions
          .filter((field) => initial[field.name] !== null)
          .map((field) => ({
            field_id: field.id,
            old_value: null,
            new_value: initial[field.name],
            old_version: null,
            new_version: "1",
            operation: "insert",
          }));
        expectedHistory.push(
          ...definitions
            .filter((field) => changed.includes(field.name))
            .map((field) => ({
              field_id: field.id,
              old_value: before![field.name],
              new_value: expected[field.name],
              old_version: "1",
              new_version: "2",
              operation: "update",
            })),
        );
        const historyOrder = (
          a: (typeof expectedHistory)[number],
          b: (typeof expectedHistory)[number],
        ) =>
          a.new_version.localeCompare(b.new_version) ||
          a.field_id.localeCompare(b.field_id);
        assert.deepEqual(
          history.sort(historyOrder),
          expectedHistory.sort(historyOrder),
        );
        const events = (
          await db.owner.query(
            "SELECT operation,old_version::text,new_version::text FROM rootset_control.row_events WHERE table_id=$1 AND row_id=$2 ORDER BY id",
            [tableId, row.id],
          )
        ).rows;
        assert.deepEqual(events, [
          { operation: "insert", old_version: null, new_version: "1" },
          ...(changed.length
            ? [{ operation: "update", old_version: "1", new_version: "2" }]
            : []),
        ]);
      }
      for (const surface of ["rest", "mcp"] as const) {
        const common = [
          {
            name: "baseline-defaults-and-required-default",
            create: baselineValues,
            createExpected: baselineExpected,
            patch: { TEST: fixture.baseline },
            patchExpected: baselineExpected,
          },
          {
            name: "optional-explicit-null",
            create: { REQUIRED: fixture.baseline, TEST: null },
            createExpected: { ...baselineExpected, TEST: null },
            patch: { TEST: null },
            patchExpected: { ...baselineExpected, TEST: null },
          },
          {
            name: "optional-omitted-create-null-patch-preserves",
            create: { REQUIRED: fixture.baseline },
            createExpected: { ...baselineExpected, TEST: null },
            patch: {},
            patchExpected: baselineExpected,
          },
          {
            name: "explicit-null-overrides-default",
            create: { REQUIRED: fixture.baseline, DEFAULT: null },
            createExpected: { ...baselineExpected, TEST: null, DEFAULT: null },
            patch: { DEFAULT: null },
            patchExpected: { ...baselineExpected, DEFAULT: null },
          },
          {
            name: "required-null-rejected",
            create: { REQUIRED: null },
            createReject: true,
            patch: { REQUIRED: null },
            patchReject: true,
          },
          {
            name: "required-omitted-create-rejected-patch-preserves",
            create: {},
            createReject: true,
            patch: {},
            patchExpected: baselineExpected,
          },
          {
            name: "required-default-explicit-null-rejected",
            create: { REQUIRED: fixture.baseline, REQUIRED_DEFAULT: null },
            createReject: true,
            patch: { REQUIRED_DEFAULT: null },
            patchReject: true,
          },
        ];
        const cases = [
          ...common,
          ...fixture.cases.map((entry) => {
            const field = entry.field ?? "TEST",
              values = { ...baselineValues, [field]: entry.value ?? null };
            const raw =
              entry.raw === undefined
                ? undefined
                : JSON.stringify({
                    ...values,
                    [field]: "__RAW_CELL__",
                  }).replace('"__RAW_CELL__"', entry.raw);
            const rawPatch =
              entry.raw === undefined
                ? undefined
                : JSON.stringify({ [field]: "__RAW_CELL__" }).replace(
                    '"__RAW_CELL__"',
                    entry.raw,
                  );
            return {
              name: entry.name,
              create: values,
              createExpected: {
                ...baselineExpected,
                [field]: entry.canonical ?? entry.value ?? null,
              },
              createReject: entry.reject,
              patch: { [field]: entry.value ?? null },
              patchExpected: {
                ...baselineExpected,
                [field]: entry.canonical ?? entry.value ?? null,
              },
              patchReject: entry.reject,
              raw,
              rawPatch,
              parseError: entry.parseError,
            };
          }),
        ];
        for (const entry of cases) {
          await t.test(`${surface}/${fixture.type}/${entry.name}`, async () => {
            const before = await counters();
            const create = await invoke(
              surface,
              "createRow",
              { ...ids, values: entry.create },
              "raw" in entry ? entry.raw : undefined,
            );
            if (entry.createReject) {
              assert.equal(
                create.ok,
                false,
                `create accepted: ${JSON.stringify(create.value)}`,
              );
              assert.equal(create.error?.code, "VALIDATION_FAILED");
              assert.equal(
                create.status,
                surface === "rest"
                  ? "parseError" in entry && entry.parseError
                    ? 400
                    : 422
                  : "parseError" in entry && entry.parseError
                    ? 400
                    : 200,
              );
              assert.deepEqual(await counters(), before);
            } else {
              assert(
                create.ok,
                `create rejected: ${JSON.stringify(create.value)}`,
              );
              assert("createExpected" in entry && entry.createExpected);
              await assertStored(
                (create.value as { row: Row }).row,
                entry.createExpected,
              );
            }
            const seed = await invoke(surface, "createRow", {
              ...ids,
              values: baselineValues,
            });
            assert(seed.ok, JSON.stringify(seed.value));
            const row = (seed.value as { row: Row }).row;
            await assertStored(row, baselineExpected);
            const patchBefore = await counters();
            const patch = await invoke(
              surface,
              "updateRow",
              {
                ...ids,
                rowId: row.id,
                expectedVersion: "1",
                values: entry.patch,
              },
              "rawPatch" in entry ? entry.rawPatch : undefined,
            );
            if (entry.patchReject) {
              assert.equal(
                patch.ok,
                false,
                `patch accepted: ${JSON.stringify(patch.value)}`,
              );
              assert.equal(patch.error?.code, "VALIDATION_FAILED");
              assert.deepEqual(await counters(), patchBefore);
              await assertStored(row, baselineExpected);
            } else {
              assert(
                patch.ok,
                `patch rejected: ${JSON.stringify(patch.value)}`,
              );
              assert("patchExpected" in entry && entry.patchExpected);
              await assertStored(
                (patch.value as { row: Row }).row,
                entry.patchExpected,
                baselineExpected,
              );
            }
          });
        }
        await t.test(
          `${surface}/${fixture.type}/omitted-patch-does-not-reapply-defaults`,
          async () => {
            const result = await invoke(surface, "createRow", {
              ...ids,
              values: { ...baselineValues, DEFAULT: null },
            });
            assert(result.ok);
            const row = (result.value as { row: Row }).row,
              expected = { ...baselineExpected, DEFAULT: null };
            const patch = await invoke(surface, "updateRow", {
              ...ids,
              rowId: row.id,
              expectedVersion: "1",
              values: {},
            });
            assert(patch.ok, JSON.stringify(patch.value));
            await assertStored(
              (patch.value as { row: Row }).row,
              expected,
              expected,
            );
          },
        );
        if (fixture.type === "json")
          await t.test(
            `${surface}/json/array-order-change-increments-revision-and-history`,
            async () => {
              const initial = { ...baselineExpected, TEST: [1, 2] };
              const create = await invoke(surface, "createRow", {
                ...ids,
                values: { ...baselineValues, TEST: [1, 2] },
              });
              assert(create.ok);
              const row = (create.value as { row: Row }).row;
              const patch = await invoke(surface, "updateRow", {
                ...ids,
                rowId: row.id,
                expectedVersion: "1",
                values: { TEST: [2, 1] },
              });
              assert(patch.ok, JSON.stringify(patch.value));
              await assertStored(
                (patch.value as { row: Row }).row,
                { ...initial, TEST: [2, 1] },
                initial,
              );
            },
          );
        await t.test(
          `${surface}/${fixture.type}/canonical-equivalence-preserves-revision-and-history`,
          async () => {
            const seed = await invoke(surface, "createRow", {
              ...ids,
              values: baselineValues,
            });
            assert(seed.ok);
            const row = (seed.value as { row: Row }).row;
            const equivalent: JsonValue =
              fixture.type === "time"
                ? "12:00:00.000Z"
                : fixture.type === "date-time"
                  ? "2024-02-29T12:00:00.000Z"
                  : fixture.baseline;
            const rawValues =
              fixture.type === "json"
                ? '{"TEST":{"b":2.0,"a":1}}'
                : fixture.type === "integer"
                  ? '{"TEST":-0}'
                  : undefined;
            const patch = await invoke(
              surface,
              "updateRow",
              {
                ...ids,
                rowId: row.id,
                expectedVersion: "1",
                values: { TEST: equivalent },
              },
              rawValues,
            );
            assert(patch.ok, JSON.stringify(patch.value));
            await assertStored(
              (patch.value as { row: Row }).row,
              baselineExpected,
              baselineExpected,
            );
          },
        );
        if (fixture.type === "json")
          await t.test(
            `${surface}/json/depth-32-round-trips-through-durable-export-and-authenticated-download`,
            async () => {
              const started = await invoke(surface, "exportRows", {
                orgId,
                databaseId,
                tableId,
                format: "jsonl",
              });
              assert(started.ok, JSON.stringify(started.value));
              const jobId = (started.value as { jobId: string }).jobId;
              let job:
                | {
                    state: string;
                    result?: { artifactId: string; rowCount: number };
                    error?: unknown;
                  }
                | undefined;
              for (let attempt = 0; attempt < 10; attempt++) {
                await runtime!.jobs.runOnce(orgId);
                const state = await invoke("mcp", "getJob", {
                  orgId,
                  id: jobId,
                });
                assert(state.ok, JSON.stringify(state.value));
                job = state.value as typeof job;
                if (job?.state === "succeeded" || job?.state === "failed")
                  break;
              }
              assert.equal(job?.state, "succeeded", JSON.stringify(job?.error));
              assert(job?.result);
              assert.equal(job.result.rowCount, (await counters()).rows);
              const access = await invoke("mcp", "getArtifact", {
                orgId,
                id: job.result.artifactId,
              });
              assert(access.ok, JSON.stringify(access.value));
              const artifact = access.value as {
                downloadUrl: string;
                checksum: string;
              };
              const download = await fetch(artifact.downloadUrl, {
                headers: { Authorization: `Bearer ${restSecret}` },
              });
              assert.equal(download.status, 200);
              const body = await download.text();
              assert.equal(
                createHash("sha256").update(body).digest("hex"),
                artifact.checksum,
              );
              const records = body
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Values);
              const deep = fixture.cases.find(
                (entry) => entry.name === "depth-32",
              )!.canonical;
              assert(
                records.some((record) => isDeepStrictEqual(record.TEST, deep)),
              );
              const prototype = fixture.cases.find(
                (entry) =>
                  entry.name === "prototype-like-keys-are-own-json-data",
              )!.canonical;
              assert(
                records.some((record) =>
                  isDeepStrictEqual(record.TEST, prototype),
                ),
              );
              assert.equal(Object.hasOwn(Object.prototype, "marker"), false);
            },
          );
      }
    }
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime?.close();
    await db.close();
  }
});
