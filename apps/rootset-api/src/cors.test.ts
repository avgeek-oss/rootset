import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type ApiDependencies } from "./app.js";

const apiOrigin = "https://rootset-api.avgeek.ltd";
const webOrigin = "https://rootset.avgeek.ltd";
const app = createApp({
  config: { baseURL: apiOrigin, webURL: webOrigin },
  pool: {},
  identity: {
    resolveActor: async () => null,
    setupStatus: async () => ({ claimed: false }),
  },
  oauth: {},
} as unknown as ApiDependencies);

test("credentialed browser preflight is limited to the configured UI origin", async () => {
  const preflight = await app.request("/api/internal/v1/context", {
    method: "OPTIONS",
    headers: {
      Origin: webOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type,idempotency-key,x-rootset-organisation-id",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), webOrigin);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  assert.match(
    preflight.headers.get("Access-Control-Allow-Headers") ?? "",
    /Idempotency-Key/,
  );
  assert.match(
    preflight.headers.get("Access-Control-Allow-Headers") ?? "",
    /X-Rootset-Organisation-Id/,
  );
  const foreign = await app.request("/api/internal/v1/context", {
    method: "OPTIONS",
    headers: { Origin: "https://other.example" },
  });
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), null);
  const setup = await app.request("/v1/setup", {
    headers: { Origin: webOrigin },
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.headers.get("Access-Control-Allow-Origin"), webOrigin);
  assert.equal(setup.headers.get("Access-Control-Allow-Credentials"), "true");
  const denied = await app.request("/api/internal/v1/context", {
    headers: { Origin: webOrigin },
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), webOrigin);
  assert.equal(
    denied.headers.get("Access-Control-Expose-Headers"),
    "X-Request-ID",
  );
  assert(denied.headers.get("X-Request-ID"));
});

test("session mutation rejects a foreign origin before authentication", async () => {
  const response = await app.request(
    "/api/internal/v1/orgs/01K6DVWSFS9MR156YW1H5XZ440/databases",
    {
      method: "POST",
      headers: {
        Origin: "https://other.example",
        Cookie: "rootset.session_token=fixture",
      },
    },
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  const apiHost = await app.request(
    "/api/internal/v1/orgs/01K6DVWSFS9MR156YW1H5XZ440/databases",
    {
      method: "POST",
      headers: { Origin: apiOrigin, Cookie: "rootset.session_token=fixture" },
    },
  );
  assert.equal(apiHost.status, 403);
});
