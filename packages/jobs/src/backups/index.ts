import { assertAccess } from "@rootset/access";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { withOrg, type PoolClient } from "@rootset/database";
import { backupMutationSet, runMutation } from "@rootset/idempotency";
import {
  BackupDestinationSchema,
  BackupScheduleInputSchema,
  BackupScheduleResultSchema,
  DatabaseBackupSchema,
  getOperation,
  newId,
  RootsetError,
  type Actor,
  type BackupDestination,
  type BackupSchedule,
  type BackupScheduleResult,
  type JsonValue,
} from "@rootset/contracts";
import type { JobsOptions, JobRecord, OperationContext } from "../types.js";
import {
  DurableQueue,
  JobCancelled,
  LeaseLost,
  snapshotTransaction,
} from "../queue.js";
import {
  backupKeyId,
  writeBackupPackage,
  type BackupManifest,
} from "./format.js";
import { databaseSnapshot } from "./snapshot.js";
import { nextBackupRuns, latestBackupRun } from "./schedule.js";

export interface BackupConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  encryptionKey: Buffer;
  tempDirectory?: string;
  maxBytes?: number;
  minimumFreeBytes?: number;
  forcePathStyle?: boolean;
}
interface ScheduleRow {
  database_id: string;
  org_id: string;
  version: number;
  enabled: boolean;
  bucket: string;
  prefix: string;
  cron: string;
  timezone: string;
  backend_id: string;
  next_run_at: Date | null;
  tested_at: Date | null;
  updated_at: Date;
}
interface RunRow {
  id: string;
  org_id: string;
  database_id: string;
  job_id: string | null;
  kind: "backup" | "destination_test" | "skipped";
  trigger: "manual" | "schedule";
  schedule_version: number | null;
  scheduled_at: Date;
  bucket: string;
  prefix: string;
  backend_id: string;
  published: boolean;
  result: JsonValue | null;
}
const iso = (value: Date | null | undefined) =>
  value ? value.toISOString() : null;
