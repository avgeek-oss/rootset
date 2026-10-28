import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getOperation,
  newId,
  RootsetError,
  type Actor,
} from "@rootset/contracts";
import {
  createApp,
  type ApiDependencies,
  type OperationContext,
} from "./app.js";
import { McpReadRegistry, validMcpRequestId } from "./mcp-read-registry.js";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Controlled MCP barrier did not settle")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
const owner: Actor = {
  kind: "oauth",
  id: newId(),
  credentialId: newId(),
  clientId: "fixture-client",
  userId: newId(),
  orgId: newId(),
  role: "admin",
  scopes: ["viewer", "member"],
};
const ids = {
  workspaceId: owner.orgId,
  orgId: owner.orgId,
  databaseId: newId(),
  tableId: newId(),
};
const readOutput = {
  data: [],
  schemaVersion: 1,
  page: {
    returned: 0,
    requestedLimit: 1,
    hasMore: false,
    nextCursor: null,
    stopReason: "end",
    consistency: "live",
  },
};
const writeOutput = {
  row: {
    id: newId(),
    version: "1",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    values: { CODE: "fixture" },
  },
  mutationId: newId(),
};
type NativeBridge = {
  actor: Actor;
  operation: string;
  context: OperationContext;
  end: () => void;
  joined: boolean;
  aborted: boolean;
};
function fixture() {
  let connected = 0,
    failedAdmission = false;
  const pool = {
    connect: async () => {
      connected++;
      return {
        query: async (sql: string) => {
          if (failedAdmission && sql.includes("SELECT count(*)"))
            throw new Error("Controlled admission unavailable");
          return {
            rows: sql.includes("RETURNING requests")
              ? [{ requests: 1 }]
              : sql.includes("SELECT count(*)")
                ? [{ count: 0 }]
                : [],
          };
        },
        release: () => {
          connected--;
        },
      };
    },
    query: async () => ({ rows: [] }),
  } as unknown as Pool;
  const actors = new Map([
    ["fixture-a", owner],
    [
      "fixture-b",
      { ...owner, id: newId(), credentialId: newId(), userId: newId() },
    ],
  ]);
  const disabled = new Set<string>();
  const native: NativeBridge[] = [],
    calls: Record<string, unknown>[] = [],
    clients: Client[] = [],
    pending: Promise<unknown>[] = [];
  const identity: ApiDependencies["identity"] = {
    auth: { handler: async () => Response.json({}) },
    resolveActor: async (request, audience) => {
      assert.equal(audience, "mcp");
      const token = request.headers.get("authorization")?.slice(7);
      return token && !disabled.has(token) ? (actors.get(token) ?? null) : null;
    },
    setupStatus: async () => ({}),
    claimSetup: async () => ({}),
  };
  const deps: ApiDependencies = {
    pool,
    config: { baseURL: "http://mcp-fixture.localhost" },
    identity,
    oauth: {
      defaultScopes: ["viewer", "member"],
    } as ApiDependencies["oauth"],
    core: {
      execute: async (operation, actor, _input, context) => {
        const done = deferred();
        const bridge: NativeBridge = {
          actor,
          operation,
          context,
          end: () => done.resolve(),
          joined: false,
          aborted: false,
        };
        native.push(bridge);
        const abort = () => {
          bridge.aborted = true;
          done.resolve();
        };
        context.signal?.addEventListener("abort", abort, { once: true });
        if (context.signal?.aborted) abort();
        try {
          await done.promise;
          if (
            bridge.aborted &&
            (operation === "queryRows" || operation === "listRows")
          )
            throw new RootsetError(
              "REQUEST_TIMEOUT",
              "Client request ended before its table read completed",
              408,
            );
          return operation === "createRow" ? writeOutput : readOutput;
        } finally {
          context.signal?.removeEventListener("abort", abort);
          bridge.joined = true;
        }
      },
    },
  };
  const app = createApp(deps);
  const request = async (token: string, body: unknown) =>
    app.fetch(
      new Request("http://mcp-fixture.localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  async function sdk(token: string) {
    const client = new Client({
      name: "controlled-two-post-regression",
      version: "1",
    });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL("http://mcp-fixture.localhost/mcp"),
      {
        requestInit: { headers: { Authorization: "Bearer " + token } },
        fetch: async (input, init) => {
          const incoming = new Request(input, init);
          if (incoming.method === "POST")
            calls.push({ token, ...(await incoming.clone().json()) });
          return app.fetch(incoming);
        },
      },
    );
    await client.connect(transport);
    return client;
  }
  async function start(client: Client, operation = "queryRows") {
    const count = native.length;
    const work = client.callTool({
      name: getOperation(operation).toolName,
      arguments: {
        ...ids,
        ...(operation === "queryRows"
          ? { query: { limit: 1 } }
          : operation === "listRows"
            ? { limit: 1 }
            : {
                values: { CODE: "fixture" },
                expectedSchemaVersion: 1,
                idempotencyKey: "controlled-mutation-key",
              }),
      },
    });
    const promise = settle(work);
    pending.push(promise);
    await bounded(
      (async () => {
        while (native.length === count) await pause(5);
      })(),
    );
    const rpc = calls.filter((call) => call.method === "tools/call").at(-1)!;
    return { promise, bridge: native[count]!, id: rpc.id as string | number };
  }
  return {
    app,
    request,
    sdk,
    start,
    native,
    actors,
    disabled,
    calls,
    setFailedAdmission: (value: boolean) => {
      failedAdmission = value;
    },
    async close() {
      native.forEach((bridge) => bridge.end());
      await Promise.allSettled(pending);
      await Promise.allSettled(clients.map((client) => client.close()));
      assert.equal(connected, 0);
      assert(native.every((bridge) => bridge.joined));
    },
  };
}

