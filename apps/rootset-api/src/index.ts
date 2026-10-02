import { serve } from "@hono/node-server";
import { createRuntime } from "@rootset/core/runtime";
import { parseConfiguredClients } from "@rootset/oauth";
import { createRuntimeApp } from "./runtime-app.js";
import { httpServerOptions } from "./http-server.js";

const runtime = await createRuntime(undefined, {
  oauthClients: parseConfiguredClients(process.env.ROOTSET_OAUTH_CLIENTS),
});
const app = createRuntimeApp(runtime);
const server = serve({
  serverOptions: httpServerOptions,
  fetch: app.fetch,
  port: runtime.config.port,
  hostname: process.env.ROOTSET_HOST ?? "127.0.0.1",
});
console.info(
  JSON.stringify({ event: "rootset_api_listening", port: runtime.config.port }),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await runtime.close();
    process.exitCode = 0;
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
