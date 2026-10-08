import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https, { type RequestOptions } from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  fetchClientMetadata,
  OAuthError,
  parseConfiguredClients,
} from "./index.js";

test("configured public OAuth clients validate bounded strict JSON, unique IDs and exact redirect registration", () => {
  assert.equal(parseConfiguredClients(undefined), undefined);
  const client = {
    client_id: "rootset-browser-verification",
    client_name: "Browser verification",
    redirect_uris: ["http://localhost:4311/settings/connections"],
  };
  assert.deepEqual(parseConfiguredClients(JSON.stringify([client])), [
    { ...client, token_endpoint_auth_method: "none" },
  ]);
  for (const value of [
    null,
    {},
    "not an array",
    [client, client],
    [{ ...client, client_id: "" }],
    [{ ...client, redirect_uris: ["http://private.example/callback"] }],
    [{ ...client, token_endpoint_auth_method: "client_secret_basic" }],
  ])
    assert.throws(() => parseConfiguredClients(JSON.stringify(value)));
  assert.throws(() =>
    parseConfiguredClients('[{"client_id":"a","client_id":"b"}]'),
  );
  assert.throws(() => parseConfiguredClients(" "));
  const maximum = Array.from({ length: 100 }, (_, index) => ({
    ...client,
    client_id: `registered-${index}`,
  }));
  assert.equal(parseConfiguredClients(JSON.stringify(maximum))?.length, 100);
  assert.throws(() =>
    parseConfiguredClients(
      JSON.stringify([...maximum, { ...client, client_id: "registered-101" }]),
    ),
  );
});

test("shipped optional OAuth defaults reach the actual API entrypoint with zero static clients", async () => {
  const example = await readFile(
    new URL("../../../.env.example", import.meta.url),
    "utf8",
  );
  const compose = await readFile(
    new URL("../../../compose.yaml", import.meta.url),
    "utf8",
  );
  const exampleDefault = /^ROOTSET_OAUTH_CLIENTS=(.*)$/m.exec(example)?.[1];
  const composeDefault =
    /ROOTSET_OAUTH_CLIENTS:\s*\$\{ROOTSET_OAUTH_CLIENTS:-([^}]*)\}/.exec(
      compose,
    )?.[1];
  assert.equal(exampleDefault, undefined);
  assert.equal(composeDefault, "[]");
  const entrypoint = new URL(
    "../../../apps/rootset-api/src/index.ts",
    import.meta.url,
  );
  const hook = `
    import { registerHooks } from "node:module";
    const modules = new Map([
      ["@rootset/core/runtime", "export async function createRuntime(_,options){if(!Array.isArray(options.oauthClients)||options.oauthClients.length!==0)throw Error('Expected optional empty clients');console.info(JSON.stringify({event:'rootset_entrypoint_options',clients:options.oauthClients}));return{config:{port:4310},close:async()=>{}}}"],
      ["@hono/node-server", "export function serve(options){if(typeof options.fetch!=='function'||options.port!==4310)throw Error('Server options invalid');return{close:callback=>callback()}}"],
      ["./runtime-app.js", "export function createRuntimeApp(){return{fetch:()=>new Response('fixture')}}"],
      ["./http-server.js", "export const httpServerOptions={}"]
    ]);
    registerHooks({resolve(specifier,context,next){const source=context.parentURL===${JSON.stringify(entrypoint.href)}?modules.get(specifier):undefined;return source===undefined?next(specifier,context):{url:'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),shortCircuit:true}}});
  `;
  for (const source of [exampleDefault ?? "[]", composeDefault]) {
    assert.deepEqual(parseConfiguredClients(source), []);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "data:text/javascript;base64," + Buffer.from(hook).toString("base64"),
        fileURLToPath(entrypoint),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 65_536,
        env: {
          ...process.env,
          ROOTSET_OAUTH_CLIENTS: source,
          ROOTSET_HOST: "127.0.0.1",
        },
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(
      child.status,
      0,
      "Actual entrypoint must accept shipped optional defaults before opening injected runtime/server boundaries",
    );
    const output = child.stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            clients?: unknown;
            port?: number;
          },
      );
    assert.deepEqual(
      output.find((line) => line.event === "rootset_entrypoint_options")
        ?.clients,
      [],
    );
    assert.equal(
      output.find((line) => line.event === "rootset_api_listening")?.port,
      4310,
    );
  }
});

const clientId = "https://metadata.rootset.example/client.json";
const document = JSON.stringify({
  client_id: clientId,
  client_name: "Verified metadata document",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
});

