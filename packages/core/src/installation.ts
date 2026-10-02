import { createHash } from "node:crypto";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  getOperation,
  newId,
  RootsetError,
  DeletionRetentionSchema,
  type DeletionRetentionPatch,
  type CapacityConfigurationPatch,
  type Actor,
} from "@rootset/contracts";
import {
  transaction,
  migrationStatus,
  type Pool,
  type PoolClient,
  type Queryable,
} from "@rootset/database";
import {
  decryptProtected,
  encryptProtected,
  type EmailOutbox,
} from "@rootset/email";
import type { Config } from "./config.js";
import type { OperationContext } from "./index.js";
import { CapacityService } from "@rootset/capacity";
import { OperationalObserver } from "@rootset/observability";
import { runMutation } from "@rootset/idempotency";

export const AdmissionLimitsSchema = z.strictObject({
  principalRequestsPerMinute: z.number().int().min(1).max(100000).default(120),
  organisationRequestsPerMinute: z
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(1200),
  concurrentReads: z.number().int().min(1).max(100).default(10),
  concurrentMutations: z.number().int().min(1).max(50).default(5),
});
export type AdmissionLimits = z.infer<typeof AdmissionLimitsSchema>;
type ConfigurationPatch = {
  deletionRetention?: DeletionRetentionPatch;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    from: string;
    user?: string;
    password?: string;
  };
  objectStorage?: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
};
interface Settings {
  revision: string;
  protected_configuration: string;
  limits: AdmissionLimits;
}

