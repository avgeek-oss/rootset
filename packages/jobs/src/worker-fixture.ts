import { createPool } from "@rootset/database";
import { TableStorage } from "@rootset/table-storage";
import { JobsService, type ArtifactConfig } from "./index.js";

if (!process.send)
  throw new Error("The worker fault fixture requires an IPC parent");

process.once(
  "message",
  async (input: {
    orgId: string;
    artifacts: ArtifactConfig;
    pauseAt?: string;
  }) => {
    const pool = createPool(process.env.ROOTSET_TEST_APP_DATABASE_URL!, 3);
    const ddlPool = createPool(process.env.ROOTSET_TEST_DDL_DATABASE_URL!, 3);
    const storage = new TableStorage({
      pool,
      ddlPool,
      cursorSecret: "worker-fixture-cursor-secret-at-least-32-bytes",
    });
    const service = new JobsService({
      pool,
      ddlPool,
      storage,
      authorise: async (actor) => actor,
      config: {
        artifacts: input.artifacts,
        failpoint: async (point, jobId) => {
          if (point === (input.pauseAt ?? "import.afterCommit")) {
            process.send!({ point, jobId });
            await new Promise<void>(() => undefined);
          }
        },
      },
    });
    try {
      await service.runOnce(input.orgId);
      process.send!({ finished: true });
    } finally {
      await Promise.all([pool.end(), ddlPool.end()]);
    }
  },
);