test(
  "two real SDK HTTP POSTs: notification cancels only the owned table read while its HTTP request remains open",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const client = await f.sdk("fixture-a"),
        read = await f.start(client);
      assert.equal(read.bridge.context.request?.signal.aborted, false);
      await client.notification({
        method: "notifications/cancelled",
        params: { requestId: read.id, reason: "controlled fixture" },
      });
      const result = await bounded(read.promise);
      assert.equal(result.error, undefined);
      assert.equal(result.value?.isError, true);
      assert.equal(
        (result.value?.structuredContent as { error: { code: string } }).error
          .code,
        "REQUEST_TIMEOUT",
      );
      assert.equal(read.bridge.context.request?.signal.aborted, false);
      assert.equal(read.bridge.context.signal?.aborted, true);
      assert.equal(read.bridge.joined, true);
      assert.equal(
        f.calls.filter((call) => call.method === "notifications/cancelled")
          .length,
        1,
      );
      assert.equal(
        f.calls.filter((call) => call.method === "tools/call").length,
        1,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "colliding SDK IDs across two authenticated principals cannot cancel a peer",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const a = await f.sdk("fixture-a"),
        b = await f.sdk("fixture-b"),
        first = await f.start(a),
        second = await f.start(b);
      assert.equal(first.id, second.id);
      await b.notification({
        method: "notifications/cancelled",
        params: { requestId: second.id },
      });
      assert.equal((await bounded(second.promise)).value?.isError, true);
      assert.equal(first.bridge.context.signal?.aborted, false);
      await a.notification({
        method: "notifications/cancelled",
        params: { requestId: first.id },
      });
      assert.equal((await bounded(first.promise)).value?.isError, true);
    } finally {
      await f.close();
    }
  },
);
test(
  "listRows notification uses the same bridge; invalid media cannot reach cancellation",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const client = await f.sdk("fixture-a"),
        read = await f.start(client, "listRows");
      const refused = await f.app.fetch(
        new Request("http://mcp-fixture.localhost/mcp", {
          method: "POST",
          headers: {
            Authorization: "Bearer fixture-a",
            "Content-Type": "application/json",
            Accept: "text/plain",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: read.id },
          }),
        }),
      );
      assert.equal(refused.status, 406);
      assert.equal(read.bridge.context.signal?.aborted, false);
      await client.notification({
        method: "notifications/cancelled",
        params: { requestId: read.id },
      });
      assert.equal((await bounded(read.promise)).value?.isError, true);
      assert.equal(read.bridge.joined, true);
    } finally {
      await f.close();
    }
  },
);
test(
  "revoked notification caller is rejected before registry access; mutations keep their commit and idempotency context",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const client = await f.sdk("fixture-a"),
        read = await f.start(client);
      f.disabled.add("fixture-a");
      const revoked = await f.request("fixture-a", {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: read.id },
      });
      assert.equal(revoked.status, 401);
      assert.equal(read.bridge.context.signal?.aborted, false);
      f.disabled.delete("fixture-a");
      await client.notification({
        method: "notifications/cancelled",
        params: { requestId: read.id },
      });
      await bounded(read.promise);
      const mutation = await f.start(client, "createRow");
      await client.notification({
        method: "notifications/cancelled",
        params: { requestId: mutation.id },
      });
      assert.equal(mutation.bridge.context.signal?.aborted, false);
      assert.equal(
        mutation.bridge.context.idempotencyKey,
        "controlled-mutation-key",
      );
      mutation.bridge.end();
      const committed = await bounded(mutation.promise);
      assert.equal(committed.value?.isError, undefined);
      assert.deepEqual(committed.value?.structuredContent, writeOutput);
    } finally {
      await f.close();
    }
  },
);
test(
  "duplicate in-flight read ID refuses execution; malformed cancellation cannot abort a read; released ID can be reused",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const client = await f.sdk("fixture-a"),
        read = await f.start(client);
      const body = {
        jsonrpc: "2.0",
        id: read.id,
        method: "tools/call",
        params: {
          name: getOperation("queryRows").toolName,
          arguments: { ...ids, query: { limit: 1 } },
        },
      };
      const duplicate = await f.request("fixture-a", body);
      const failure = (await duplicate.json()) as {
        result: {
          isError: boolean;
          structuredContent: { error: { code: string } };
        };
      };
      assert.equal(failure.result.isError, true);
      assert.equal(
        failure.result.structuredContent.error.code,
        "VALIDATION_FAILED",
      );
      assert.equal(f.native.length, 1);
      for (const requestId of ["x".repeat(129), 9007199254740992]) {
        assert.equal(
          (
            await f.request("fixture-a", {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId },
            })
          ).status,
          400,
        );
        assert.equal(read.bridge.context.signal?.aborted, false);
      }
      await client.notification({
        method: "notifications/cancelled",
        params: { requestId: read.id },
      });
      await bounded(read.promise);
      const again = f.request("fixture-a", body);
      await bounded(
        (async () => {
          while (f.native.length < 2) await pause(5);
        })(),
      );
      f.native[1]!.end();
      assert.equal((await again).status, 200);
      assert.equal(f.native[1]!.aborted, false);
    } finally {
      await f.close();
    }
  },
);
test(
  "admission failure releases the reserved read ID; successful raw string and zero IDs cancel and join",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const body = (id: string | number) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: getOperation("listRows").toolName,
          arguments: { ...ids, limit: 1 },
        },
      });
      f.setFailedAdmission(true);
      const failed = await f.request("fixture-a", body(""));
      assert.equal(
        ((await failed.json()) as { result: { isError: boolean } }).result
          .isError,
        true,
      );
      assert.equal(f.native.length, 0);
      f.setFailedAdmission(false);
      for (const id of ["", 0]) {
        const count: number = f.native.length;
        const work = f.request("fixture-a", body(id));
        await bounded(
          (async () => {
            while (f.native.length === count) await pause(5);
          })(),
        );
        const wrongType = await f.request("fixture-a", {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: typeof id === "number" ? String(id) : 0 },
        });
        assert.equal(wrongType.status, 202);
        assert.equal(f.native[count]!.context.signal?.aborted, false);
        assert.equal(
          (
            await f.request("fixture-a", {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id },
            })
          ).status,
          202,
        );
        assert.equal((await bounded(work)).status, 200);
        assert.equal(f.native[count]!.aborted, true);
        assert.equal(f.native[count]!.joined, true);
      }
    } finally {
      await f.close();
    }
  },
);
test(
  "registry namespaces every authoritative identity, preserves typed/zero IDs, and retains expired slots until joined release",
  { timeout: 10000 },
  async () => {
    const registry = new McpReadRegistry({
        maximumEntries: 2,
        maximumPerPrincipal: 2,
        lifetimeMs: 15,
      }),
      upstream = new AbortController();
    assert(validMcpRequestId(0));
    assert(validMcpRequestId(""));
    assert(!validMcpRequestId(Infinity));
    assert(!validMcpRequestId("x".repeat(129)));
    const numeric = registry.begin(owner, 0, upstream.signal),
      text = registry.begin(owner, "0", upstream.signal);
    for (const change of [
      { orgId: newId() },
      { id: newId() },
      { credentialId: newId() },
      { clientId: "other-client" },
      { userId: newId() },
      { kind: "personal_key" as Actor["kind"] },
    ])
      registry.cancel({ ...owner, ...change }, 0);
    assert.equal(numeric.signal.aborted, false);
    registry.cancel(owner, 0);
    assert.equal(numeric.signal.aborted, true);
    assert.equal(text.signal.aborted, false);
    assert.throws(
      () => registry.begin(owner, 1, upstream.signal),
      /Too many active/,
    );
    await pause(25);
    assert.equal(text.signal.aborted, true);
    assert.equal(registry.size, 2);
    assert.throws(
      () => registry.begin(owner, "0", upstream.signal),
      /already active/,
    );
    numeric.release();
    numeric.release();
    text.release();
    assert.equal(registry.size, 0);
    const fresh = registry.begin(owner, "0", upstream.signal);
    assert.equal(fresh.signal.aborted, false);
    fresh.release();
    const revokedRole = registry.begin(owner, 7, upstream.signal);
    registry.cancel(
      {
        ...owner,
        role: "viewer",
        scopes: [],
      },
      7,
    );
    assert.equal(revokedRole.signal.aborted, true);
    revokedRole.release();
    const ended = new AbortController();
    ended.abort();
    const disconnected = registry.begin(owner, 8, ended.signal);
    assert.equal(disconnected.signal.aborted, true);
    disconnected.release();
    assert.equal(registry.size, 0);
    assert.throws(
      () =>
        new McpReadRegistry({
          maximumEntries: 1025,
          maximumPerPrincipal: 2,
          lifetimeMs: 15,
        }),
    );
  },
);