const scheduleView = (row: ScheduleRow): BackupSchedule => ({
  databaseId: row.database_id,
  version: row.version,
  enabled: row.enabled,
  bucket: row.bucket,
  prefix: row.prefix,
  cron: row.cron,
  timezone: row.timezone,
  backendId: row.backend_id,
  nextRunAt: iso(row.next_run_at),
  testedAt: iso(row.tested_at),
  updatedAt: row.updated_at.toISOString(),
});
export const backupJobKinds = ["database_backup", "backup_destination_test"];
export const backupOperations = new Set([
  "getBackupSchedule",
  "saveBackupSchedule",
  "previewBackupSchedule",
  "listDatabaseBackups",
  "runDatabaseBackup",
  "testBackupDestination",
]);
export function backupBackendId(config: BackupConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        endpoint: new URL(config.endpoint).toString(),
        region: config.region,
        keyId: backupKeyId(config.encryptionKey),
        pathStyle: config.forcePathStyle ?? true,
      }),
    )
    .digest("hex");
}
export class DatabaseBackups {
  readonly backendId: string | null;
  private readonly objects: S3Client | undefined;
  private lastCleanup = 0;
  constructor(
    private readonly options: JobsOptions,
    private readonly queue: DurableQueue,
  ) {
    const config = this.config;
    this.backendId = config ? backupBackendId(config) : null;
    this.objects = config
      ? new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          forcePathStyle: config.forcePathStyle ?? true,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        })
      : undefined;
  }
  private get config() {
    return this.options.config.backups;
  }
  close() {
    this.objects?.destroy();
  }
  private async lock(client: PoolClient, databaseId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `rootset:backup:${databaseId}`,
    ]);
  }
  private async backend(client: PoolClient): Promise<string | null> {
    const workers = (
      await client.query<{ backup_backend_id: string }>(
        "SELECT DISTINCT backup_backend_id FROM rootset_control.worker_heartbeats WHERE state='ready' AND heartbeat_at>now()-interval '30 seconds' AND backup_backend_id IS NOT NULL",
      )
    ).rows;
    return workers.length === 1 ? workers[0]!.backup_backend_id : null;
  }
  private async requireBackend(
    client: PoolClient,
    expected?: string,
  ): Promise<string> {
    const backend = await this.backend(client);
    if (!backend)
      throw new RootsetError(
        "DEPENDENCY_UNAVAILABLE",
        "A backup-enabled worker with consistent configuration must be online",
        503,
      );
    if (expected && backend !== expected)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "The worker backup destination or encryption key changed. Test the destination and save the schedule again",
        409,
      );
    return backend;
  }
  private async getSchedule(client: PoolClient, databaseId: string) {
    return (
      await client.query<ScheduleRow>(
        "SELECT * FROM rootset_control.backup_schedules WHERE database_id=$1",
        [databaseId],
      )
    ).rows[0];
  }
  private async result(
    client: PoolClient,
    databaseId: string,
  ): Promise<BackupScheduleResult> {
    const row = await this.getSchedule(client, databaseId);
    const backendId = await this.backend(client);
    return BackupScheduleResultSchema.parse({
      schedule: row ? scheduleView(row) : null,
      worker: {
        available: backendId !== null,
        backendId,
        matchesSchedule: !row || row.backend_id === backendId,
      },
      nextRuns: row?.enabled ? nextBackupRuns(row) : [],
    });
  }
  async execute(
    operationId: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: OperationContext,
  ): Promise<unknown> {
    for (const scope of getOperation(operationId).scopes)
      assertAccess(actor, {
        scope,
        orgId: String(input.orgId),
        roles: ["admin"],
      });
    const run = async (client: PoolClient) => {
      const work = () =>
        this.dispatch(operationId, actor, input, client, context);
      if (!backupMutationSet.has(operationId)) return work();
      if (!context.idempotencyKey || !this.options.config.idempotencySecret)
        throw new RootsetError(
          "CONFIGURATION_INVALID",
          "Backup mutation replay is not configured",
          500,
        );
      return runMutation(
        client,
        actor,
        operationId,
        input,
        context.idempotencyKey,
        this.options.config.idempotencySecret,
        async () => getOperation(operationId).outputSchema.parse(await work()),
      );
    };
    return context.client
      ? run(context.client)
      : withOrg(this.queue.pool, actor.orgId, run);
  }
  private async dispatch(
    operationId: string,
    actor: Actor,
    input: Record<string, unknown>,
    client: PoolClient,
    context: OperationContext,
  ): Promise<unknown> {
    const databaseId = String(input.databaseId);
    if (
      !(
        await client.query(
          "SELECT 1 FROM rootset_control.databases WHERE id=$1 AND org_id=$2 AND state='active'",
          [databaseId, actor.orgId],
        )
      ).rowCount
    )
      throw new RootsetError(
        "RESOURCE_NOT_FOUND",
        "Database was not found",
        404,
      );
    if (operationId === "getBackupSchedule")
      return this.result(client, databaseId);
    if (operationId === "previewBackupSchedule")
      return {
        nextRuns: nextBackupRuns({
          cron: String(input.cron),
          timezone: String(input.timezone),
        }),
      };
    if (operationId === "listDatabaseBackups")
      return this.list(actor, input, client);
    await this.lock(client, databaseId);
    const existing = await this.getSchedule(client, databaseId);
    if (operationId === "saveBackupSchedule") {
      const value = BackupScheduleInputSchema.parse(
        Object.fromEntries(
          Object.entries(input).filter(
            ([key]) => !["orgId", "databaseId"].includes(key),
          ),
        ),
      );
      if (value.expectedVersion !== (existing?.version ?? 0))
        throw new RootsetError(
          "ROW_VERSION_CONFLICT",
          "The backup schedule changed. Reload before saving",
          409,
        );
      const next = nextBackupRuns(value, new Date(), 1)[0]!;
      const backend =
        (await this.backend(client)) ??
        (!value.enabled && existing
          ? existing.backend_id
          : await this.requireBackend(client));
      const tested = (
        await client.query<{ completed_at: Date }>(
          "SELECT completed_at FROM rootset_control.database_backups WHERE database_id=$1 AND kind='destination_test' AND bucket=$2 AND prefix=$3 AND backend_id=$4 AND published ORDER BY completed_at DESC LIMIT 1",
          [databaseId, value.bucket, value.prefix, backend],
        )
      ).rows[0];
      if (value.enabled && !tested)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Test this destination successfully before enabling automatic backups",
          400,
        );
      await client.query(
        `INSERT INTO rootset_control.backup_schedules(database_id,org_id,bucket,prefix,cron,timezone,enabled,backend_id,next_run_at,tested_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(database_id) DO UPDATE SET bucket=excluded.bucket,prefix=excluded.prefix,cron=excluded.cron,timezone=excluded.timezone,enabled=excluded.enabled,backend_id=excluded.backend_id,next_run_at=excluded.next_run_at,tested_at=excluded.tested_at,version=rootset_control.backup_schedules.version+1,updated_at=now()`,
        [
          databaseId,
          actor.orgId,
          value.bucket,
          value.prefix,
          value.cron,
          value.timezone,
          value.enabled,
          backend,
          value.enabled ? next : null,
          tested?.completed_at ?? null,
        ],
      );
      await client.query(
        `WITH pending AS (
        SELECT j.id FROM rootset_control.jobs j JOIN rootset_control.database_backups b ON b.job_id=j.id
        WHERE b.database_id=$1 AND b.trigger='schedule' AND b.schedule_version<>$2 AND NOT b.published AND j.state IN ('queued','running')
        FOR UPDATE OF j SKIP LOCKED
      ) UPDATE rootset_control.jobs j SET cancel_requested=true,
        state=CASE WHEN j.state='queued' THEN 'cancelled' ELSE j.state END,
        stage=CASE WHEN j.state='queued' THEN 'cancelled' ELSE j.stage END,
        completed_at=CASE WHEN j.state='queued' THEN now() ELSE j.completed_at END,updated_at=now()
        FROM pending WHERE j.id=pending.id`,
        [databaseId, (existing?.version ?? 0) + 1],
      );
      await client.query(
        "INSERT INTO rootset_control.resource_history(org_id,database_id,resource_id,operation,before_value,after_value,actor,context) VALUES($1,$2,$2,'database.backup_schedule.update',$3,$4,$5,$6)",
        [
          actor.orgId,
          databaseId,
          existing ? scheduleView(existing) : null,
          value,
          actor,
          { source: context.source ?? "rest", requestId: context.requestId },
        ],
      );
      return this.result(client, databaseId);
    }
    const destination =
      operationId === "testBackupDestination"
        ? BackupDestinationSchema.parse({
            bucket: input.bucket,
            prefix: input.prefix,
          })
        : existing;
    if (!destination)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Save a backup destination first",
        400,
      );
    const backend = await this.requireBackend(
      client,
      operationId === "runDatabaseBackup" ? existing?.backend_id : undefined,
    );
    if (operationId === "runDatabaseBackup" && !existing?.tested_at)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Test the saved backup destination first",
        400,
      );
    const job = await this.enqueue(
      client,
      actor,
      databaseId,
      destination,
      backend,
      operationId === "testBackupDestination" ? "destination_test" : "backup",
      "manual",
      new Date(),
      context.idempotencyKey!,
    );
    return {
      jobId: job.id,
      state: job.state,
      statusUrl: `/v1/orgs/${actor.orgId}/jobs/${job.id}`,
    };
  }
  private async enqueue(
    client: PoolClient,
    actor: Actor,
    databaseId: string,
    destination: BackupDestination,
    backendId: string,
    kind: "backup" | "destination_test",
    trigger: "manual" | "schedule",
    scheduledAt: Date,
    key: string,
    scheduleVersion?: number,
  ) {
    if (kind === "backup") {
      const active = await client.query(
        "SELECT 1 FROM rootset_control.database_backups b JOIN rootset_control.jobs j ON j.id=b.job_id WHERE b.database_id=$1 AND b.kind='backup' AND j.state IN ('queued','running') LIMIT 1",
        [databaseId],
      );
      if (active.rowCount)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "A backup for this database is already queued or running",
          409,
        );
    }
    const job = await this.queue.enqueue(
      actor,
      kind === "backup" ? "runDatabaseBackup" : "testBackupDestination",
      kind === "backup" ? "database_backup" : "backup_destination_test",
      { type: "database", id: databaseId },
      {
        databaseId,
        backendId,
        bucket: destination.bucket,
        prefix: destination.prefix,
        trigger,
        scheduleVersion: scheduleVersion ?? null,
        scheduledAt: scheduledAt.toISOString(),
        maxRuntimeSeconds: 3600,
      },
      key,
      client,
    );
    await client.query(
      `INSERT INTO rootset_control.database_backups(id,org_id,database_id,job_id,kind,trigger,schedule_version,scheduled_at,bucket,prefix,backend_id)
      VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
      [
        job.id,
        actor.orgId,
        databaseId,
        kind,
        trigger,
        scheduleVersion ?? null,
        scheduledAt,
        destination.bucket,
        destination.prefix,
        backendId,
      ],
    );
    return job;
  }
  private async list(
    actor: Actor,
    input: Record<string, unknown>,
    client: PoolClient,
  ) {
    const paging = this.options.config.metadataPaging;
    if (!paging) throw new Error("Backup metadata paging is unavailable");
    const request = {
      order: "desc" as const,
      resource: `database:${String(input.databaseId)}:backups`,
      limit: typeof input.limit === "number" ? input.limit : 25,
      cursor: typeof input.cursor === "string" ? input.cursor : undefined,
    };
    const position = paging.read(actor, request);
    const rows = (
      await client.query(
        `SELECT b.*,j.state,j.stage,j.attempt,j.error,b.started_at AS attempt_started_at,j.completed_at AS job_completed_at
      FROM rootset_control.database_backups b LEFT JOIN rootset_control.jobs j ON j.id=b.job_id
      WHERE b.database_id=$1 AND ($2::text IS NULL OR b.id<$2) ORDER BY b.id DESC LIMIT $3`,
        [input.databaseId, position.afterId, position.limit + 1],
      )
    ).rows;
    return paging.paginate(
      rows.map((row) =>
        DatabaseBackupSchema.parse({
          id: row.id,
          jobId: row.job_id,
          kind: row.kind,
          trigger: row.trigger,
          state:
            row.kind === "skipped"
              ? "skipped"
              : row.published
                ? "succeeded"
                : row.state,
          stage: row.published ? "succeeded" : (row.stage ?? "skipped"),
          attempt: row.attempt ?? 0,
          scheduledAt: iso(row.scheduled_at),
          skippedUntil: iso(row.skipped_until),
          snapshotAt: iso(row.snapshot_at),
          startedAt: iso(row.attempt_started_at),
          completedAt: iso(row.completed_at ?? row.job_completed_at),
          bucket: row.bucket,
          objectKey: row.object_key,
          sizeBytes: row.byte_length === null ? null : Number(row.byte_length),
          checksum: row.checksum,
          tableCount: row.table_count,
          rowCount: row.row_count === null ? null : Number(row.row_count),
          error: row.error?.message ?? null,
          note: row.note,
        }),
      ),
      actor,
      request,
    );
  }
  async scheduleDue(orgId: string, now = new Date()): Promise<boolean> {
    if (!this.config || !this.backendId) return false;
    return withOrg(this.queue.workerPool, orgId, async (client) => {
      const schedules = (
        await client.query<ScheduleRow>(
          `SELECT s.* FROM rootset_control.backup_schedules s JOIN rootset_control.databases d ON d.id=s.database_id
        WHERE s.enabled AND s.next_run_at<=$1 AND s.backend_id=$2 AND d.state='active' ORDER BY s.next_run_at LIMIT 10`,
          [now, this.backendId],
        )
      ).rows;
      for (const candidate of schedules) {
        await this.lock(client, candidate.database_id);
        const schedule = (
          await client.query<ScheduleRow>(
            "SELECT * FROM rootset_control.backup_schedules WHERE database_id=$1 AND enabled AND next_run_at<=$2 AND backend_id=$3 FOR UPDATE",
            [candidate.database_id, now, this.backendId],
          )
        ).rows[0];
        if (!schedule) continue;
        const latest = latestBackupRun(schedule, now);
        const next = nextBackupRuns(schedule, now, 1)[0]!;
        const active = (
          await client.query(
            "SELECT 1 FROM rootset_control.database_backups b JOIN rootset_control.jobs j ON j.id=b.job_id WHERE b.database_id=$1 AND b.kind='backup' AND j.state IN ('queued','running') LIMIT 1",
            [schedule.database_id],
          )
        ).rowCount;
        if (active || latest.getTime() > schedule.next_run_at!.getTime()) {
          const missedUntil = active
            ? latest
            : latestBackupRun(schedule, new Date(latest.getTime() - 1));
          await client.query(
            `INSERT INTO rootset_control.database_backups(id,org_id,database_id,kind,trigger,schedule_version,scheduled_at,skipped_until,bucket,prefix,backend_id,note,completed_at)
            VALUES($1,$2,$3,'skipped','schedule',$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              newId(),
              orgId,
              schedule.database_id,
              schedule.version,
              schedule.next_run_at,
              missedUntil,
              schedule.bucket,
              schedule.prefix,
              schedule.backend_id,
              active
                ? "A previous backup was still queued or running"
                : "Worker missed this schedule range; one current catch-up backup was queued",
              now,
            ],
          );
        }
        if (!active) {
          const actor: Actor = {
            kind: "operator",
            id: `database-backup:${schedule.database_id}`,
            orgId,
            role: "admin",
            scopes: ["backups:manage"],
          };
          await this.enqueue(
            client,
            actor,
            schedule.database_id,
            schedule,
            schedule.backend_id,
            "backup",
            "schedule",
            latest,
            `backup:${schedule.database_id}:${schedule.version}:${latest.toISOString()}`,
            schedule.version,
          );
        }
        await client.query(
          "UPDATE rootset_control.backup_schedules SET next_run_at=$2 WHERE database_id=$1",
          [schedule.database_id, next],
        );
      }
      return schedules.length > 0;
    });
  }
  async committedResult(job: JobRecord): Promise<JsonValue | undefined> {
    if (!backupJobKinds.includes(job.kind)) return undefined;
    return withOrg(
      this.queue.workerPool,
      job.org_id,
      async (client) =>
        (
          await client.query<{ result: JsonValue }>(
            "SELECT result FROM rootset_control.database_backups WHERE id=$1 AND published",
            [job.id],
          )
        ).rows[0]?.result,
    );
  }
  private async check(job: JobRecord, run: RunRow): Promise<void> {
    await this.queue.fenced(job, async (client) => {
      const database = (
        await client.query(
          "SELECT state FROM rootset_control.databases WHERE id=$1",
          [run.database_id],
        )
      ).rows[0];
      if (!database || database.state !== "active") throw new JobCancelled();
      if (run.trigger === "schedule") {
        const schedule = await this.getSchedule(client, run.database_id);
        if (
          !schedule?.enabled ||
          schedule.version !== run.schedule_version ||
          schedule.backend_id !== this.backendId
        )
          throw new JobCancelled();
      }
    });
    if (run.trigger === "manual" && this.options.authorise)
      await this.options.authorise(job.actor, job.operation_id, {
        databaseId: run.database_id,
      });
  }
  async run(job: JobRecord): Promise<JsonValue> {
    if (!this.config || !this.objects || !this.backendId)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Backup storage is not configured on this worker",
        500,
      );
    const prior = await this.committedResult(job);
    if (prior !== undefined) return prior;
    const run = await withOrg(
      this.queue.workerPool,
      job.org_id,
      async (client) =>
        (
          await client.query<RunRow>(
            "SELECT * FROM rootset_control.database_backups WHERE id=$1",
            [job.id],
          )
        ).rows[0],
    );
    if (
      !run ||
      !this.queue.authenticInput(job) ||
      run.job_id !== job.id ||
      job.target_type !== "database" ||
      (run.kind === "backup"
        ? job.kind !== "database_backup" ||
          job.operation_id !== "runDatabaseBackup"
        : job.kind !== "backup_destination_test" ||
          job.operation_id !== "testBackupDestination") ||
      run.database_id !== job.target_id ||
      run.org_id !== job.actor.orgId ||
      run.backend_id !== this.backendId ||
      job.input.backendId !== this.backendId ||
      run.bucket !== job.input.bucket ||
      run.prefix !== job.input.prefix ||
      run.trigger !== job.input.trigger ||
      run.schedule_version !== job.input.scheduleVersion ||
      run.scheduled_at.toISOString() !== job.input.scheduledAt
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Backup job provenance does not match its durable run",
        403,
      );
    if (
      run.trigger === "schedule" &&
      (job.actor.kind !== "operator" ||
        job.actor.id !== `database-backup:${run.database_id}`)
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Scheduled backup authority is invalid",
        403,
      );
    await this.check(job, run);
    await this.queue.fenced(job, (client) =>
      client.query(
        "UPDATE rootset_control.database_backups SET started_at=coalesce(started_at,now()) WHERE id=$1",
        [run.id],
      ),
    );
    try {
      return run.kind === "destination_test"
        ? await this.test(job, run)
        : await this.backup(job, run);
    } catch (error) {
      if (
        error instanceof RootsetError ||
        error instanceof JobCancelled ||
        error instanceof LeaseLost
      )
        throw error;
      const name =
        error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "";
      if (
        [
          "AccessDenied",
          "Forbidden",
          "InvalidAccessKeyId",
          "SignatureDoesNotMatch",
          "NoSuchBucket",
          "ExpiredToken",
        ].includes(name)
      )
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Backup storage rejected the destination. Check the bucket, worker credentials and permissions",
          400,
        );
      throw new RootsetError(
        "UPSTREAM_UNAVAILABLE",
        "The backup could not complete. Storage or the database may be unavailable; the worker will retry within its attempt limit",
        503,
      );
    }
  }
  private remaining(job: JobRecord) {
    return Math.max(1, (job.deadline ?? Date.now() + 3600000) - Date.now());
  }
  private async test(job: JobRecord, run: RunRow): Promise<JsonValue> {
    const key = [
      run.prefix,
      ".rootset-tests",
      run.database_id,
      `${job.id}-${job.lease_token}`,
    ]
      .filter(Boolean)
      .join("/");
    const payload = randomBytes(64);
    const request = {
      abortSignal: AbortSignal.timeout(Math.min(30000, this.remaining(job))),
    };
    try {
      await this.objects!.send(
        new PutObjectCommand({ Bucket: run.bucket, Key: key, Body: payload }),
        request,
      );
      const result = await this.objects!.send(
        new GetObjectCommand({ Bucket: run.bucket, Key: key }),
        request,
      );
      if (
        !result.Body ||
        !Buffer.from(await result.Body.transformToByteArray()).equals(payload)
      )
        throw new RootsetError(
          "UPSTREAM_UNAVAILABLE",
          "The backup destination failed its read-back verification",
          503,
        );
    } finally {
      await this.objects!.send(
        new DeleteObjectCommand({ Bucket: run.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
    }
    await this.check(job, run);
    const result: JsonValue = {
      destinationVerified: true,
      bucket: run.bucket,
      prefix: run.prefix,
    };
    await this.queue.fenced(job, async (client) => {
      await client.query(
        "UPDATE rootset_control.database_backups SET published=true,result=$2,completed_at=now() WHERE id=$1",
        [run.id, result],
      );
      await client.query(
        "UPDATE rootset_control.backup_schedules SET tested_at=now() WHERE database_id=$1 AND bucket=$2 AND prefix=$3 AND backend_id=$4",
        [run.database_id, run.bucket, run.prefix, run.backend_id],
      );
    });
    return result;
  }
  private async backup(job: JobRecord, run: RunRow): Promise<JsonValue> {
    await this.queue.checkpoint(job, {}, { unit: "tables" }, "extracting");
    const temporary = await mkdtemp(
      join(this.config!.tempDirectory ?? tmpdir(), "rootset-backup-"),
    );
    const path = join(temporary, "package.rootset-backup");
    try {
      let manifest!: BackupManifest;
      const file = await snapshotTransaction(
        this.queue.workerPool,
        job.org_id,
        run.database_id,
        async (client) => {
          const snapshot = await databaseSnapshot({
            client,
            storage: this.options.storage,
            actor: job.actor,
            databaseId: run.database_id,
            scheduledAt: run.scheduled_at.toISOString(),
            rootsetVersion: this.options.config.rootsetVersion ?? "development",
            check: () => this.check(job, run),
            afterTable: () =>
              this.options.config.failpoint?.("backup.afterTable", job.id) ??
              Promise.resolve(),
          });
          manifest = snapshot.manifest;
          return writeBackupPackage({
            path,
            key: this.config!.encryptionKey,
            entries: snapshot.entries,
            manifest,
            check: () => this.check(job, run),
            maxBytes: this.config!.maxBytes,
            minimumFreeBytes: this.config!.minimumFreeBytes,
          });
        },
      );
      await this.options.config.failpoint?.("backup.afterSnapshot", job.id);
      await this.check(job, run);
      const date = manifest.snapshotAt.slice(0, 10).replaceAll("-", "/");
      const key = [
        run.prefix,
        run.database_id,
        date,
        `${job.id}-${job.lease_token}.rootset-backup`,
      ]
        .filter(Boolean)
        .join("/");
      await this.queue.checkpoint(
        job,
        {},
        { unit: "bytes", total: file.bytes, completed: 0 },
        "uploading",
      );
      const body = createReadStream(path);
      const upload = new Upload({
        client: this.objects!,
        params: {
          Bucket: run.bucket,
          Key: key,
          Body: body,
          ContentType: "application/octet-stream",
          Metadata: {
            "rootset-format": "1",
            "rootset-key-id": file.keyId,
            "rootset-sha256": file.checksum,
          },
        },
        queueSize: 2,
        partSize: 8 * 1024 ** 2,
        leavePartsOnError: false,
      });
      const timer = setTimeout(() => {
        body.destroy(new Error("Backup upload deadline exceeded"));
        void upload.abort();
      }, this.remaining(job));
      try {
        await upload.done();
      } finally {
        clearTimeout(timer);
        body.destroy();
      }
      await this.queue.checkpoint(
        job,
        {},
        { unit: "bytes", total: file.bytes, completed: file.bytes },
        "verifying",
      );
      const uploaded = await this.objects!.send(
        new GetObjectCommand({ Bucket: run.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(this.remaining(job)) },
      );
      if (!uploaded.Body)
        throw new RootsetError(
          "UPSTREAM_UNAVAILABLE",
          "The uploaded backup could not be read back",
          503,
        );
      const hash = createHash("sha256");
      let bytes = 0;
      let checkedAt = Date.now();
      for await (const chunk of uploaded.Body as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        hash.update(chunk);
        if (Date.now() - checkedAt > 2000) {
          await this.check(job, run);
          checkedAt = Date.now();
        }
      }
      if (bytes !== file.bytes || hash.digest("hex") !== file.checksum)
        throw new RootsetError(
          "UPSTREAM_UNAVAILABLE",
          "The uploaded backup failed checksum verification",
          503,
        );
      await this.check(job, run);
      await this.options.config.failpoint?.("backup.beforePublish", job.id);
      await this.check(job, run);
      const rowCount = manifest.tables.reduce(
        (sum, table) => sum + table.rowCount,
        0,
      );
      const result: JsonValue = {
        backupId: run.id,
        bucket: run.bucket,
        objectKey: key,
        sizeBytes: file.bytes,
        checksum: file.checksum,
        snapshotAt: manifest.snapshotAt,
        tableCount: manifest.tables.length,
        rowCount,
        formatVersion: 1,
        keyId: file.keyId,
      };
      await this.queue.fenced(job, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
          [run.database_id],
        );
        if (
          !(
            await client.query(
              "SELECT 1 FROM rootset_control.databases WHERE id=$1 AND state='active'",
              [run.database_id],
            )
          ).rowCount
        )
          throw new JobCancelled();
        if (run.trigger === "schedule") {
          const current = (
            await client.query<ScheduleRow>(
              "SELECT * FROM rootset_control.backup_schedules WHERE database_id=$1 FOR SHARE",
              [run.database_id],
            )
          ).rows[0];
          if (!current?.enabled || current.version !== run.schedule_version)
            throw new JobCancelled();
        }
        await client.query(
          "UPDATE rootset_control.database_backups SET published=true,result=$2,snapshot_at=$3,object_key=$4,byte_length=$5,checksum=$6,table_count=$7,row_count=$8,completed_at=now() WHERE id=$1",
          [
            run.id,
            result,
            manifest.snapshotAt,
            key,
            file.bytes,
            file.checksum,
            manifest.tables.length,
            rowCount,
          ],
        );
      });
      await this.options.config.failpoint?.("backup.afterPublish", job.id);
      return result;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async cleanupTemporaryFiles(now = Date.now()) {
    if (!this.config || now - this.lastCleanup < 3600000) return;
    this.lastCleanup = now;
    const root = this.config.tempDirectory ?? tmpdir();
    for (const name of await readdir(root)) {
      if (!/^rootset-backup-[A-Za-z0-9]{6}$/.test(name)) continue;
      const path = join(root, name);
      const stat = await lstat(path);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (typeof process.getuid !== "function" ||
          stat.uid === process.getuid()) &&
        stat.mtimeMs < now - 48 * 3600000
      )
        await rm(path, { recursive: true, force: true });
    }
  }
}
