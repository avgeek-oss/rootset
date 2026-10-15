import { createRuntime } from "@rootset/core/runtime";

const runtime = await createRuntime(undefined, { worker: true });
runtime.jobs.config.workerIdFile =
  process.env.ROOTSET_WORKER_ID_FILE ?? "/tmp/rootset-worker-id";
runtime.jobs.config.workerId = process.env.ROOTSET_WORKER_ID;
const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());

try {
  await runtime.jobs.runWorker({ signal: shutdown.signal });
} finally {
  await runtime.close();
}