export async function resolveInstallationConfig(
  pool: Pool,
  baseline: Config,
): Promise<{ config: Config; revision: string }> {
  const result = await pool.query<Settings>(
    "SELECT runtime_revision::text AS revision,protected_configuration,limits FROM rootset_control.installation_settings WHERE singleton=true",
  );
  const row = result.rows[0];
  if (!row) return { config: baseline, revision: "0" };
  const patch = decryptProtected<ConfigurationPatch>(
    row.protected_configuration,
    baseline,
  );
  const config = { ...baseline };
  if (patch.smtp)
    config.smtp = {
      host: patch.smtp.host,
      port: patch.smtp.port,
      secure: patch.smtp.secure,
      from: patch.smtp.from,
      auth: patch.smtp.user
        ? { user: patch.smtp.user, pass: patch.smtp.password }
        : undefined,
    };
  if (patch.objectStorage)
    config.artifacts = {
      ...baseline.artifacts,
      ...patch.objectStorage,
      accessKeyId:
        patch.objectStorage.accessKeyId ?? baseline.artifacts.accessKeyId,
      secretAccessKey:
        patch.objectStorage.secretAccessKey ??
        baseline.artifacts.secretAccessKey,
    };
  return { config, revision: row.revision };
}
export class InstallationService {
  constructor(
    readonly pool: Pool,
    readonly config: Config,
    readonly loadedRevision: string,
    readonly outbox: EmailOutbox,
    readonly capacity = new CapacityService(pool),
    readonly observer = new OperationalObserver({
      operatorPool: pool,
      pools: { identity: pool },
    }),
  ) {}
  async deletionRetention(connection: Queryable = this.pool) {
    const row = (
      await connection.query<{ protected_configuration: string }>(
        "SELECT protected_configuration FROM rootset_control.installation_settings WHERE singleton=true",
      )
    ).rows[0];
    const patch = row
      ? decryptProtected<ConfigurationPatch>(
          row.protected_configuration,
          this.config,
        )
      : {};
    return DeletionRetentionSchema.parse(patch.deletionRetention ?? {});
  }
  async admissionLimits(): Promise<AdmissionLimits> {
    const row = (
      await this.pool.query<Settings>(
        "SELECT limits FROM rootset_control.installation_settings WHERE singleton=true",
      )
    ).rows[0];
    return AdmissionLimitsSchema.parse(row?.limits ?? {});
  }
  async configuration(connection: Queryable = this.pool) {
    const row = (
      await connection.query<Settings>(
        "SELECT runtime_revision::text AS revision,limits FROM rootset_control.installation_settings WHERE singleton=true",
      )
    ).rows[0];
    return {
      baseUrl: this.config.baseURL,
      signupEnabled: false,
      smtpConfigured: !!this.config.smtp.host,
      objectStorageConfigured: !!this.config.artifacts.bucket,
      limits: AdmissionLimitsSchema.parse(row?.limits ?? {}),
      operatorRecoveryEnabled: true,
      restartRequired: (row?.revision ?? "0") !== this.loadedRevision,
      storage: await this.capacity.configuration(connection),
      deletionRetention: await this.deletionRetention(connection),
    };
  }
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
    let storage = null;
    try {
      storage = await this.capacity.status();
      dependencies.storageAdmission =
        storage.admission.state === "available" ? "healthy" : "degraded";
    } catch {
      dependencies.storageAdmission = "unavailable";
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
      storage,
      metrics,
    };
  }
  async execute(
    id: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: OperationContext,
  ): Promise<unknown> {
    if (id === "getInstallationStatus") return this.status();
    if (id === "getInstallationConfiguration") return this.configuration();
    if (id === "updateInstallationConfiguration") {
      const parsed = getOperation(id).inputSchema.parse(
        input,
      ) as ConfigurationPatch & {
        limits?: Record<string, number>;
        storage?: CapacityConfigurationPatch;
      };
      const update = async (c: PoolClient) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtext('rootset:installation-settings'))",
        );
        const row = (
          await c.query<Settings>(
            "SELECT revision::text,protected_configuration,limits FROM rootset_control.installation_settings WHERE singleton=true FOR UPDATE",
          )
        ).rows[0];
        const old = row
          ? decryptProtected<ConfigurationPatch>(
              row.protected_configuration,
              this.config,
            )
          : {};
        const patch: ConfigurationPatch = {
          ...old,
          ...(parsed.deletionRetention
            ? {
                deletionRetention: {
                  ...old.deletionRetention,
                  ...parsed.deletionRetention,
                },
              }
            : {}),
          ...(parsed.smtp
            ? { smtp: { ...(old.smtp ?? {}), ...parsed.smtp } }
            : {}),
          ...(parsed.objectStorage
            ? {
                objectStorage: {
                  ...(old.objectStorage ?? {}),
                  ...parsed.objectStorage,
                },
              }
            : {}),
        };
        const limits = AdmissionLimitsSchema.parse({
          ...AdmissionLimitsSchema.parse(row?.limits ?? {}),
          ...parsed.limits,
        });
        if (parsed.storage) await this.capacity.configure(c, parsed.storage);
        const revision = Number(row?.revision ?? 0) + 1;
        await c.query(
          "INSERT INTO rootset_control.installation_settings(singleton,revision,protected_configuration,limits,updated_by,runtime_revision) VALUES(true,$1::bigint,$2,$3,$4,CASE WHEN $5 THEN $1::bigint ELSE 0::bigint END) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,protected_configuration=EXCLUDED.protected_configuration,limits=EXCLUDED.limits,updated_by=EXCLUDED.updated_by,runtime_revision=CASE WHEN $5 THEN EXCLUDED.revision ELSE rootset_control.installation_settings.runtime_revision END,updated_at=now()",
          [
            revision,
            encryptProtected(patch, this.config),
            JSON.stringify(limits),
            actor.id,
            !!(parsed.smtp || parsed.objectStorage),
          ],
        );
        await c.query(
          "INSERT INTO rootset_control.installation_audit(id,actor_id,request_id,revision,changed_sections) VALUES($1,$2,$3,$4,$5)",
          [
            newId(),
            actor.id,
            context.requestId ?? null,
            revision,
            Object.keys(parsed).filter((k) =>
              [
                "limits",
                "smtp",
                "objectStorage",
                "storage",
                "deletionRetention",
              ].includes(k),
            ),
          ],
        );
        return this.configuration(c);
      };
      const mutate = async (client: PoolClient) => {
        const currentOrg = (
          await client.query<{ org: string | null }>(
            "SELECT current_setting('rootset.org_id',true) AS org",
          )
        ).rows[0]?.org;
        if (currentOrg && currentOrg !== actor.orgId)
          throw new RootsetError(
            "ACCESS_DENIED",
            "Installation mutation is outside the active organisation",
            403,
          );
        await client.query("SELECT set_config('rootset.org_id',$1,true)", [
          actor.orgId,
        ]);
        return runMutation(
          client,
          actor,
          id,
          parsed,
          context.idempotencyKey ?? "",
          this.config.keyHashSecret,
          () => update(client),
        );
      };
      return context.approvalClient
        ? mutate(context.approvalClient)
        : transaction(this.pool, mutate);
    }
    if (id === "testEmail") {
      const key = context.idempotencyKey;
      if (!key)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Idempotency-Key is required",
        );
      const messageId = await this.outbox.enqueue(this.pool, {
        template: "installation-test",
        to: String(input.recipient),
        payload: {
          details: "This is a Rootset installation email delivery test.",
        },
        dedupeKey: `installation-test:${createHash("sha256")
          .update(actor.id + ":" + key)
          .digest("hex")}`,
        expiresAt: new Date(Date.now() + 3600000),
      });
      // The job succeeds only after delivery, rather than after adding an outbox row.
      for (let attempt = 0; attempt < 20; attempt++) {
        const row = (
          await this.pool.query<{ state: string; provider_id: string | null }>(
            "SELECT state,provider_id FROM rootset_control.email_outbox WHERE id=$1",
            [messageId],
          )
        ).rows[0];
        if (row?.state === "sent") return { delivered: true, messageId };
        if (row?.state === "failed")
          throw new RootsetError(
            "EMAIL_DELIVERY_FAILED",
            "SMTP rejected or exhausted the message",
            503,
          );
        if (!(await this.outbox.deliverNext())) break;
      }
      throw new RootsetError(
        "EMAIL_DELIVERY_FAILED",
        "SMTP delivery has not completed; retry the job after correcting delivery settings",
        503,
      );
    }
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Unsupported installation operation",
    );
  }
}
