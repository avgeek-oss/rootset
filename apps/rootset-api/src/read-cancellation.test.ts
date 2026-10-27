import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTestDatabaseURLs } from "./native-test-database.js";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";
import { serve } from "@hono/node-server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createPool,
  migrate,
  withOrgRead,
  ReadCancelledError,
  type Pool,
  type PoolClient,
} from "@rootset/database";
import { RootsetCore, readSignal, type CoreOptions } from "@rootset/core";
import {
  newId,
  RootsetError,
  getOperation,
  type Actor,
} from "@rootset/contracts";
import { TableStorage } from "../../../packages/table-storage/src/index.js";
import { createRuntimeApp } from "./runtime-app.js";
import { mcpOperationSignal } from "./app.js";

const secret = "isolated-cancellation-test-secret-over-thirty-two-characters";
const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error: error as unknown }),
  );
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Controlled source test barrier timed out")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, ms = 2000) {
  const end = performance.now() + ms;
  while (!(await check())) {
    assert(
      performance.now() < end,
      "controlled native barrier did not become ready",
    );
    await pause(20);
  }
}
function cancelled(error: unknown): boolean {
  return (
    error instanceof RootsetError &&
    error.code === "REQUEST_TIMEOUT" &&
    error.status === 408 &&
    error.message === "Client request ended before its table read completed"
  );
}

test(
  "MCP SDK notifications/cancelled aborts the forwarded operation signal while HTTP remains open",
  { timeout: 10000 },
  async () => {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: "cancellation-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    const started = deferred<AbortSignal>(),
      ended = deferred<void>();
    const request = new Request("http://127.0.0.1/mcp");
    server.setRequestHandler(CallToolRequestSchema, async (_message, extra) => {
      const signal = readSignal({
        request,
        signal: mcpOperationSignal(request, extra.signal),
      });
      assert(signal);
      started.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      assert.equal(request.signal.aborted, false);
      assert.equal(extra.signal.aborted, true);
      ended.resolve();
      return { content: [] };
    });
    try {
      await server.connect(transport);
      await client.start();
      await client.send({
        jsonrpc: "2.0",
        id: "owned-read",
        method: "tools/call",
        params: { name: "query_rows", arguments: {} },
      });
      const signal = await bounded(started.promise);
      await client.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "owned-read", reason: "fixture cancellation" },
      });
      await bounded(ended.promise);
      assert.equal(signal.aborted, true);
    } finally {
      await server.close();
      await client.close();
    }
  },
);

