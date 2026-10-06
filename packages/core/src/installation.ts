import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { RootsetError } from "@rootset/contracts";
import { migrationStatus, type Pool } from "@rootset/database";
import type { EmailOutbox } from "@rootset/email";
import { OperationalObserver } from "@rootset/observability";
import type { Config } from "./config.js";

export class InstallationService {
  constructor(
    readonly pool: Pool,
    readonly config: Config,
    readonly outbox: EmailOutbox,
    readonly observer = new OperationalObserver({
      operatorPool: pool,
      pools: { identity: pool },
    }),
  ) {}
  async status() {
    const dependencies: Record<string, "healthy" | "degraded" | "unavailable"> =
      {};
    let migrationVersion = "",
      workerHeartbeatAt: string | null = null;
    try {
      const migrations = await migrationStatus(this.pool);
      migrationVersion = migrations.version;
      dependencies.postgresql = migrations.complete ? "healthy" : "degraded";
      const h = (
        await this.pool.query<{ heartbeat_at: Date }>(
          "SELECT heartbeat_at FROM rootset_control.worker_heartbeats WHERE state='ready' ORDER BY heartbeat_at DESC LIMIT 1",
        )
      ).rows[0];
      workerHeartbeatAt = h?.heartbeat_at.toISOString() ?? null;
      dependencies.worker =
        h && Date.now() - h.heartbeat_at.getTime() <= 30000
          ? "healthy"
          : "unavailable";
    } catch {
      dependencies.postgresql = "unavailable";
      dependencies.worker = "unavailable";
    }
    const s3 = new S3Client({
      ...this.config.artifacts,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.artifacts.accessKeyId,
        secretAccessKey: this.config.artifacts.secretAccessKey,
      },
    });
    try {
      await s3.send(
        new HeadBucketCommand({ Bucket: this.config.artifacts.bucket }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      dependencies.objectStorage = "healthy";
    } catch {
      dependencies.objectStorage = "unavailable";
    } finally {
      s3.destroy();
    }
    try {
      await this.outbox.verifyConnection();
      dependencies.smtp = "healthy";
    } catch {
      dependencies.smtp = "unavailable";
    }
    const metrics = await this.observer.metrics();
    return {
      healthy: Object.values(dependencies).every(
        (state) => state === "healthy",
      ),
      version: "0.1.0",
      migrationVersion,
      dependencies,
      workerHeartbeatAt,
      metrics,
    };
  }

  async execute(id: string): Promise<unknown> {
    if (id === "getInstallationStatus") return this.status();
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Unsupported installation operation",
    );
  }
}