function network(
  t: TestContext,
  reply: {
    status?: number;
    contentType?: string;
    chunks?: Buffer[];
    hang?: boolean;
    error?: Error;
  } = {},
) {
  t.mock.method(dns, "lookup", async () => [
    { address: "93.184.215.14", family: 4 },
  ]);
  let options: RequestOptions | undefined,
    destroyed = false;
  t.mock.method(
    https,
    "request",
    (
      _url: URL,
      input: RequestOptions,
      callback: (
        response: PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
        },
      ) => void,
    ) => {
      options = input;
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error?: Error) => void;
      };
      request.destroy = (error) => {
        destroyed = true;
        if (error) queueMicrotask(() => request.emit("error", error));
        queueMicrotask(() => request.emit("close"));
      };
      request.end = () =>
        queueMicrotask(() => {
          if (reply.error) {
            request.destroy(reply.error);
            return;
          }
          if (reply.hang) return;
          const response = Object.assign(new PassThrough(), {
            statusCode: reply.status ?? 200,
            headers: {
              "content-type": reply.contentType ?? "application/json",
            },
          });
          callback(response);
          if (!destroyed) {
            for (const chunk of reply.chunks ?? [Buffer.from(document)])
              response.write(chunk);
            response.end();
          }
          queueMicrotask(() => request.emit("close"));
        });
      return request;
    },
  );
  return {
    get options() {
      return options;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

test("metadata fetch pins the validated DNS address while retaining HTTPS hostname verification", async (t) => {
  const fixture = network(t);
  const metadata = await fetchClientMetadata(clientId);
  assert.equal(metadata.client_id, clientId);
  assert.equal(metadata.client_name, "Verified metadata document");
  assert.equal(fixture.options?.rejectUnauthorized, true);
  const lookup = fixture.options?.lookup;
  assert.equal(typeof lookup, "function");
  await new Promise<void>((resolve, reject) => {
    if (typeof lookup !== "function") throw new Error("Pinned lookup missing");
    lookup("metadata.rootset.example", {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, "93.184.215.14");
      assert.equal(family, 4);
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    if (typeof lookup !== "function") throw new Error("Pinned lookup missing");
    lookup("metadata.rootset.example", { all: true }, (error, addresses) => {
      if (error) return reject(error);
      assert.deepEqual(addresses, [{ address: "93.184.215.14", family: 4 }]);
      resolve();
    });
  });
});
test("metadata rejects any private DNS answer before opening a connection", async (t) => {
  const fixture = network(t);
  t.mock.method(dns, "lookup", async () => [
    { address: "93.184.215.14", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await assert.rejects(fetchClientMetadata(clientId), /private|reserved/);
  assert.equal(fixture.options, undefined);
});
test("metadata rejects redirects and non-JSON media immediately", async (t) => {
  for (const reply of [{ status: 302 }, { contentType: "text/html" }]) {
    const fixture = network(t, reply);
    await assert.rejects(fetchClientMetadata(clientId), /without redirects/);
    assert.equal(fixture.destroyed, true);
    t.mock.restoreAll();
  }
});
test("metadata rejects oversized, duplicate, malformed UTF-8 and mismatched client documents", async (t) => {
  for (const [bytes, reason] of [
    [Buffer.alloc(65_537, 120), /64 KiB/],
    [Buffer.from('{"client_id":"a","client_id":"b"}'), /invalid JSON/],
    [Buffer.from([0xff]), /UTF-8/],
    [
      Buffer.from(
        document.replace(clientId, "https://different.example/client.json"),
      ),
      /identifier|client_id|Client metadata/i,
    ],
  ] as const) {
    network(t, { chunks: [bytes] });
    await assert.rejects(fetchClientMetadata(clientId), reason);
    t.mock.restoreAll();
  }
});
test("metadata absolute deadline cancels a response that never arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = network(t, { hang: true }),
    pending = fetchClientMetadata(clientId);
  await setImmediate();
  t.mock.timers.tick(5001);
  await assert.rejects(pending, /fetch timed out/);
  assert.equal(fixture.destroyed, true);
});
test("metadata DNS deadline bounds resolution and network failures remain protocol errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  const pending = fetchClientMetadata(clientId);
  await setImmediate();
  t.mock.timers.tick(5001);
  await assert.rejects(pending, /DNS lookup timed out/);
  t.mock.restoreAll();
  network(t, { error: new Error("Sensitive transport detail") });
  await assert.rejects(
    fetchClientMetadata(clientId),
    (error) =>
      error instanceof OAuthError &&
      error.code === "invalid_client" &&
      !error.message.includes("Sensitive"),
  );
});