test(
  "native cancellation: real application-role reads, HTTP disconnect, races and pool recovery",
  { timeout: 90000 },
  async (t) => {
    // The admitted executor supplies one protected disposable database URL.
    const urls = nativeTestDatabaseURLs(process.env);
    const name = `rootset_cancel_${newId().toLowerCase()}`;
    const admin = createPool(urls[0]!.toString(), 1);
    const pools: Pool[] = [];
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      const [owner, app, ddl, identity] = Array.from({ length: 4 }, () => {
        const url = urls[0]!;
        const target = new URL(url);
        target.pathname = `/${name}`;
        const pool = createPool(target.toString(), 4);
        pools.push(pool);
        return pool;
      });
      assert(owner && app && ddl && identity);
      await migrate(owner);
      assert.equal(
        (await app.query("SHOW statement_timeout")).rows[0].statement_timeout,
        "10s",
      );
      assert.equal(
        (await app.query("SELECT current_user AS role")).rows[0].role,
        (await owner.query("SELECT current_user AS role")).rows[0].role,
      );
      const actor: Actor = {
        id: newId(),
        orgId: newId(),
        kind: "personal_key",
        role: "admin",
        scopes: ["rows:read"],
      };
      await owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Native cancellation fixture')",
        [actor.orgId],
      );
      const base = new TableStorage({
        pool: app,
        ddlPool: ddl,
        cursorSecret: secret,
      });
      const database = await base.createDatabase(actor, {
        name: "Cancellation",
      });
      const table = await base.createTable(actor, database.id, {
        name: "Rows",
        fields: [
          {
            type: "text",
            name: "CODE",
            charLimit: 20,
            order: 0,
          },
        ],
      });
      await base.createRow(
        actor,
        table.id,
        { CODE: "one" },
        { expectedSchemaVersion: table.schemaVersion },
      );
      await base.createRow(
        actor,
        table.id,
        { CODE: "two" },
        { expectedSchemaVersion: table.schemaVersion },
      );
      const path = `"${table.schemaName}"."${table.physicalName}"`;
      type Arm = {
        kind: "sleep" | "race";
        match: RegExp;
        hit: ReturnType<typeof deferred<number>>;
        resume: ReturnType<typeof deferred<void>>;
        errors: Array<{ code: string; message: string }>;
      };
      let armed: Arm | undefined;
      let queryCount = 0;
      let failControl = false;
      const observed = new Proxy(app, {
        get(pool, member) {
          if (member === "options" && failControl) {
            const unavailable = new URL(pool.options.connectionString!);
            unavailable.port = "1";
            return {
              ...pool.options,
              connectionString: unavailable.toString(),
            };
          }
          if (member === "connect")
            return async () => {
              const client = await pool.connect();
              return new Proxy(client, {
                get(c, key) {
                  if (key === "query")
                    return async (sql: string, values?: unknown[]) => {
                      queryCount++;
                      const arm = armed;
                      if (arm && arm.match.test(sql)) {
                        armed = undefined;
                        const pid = Number(
                          (await c.query("SELECT pg_backend_pid() AS pid"))
                            .rows[0].pid,
                        );
                        if (arm.kind === "sleep") {
                          const native = c.query(
                            `SELECT pg_sleep(6),row_id FROM ${path} LIMIT 1`,
                          );
                          arm.hit.resolve(pid);
                          try {
                            await native;
                          } catch (error) {
                            const e = error as {
                              code: string;
                              message: string;
                            };
                            arm.errors.push({
                              code: e.code,
                              message: e.message,
                            });
                            throw error;
                          }
                        } else {
                          const result = await c.query(sql, values);
                          arm.hit.resolve(pid);
                          await arm.resume.promise;
                          return result;
                        }
                      }
                      return c.query(sql, values);
                    };
                  const value = Reflect.get(c, key, c);
                  return typeof value === "function" ? value.bind(c) : value;
                },
              });
            };
          const value = Reflect.get(pool, member, pool);
          return typeof value === "function" ? value.bind(pool) : value;
        },
      });
      const storage = new TableStorage({
        pool: observed,
        ddlPool: ddl,
        cursorSecret: secret,
      });
      const arm = (
        match = /^FETCH FORWARD/,
        kind: Arm["kind"] = "sleep",
      ): Arm => {
        assert.equal(armed, undefined);
        const a: Arm = {
          kind,
          match,
          hit: deferred<number>(),
          resume: deferred<void>(),
          errors: [],
        };
        armed = a;
        return a;
      };
      const nativeSleeping = async (a: Arm) => {
        const pid = await bounded(a.hit.promise);
        await until(async () =>
          (
            await owner.query(
              "SELECT state,wait_event FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows.some(
            (r) => r.state === "active" && r.wait_event === "PgSleep",
          ),
        );
        return pid;
      };
      const confirmNativeCancellation = async (a: Arm, pid: number) => {
        assert.equal(a.errors.length, 1);
        assert.equal(a.errors[0]!.code, "57014");
        assert.match(a.errors[0]!.message, /user request/);
        await until(
          async () =>
            !(
              await owner.query(
                "SELECT 1 FROM pg_stat_activity WHERE pid=$1 OR (datname=$2 AND application_name='rootset_read_cancel')",
                [pid, name],
              )
            ).rowCount,
        );
        assert.equal(app.waitingCount, 0);
        assert.equal(
          (await base.queryRows(actor, table.id, { limit: 200 })).data.length,
          2,
        );
      };
      const cleanupRead = async (
        a: Arm,
        controller: AbortController,
        read: Promise<unknown>,
        peer?: PoolClient,
        peerWork?: Promise<unknown>,
      ) => {
        controller.abort();
        a.resume.resolve();
        await Promise.allSettled(peerWork ? [read, peerWork] : [read]);
        peer?.release();
        if (armed === a) armed = undefined;
      };
      await t.test(
        "queryRows cancels only its active native scan and preserves a concurrent peer",
        async () => {
          const a = arm(),
            controller = new AbortController();
          const read = settle(
            storage.queryRows(
              actor,
              table.id,
              { limit: 200 },
              { signal: controller.signal },
            ),
          );
          let peer: PoolClient | undefined;
          let peerWork: Promise<{ rows: { value: number }[] }> | undefined;
          try {
            const pid = await nativeSleeping(a);
            peer = await app.connect();
            const peerPid = Number(
              (await peer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
            );
            assert.notEqual(peerPid, pid);
            peerWork = peer.query("SELECT pg_sleep(0.2),17 AS value");
            void peerWork.catch(() => undefined);
            const start = performance.now();
            controller.abort();
            const result = await read;
            assert(
              cancelled(result.error),
              "actual table read must report client cancellation",
            );
            assert(
              performance.now() - start < 2000,
              "native cancellation must join within two seconds, independently of ten-second budget",
            );
            assert.equal((await peerWork).rows[0]!.value, 17);
            await confirmNativeCancellation(a, pid);
          } finally {
            await cleanupRead(a, controller, read, peer, peerWork);
          }
        },
      );
      await t.test(
        "windowQuery cancels native ranking and rolls back transient session state",
        async () => {
          const before = Number(
            (
              await owner.query(
                "SELECT count(*) AS n FROM rootset_control.query_sessions WHERE table_id=$1",
                [table.id],
              )
            ).rows[0].n,
          );
          const a = arm(/^WITH ranked AS/),
            controller = new AbortController();
          const read = settle(
            storage.queryWindow(
              actor,
              table.id,
              { query: { limit: 200 }, position: "middle" },
              { signal: controller.signal },
            ),
          );
          try {
            const pid = await nativeSleeping(a),
              start = performance.now();
            controller.abort();
            assert(cancelled((await read).error));
            assert(performance.now() - start < 2000);
            await confirmNativeCancellation(a, pid);
            assert.equal(
              Number(
                (
                  await owner.query(
                    "SELECT count(*) AS n FROM rootset_control.query_sessions WHERE table_id=$1",
                    [table.id],
                  )
                ).rows[0].n,
              ),
              before,
            );
          } finally {
            await cleanupRead(a, controller, read);
          }
        },
      );
      await t.test(
        "control connection failure closes only the owned read and reports a typed failure",
        async () => {
          const a = arm(),
            controller = new AbortController();
          const read = settle(
            storage.queryRows(
              actor,
              table.id,
              { limit: 200 },
              { signal: controller.signal },
            ),
          );
          let peer: PoolClient | undefined;
          let peerWork: Promise<{ rows: { value: number }[] }> | undefined;
          try {
            const pid = await nativeSleeping(a);
            peer = await app.connect();
            peerWork = peer.query("SELECT pg_sleep(0.2),29 AS value");
            void peerWork.catch(() => undefined);
            failControl = true;
            const start = performance.now();
            controller.abort();
            const result = await read;
            assert(
              result.error instanceof RootsetError &&
                result.error.code === "DEPENDENCY_UNAVAILABLE" &&
                result.error.status === 503,
            );
            assert(performance.now() - start < 3000);
            assert.equal((await peerWork).rows[0]!.value, 29);
            await until(
              async () =>
                !(
                  await owner.query(
                    "SELECT 1 FROM pg_stat_activity WHERE pid=$1 OR (datname=$2 AND application_name='rootset_read_cancel')",
                    [pid, name],
                  )
                ).rowCount,
            );
          } finally {
            await cleanupRead(a, controller, read, peer, peerWork);
            failControl = false;
          }
          assert.equal(
            (await base.queryRows(actor, table.id, { limit: 200 })).data.length,
            2,
          );
        },
      );
      await t.test(
        "control failure after native completion still joins closure without cancelling a peer",
        async () => {
          const a = arm(/^FETCH FORWARD/, "race"),
            controller = new AbortController();
          const read = settle(
            storage.queryRows(
              actor,
              table.id,
              { limit: 200 },
              { signal: controller.signal },
            ),
          );
          let peer: PoolClient | undefined;
          let peerWork: Promise<{ rows: { value: number }[] }> | undefined;
          try {
            const pid = await bounded(a.hit.promise);
            peer = await app.connect();
            peerWork = peer.query("SELECT pg_sleep(0.2),31 AS value");
            void peerWork.catch(() => undefined);
            failControl = true;
            controller.abort();
            await until(
              async () =>
                !(
                  await owner.query(
                    "SELECT 1 FROM pg_stat_activity WHERE pid=$1",
                    [pid],
                  )
                ).rowCount,
            );
            a.resume.resolve();
            const result = await read;
            assert(
              result.error instanceof RootsetError &&
                result.error.code === "DEPENDENCY_UNAVAILABLE",
            );
            assert.equal((await peerWork).rows[0]!.value, 31);
          } finally {
            await cleanupRead(a, controller, read, peer, peerWork);
            failControl = false;
          }
          assert.equal(
            (await base.queryRows(actor, table.id, { limit: 200 })).data.length,
            2,
          );
        },
      );
      await t.test(
        "already-aborted read issues no checkout SQL; bounded aborted pool waiter joins without SQL",
        async () => {
          const controller = new AbortController();
          controller.abort();
          const before = queryCount;
          assert(
            cancelled(
              (
                await settle(
                  storage.queryRows(
                    actor,
                    table.id,
                    {},
                    { signal: controller.signal },
                  ),
                )
              ).error,
            ),
          );
          assert.equal(queryCount, before);
          const single = createPool(app.options.connectionString!, 1);
          pools.push(single);
          const held = await single.connect(),
            pending = new AbortController();
          let work = 0,
            released = false;
          const read = settle(
            withOrgRead(
              single,
              actor.orgId,
              async () => {
                work++;
              },
              pending.signal,
            ),
          );
          try {
            await until(async () => single.waitingCount === 1);
            pending.abort();
            held.release();
            released = true;
            assert((await read).error instanceof ReadCancelledError);
            assert.equal(work, 0);
            assert.equal(single.waitingCount, 0);
            await withOrgRead(
              single,
              actor.orgId,
              (c) => c.query("SELECT 1"),
              new AbortController().signal,
            );
          } finally {
            pending.abort();
            if (!released) held.release(true);
            await read;
          }
        },
      );
      await t.test(
        "completion/abort race keeps ownership; late abort never cancels a reused peer backend",
        async () => {
          const a = arm(/^FETCH FORWARD/, "race"),
            controller = new AbortController();
          const read = settle(
            storage.queryRows(
              actor,
              table.id,
              { limit: 200 },
              { signal: controller.signal },
            ),
          );
          let peer: PoolClient | undefined;
          let peerWork: Promise<{ rows: { value: number }[] }> | undefined;
          try {
            const pid = await bounded(a.hit.promise);
            peer = await app.connect();
            peerWork = peer.query("SELECT pg_sleep(0.2),19 AS value");
            void peerWork.catch(() => undefined);
            controller.abort();
            a.resume.resolve();
            assert(cancelled((await read).error));
            assert.equal(a.errors.length, 0);
            assert.equal((await peerWork).rows[0]!.value, 19);
            await until(
              async () =>
                !(
                  await owner.query(
                    "SELECT 1 FROM pg_stat_activity WHERE pid=$1",
                    [pid],
                  )
                ).rowCount,
            );
          } finally {
            await cleanupRead(a, controller, read, peer, peerWork);
          }
          const single = createPool(app.options.connectionString!, 1);
          pools.push(single);
          const old = new AbortController();
          const ownPid = await withOrgRead(
            single,
            actor.orgId,
            async (c) => {
              const state = (
                await c.query(
                  "SELECT pg_backend_pid() AS pid,current_setting('client_connection_check_interval') AS polling,current_setting('statement_timeout') AS budget",
                )
              ).rows[0];
              assert.equal(state.polling, "100ms");
              assert.equal(state.budget, "10s");
              return Number(state.pid);
            },
            old.signal,
          );
          const next = await single.connect();

          let nextWork: Promise<{ rows: { value: number }[] }> | undefined;
          try {
            assert.equal(
              (
                await next.query(
                  "SELECT current_setting('client_connection_check_interval') AS polling",
                )
              ).rows[0].polling,
              "0",
              "Read-local polling must reset before reuse",
            );
            assert.equal(
              Number(
                (await next.query("SELECT pg_backend_pid() AS pid")).rows[0]
                  .pid,
              ),
              ownPid,
            );
            nextWork = next.query("SELECT pg_sleep(0.2),23 AS value");
            void nextWork.catch(() => undefined);
            old.abort();
            assert.equal((await nextWork).rows[0]!.value, 23);
          } finally {
            if (nextWork) await settle(nextWork);
            next.release();
          }
        },
      );
      await t.test(
        "real HTTP disconnect reaches Core REST, MCP and runtime browser window native reads",
        async () => {
          // Synthetic fixture authentication isolates cancellation; genuine OAuth/Owner authorization is covered separately.
          const unexpected = new Proxy(
            {},
            {
              get: () => {
                throw new Error("Unexpected non-read fixture dependency");
              },
            },
          );
          const fixtureIdentity = {
            refreshActor: async (incoming: Actor) => {
              assert.equal(incoming.orgId, actor.orgId);
              return incoming;
            },
            resolveActor: async (_request: Request, audience: string) =>
              audience === "mcp" ? { ...actor, kind: "oauth" as const } : actor,
          };
          const config = {
            cursorSecret: secret,
            keyHashSecret: secret,
            baseURL: "http://127.0.0.1:1",
            version: "fixture",
          };
          const core = new RootsetCore({
            storage,
            pool: app,
            identityPool: identity,
            config,
            identity: fixtureIdentity,
            jobs: unexpected,
          } as unknown as CoreOptions);
          const events: Array<{
            requestId: string;
            errorCode?: string;
            status: number;
          }> = [];
          const runtime = {
            pool: app,
            admissionPool: app,
            storage,
            core,
            identity: fixtureIdentity,
            config,
            jobs: unexpected,
            oauth: { defaultScopes: ["rows:read"] },
            observer: {
              record: (event: (typeof events)[number]) => {
                events.push(event);
              },
            },
          } as unknown as Parameters<typeof createRuntimeApp>[0];
          let handler: ReturnType<typeof createRuntimeApp> | undefined;
          let incoming: Request | undefined;
          const handlersByFixture = new Map<string, Promise<unknown>>();
          const handlerTasks: Promise<unknown>[] = [];
          const server = serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
              incoming = request;
              const work = Promise.resolve().then(() =>
                handler!.fetch(request),
              );
              const joined = settle(work);
              handlerTasks.push(joined);
              const marker = request.headers.get("X-Request-Id");
              if (marker) {
                assert(
                  !handlersByFixture.has(marker),
                  "Controlled fixture marker must be unique",
                );
                handlersByFixture.set(marker, joined);
              }
              return work;
            },
          });
          try {
            await once(server, "listening");
            const address = server.address();
            assert(address && typeof address === "object");
            config.baseURL = `http://127.0.0.1:${address.port}`;
            handler = createRuntimeApp(runtime);
            const target = {
              workspaceId: actor.orgId,
              orgId: actor.orgId,
              databaseId: database.id,
              tableId: table.id,
            };
            for (const kind of [
              "rest",
              "browser",
              "mcp",
              "mcp-notification",
            ] as const) {
              const offset = events.length;
              const id = newId(),
                a = arm(
                  kind === "browser" ? /^WITH ranked AS/ : /^FETCH FORWARD/,
                );
              const path =
                kind === "rest"
                  ? `/v1/orgs/${actor.orgId}/databases/${database.id}/tables/${table.id}/query`
                  : kind === "browser"
                    ? `/api/internal/v1/tables/${table.id}/windows/query`
                    : "/mcp";
              const body =
                kind === "mcp" || kind === "mcp-notification"
                  ? {
                      jsonrpc: "2.0",
                      id,
                      method: "tools/call",
                      params: {
                        name: getOperation("queryRows").toolName,
                        arguments: { ...target, query: { limit: 200 } },
                      },
                    }
                  : {
                      workspaceId: actor.orgId,
                      orgId: actor.orgId,
                      databaseId: database.id,
                      query: { limit: 200 },
                      ...(kind === "browser" ? { position: "middle" } : {}),
                    };
              // Public path carries route IDs rather than body IDs.
              const encoded = JSON.stringify(
                kind === "rest"
                  ? { workspaceId: actor.orgId, query: { limit: 200 } }
                  : body,
              );
              const request = httpRequest(`${config.baseURL}${path}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  Authorization: "Bearer isolated-fixture",
                  Cookie: "test=isolated-fixture",
                  Origin: config.baseURL,
                  "X-Request-Id": id,
                  "MCP-Protocol-Version": "2025-11-25",
                },
              });
              const responseDiagnostic: {
                status?: number;
                errorCode?: string;
              } = {};
              const transport = settle(
                new Promise<void>((resolve, reject) => {
                  request.on("response", (response) => {
                    responseDiagnostic.status = response.statusCode;
                    let body = "";
                    response.on("data", (bytes: Buffer) => {
                      if (body.length < 4096) body += bytes.toString();
                    });
                    response.once("end", () => {
                      try {
                        const decoded = JSON.parse(body) as {
                          error?: { code?: unknown };
                          result?: {
                            structuredContent?: { error?: { code?: unknown } };
                          };
                        };
                        const code =
                          decoded.error?.code ??
                          decoded.result?.structuredContent?.error?.code;
                        if (
                          typeof code === "string" &&
                          /^[A-Z_]{1,64}$/.test(code)
                        )
                          responseDiagnostic.errorCode = code;
                      } catch {
                        /* A completed fixture response may be a non-error or truncated JSON. */
                      }
                      resolve();
                    });
                  });
                  request.once("error", reject);
                }),
              );
              request.end(encoded);
              let peer: PoolClient | undefined;
              let peerWork: Promise<{ rows: { value: number }[] }> | undefined;
              try {
                const pid = await nativeSleeping(a).catch((error) => {
                  throw new Error(
                    `${kind} pre-scan fixture failed: HTTP ${responseDiagnostic.status ?? "pending"}; typed code ${responseDiagnostic.errorCode ?? "unavailable"}`,
                    { cause: error },
                  );
                });
                assert(incoming && !incoming.signal.aborted);
                const captured = incoming,
                  start = performance.now();
                if (kind === "mcp-notification") {
                  peer = await app.connect();
                  peerWork = peer.query("SELECT pg_sleep(0.2),37 AS value");
                  void peerWork.catch(() => undefined);
                  const notification = await fetch(`${config.baseURL}/mcp`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Accept: "application/json, text/event-stream",
                      Authorization: "Bearer isolated-fixture",
                      "MCP-Protocol-Version": "2025-11-25",
                    },
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      method: "notifications/cancelled",
                      params: { requestId: id },
                    }),
                  });
                  await notification.arrayBuffer();
                  assert.equal(notification.status, 202);
                } else request.destroy(new Error("Isolated client abort"));
                await transport;
                await until(async () =>
                  events
                    .slice(offset)
                    .some(
                      (e) =>
                        e.errorCode === "REQUEST_TIMEOUT" &&
                        e.status === (kind.startsWith("mcp") ? 200 : 408),
                    ),
                );
                assert.equal(
                  captured.signal.aborted,
                  kind !== "mcp-notification",
                  `${kind}: raw signal must reflect actual socket state`,
                );
                assert(
                  performance.now() - start < 2000,
                  `${kind}: native work and API handler must join before deadline`,
                );
                await confirmNativeCancellation(a, pid);
                if (kind === "mcp-notification") {
                  assert.equal(responseDiagnostic.status, 200);
                  assert.equal(responseDiagnostic.errorCode, "REQUEST_TIMEOUT");
                  assert(peerWork);
                  assert.equal((await peerWork).rows[0]!.value, 37);
                  assert.equal(
                    captured.signal.aborted,
                    false,
                    "Separate-POST cancellation must not rely on socket close",
                  );
                }
              } finally {
                request.destroy();
                a.resume.resolve();
                await transport;
                if (peerWork) await settle(peerWork);
                peer?.release();
                const originalHandler = handlersByFixture.get(id);
                assert(
                  originalHandler,
                  "Original controlled request must reach the native HTTP adapter",
                );
                await originalHandler;
                handlersByFixture.delete(id);
                if (armed === a) armed = undefined;
              }
            }
            const response = await fetch(
              `${config.baseURL}/v1/orgs/${actor.orgId}/databases/${database.id}/tables/${table.id}/rows?limit=200&workspaceId=${actor.orgId}`,
              { headers: { Authorization: "Bearer isolated-fixture" } },
            );
            assert.equal(response.status, 200);
            assert.equal(
              ((await response.json()) as { data: unknown[] }).data.length,
              2,
            );
          } finally {
            assert(
              "closeAllConnections" in server,
              "fixture must be a native HTTP/1 server",
            );
            server.closeAllConnections();
            await Promise.allSettled(handlerTasks);
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
      );
    } finally {
      const closure = await Promise.allSettled(pools.map((pool) => pool.end()));
      try {
        assert(
          closure.every((result) => result.status === "fulfilled"),
          "Every owned native pool must close",
        );
        assert(
          pools.every(
            (pool) =>
              pool.ended && pool.totalCount === 0 && pool.waitingCount === 0,
          ),
        );
        if (created) {
          await until(
            async () =>
              (
                await admin.query(
                  "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1",
                  [name],
                )
              ).rows[0].n === "0",
          );
          assert.equal(
            (
              await admin.query(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1",
                [name],
              )
            ).rows[0].n,
            "0",
            "No control or read connection may survive pool closure",
          );
          await admin.query(`DROP DATABASE "${name}"`);
        }
      } finally {
        await admin.end();
        assert(admin.ended);
      }
    }
  },
);
