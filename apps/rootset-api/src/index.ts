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
  // server.close ignores its callback's result, so handle the runtime close
  // here: a failure is logged and exits non-zero instead of becoming an
  // unhandled rejection.
  server.close(() => {
    runtime.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        console.error(
          JSON.stringify({
            event: "rootset_api_shutdown_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        process.exitCode = 1;
      },
    );
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
