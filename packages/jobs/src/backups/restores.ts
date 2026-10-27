import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { withOrg, type PoolClient } from "@rootset/database";
import { assertAccess } from "@rootset/access";
import {
  DatabaseRestoreResultSchema,
  getOperation,
  RestorePreviewSchema,
  RootsetError,
  type Actor,
  type JsonValue,
  type RestorePreview,
} from "@rootset/contracts";
import type { RestoreSource } from "@rootset/table-storage";
import { ownedBackupObject } from "./ownership.js";
import { backupBackendId } from "./index.js";
import { DEFAULT_BACKUP_MAX_BYTES, decryptBackupPackage } from "./format.js";
import { openRestoreArchive } from "./restore-archive.js";
import { DurableQueue } from "../queue.js";
import type { JobRecord, JobsOptions, OperationContext } from "../types.js";

export const restoreJobKinds = ["database_restore_preview", "database_restore"];
interface BackupSource {
  id: string;
  database_id: string;
  backend_id: string;
  bucket: string;
  prefix: string;
  object_key: string;
  checksum: string;
  byte_length: string;
  snapshot_at: Date;
}
function invalid(message: string): never {
  throw new RootsetError("VALIDATION_FAILED", message, 422);
}
function destinationId(actor: Actor, key: string): string {
  const hash = createHash("sha256")
    .update(
      `rootset.restore.destination.v1\0${actor.orgId}\0${actor.kind}\0${actor.id}\0${key}`,
    )
    .digest("hex")
    .slice(0, 32);
  let value = BigInt(`0x${hash}`),
    result = "";
  for (let i = 0; i < 26; i++) {
    result = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(value & 31n)]! + result;
    value >>= 5n;
  }
  return result;
}
export class DatabaseRestores {
  private readonly objects: S3Client | undefined;
  constructor(
    private readonly options: JobsOptions,
    private readonly queue: DurableQueue,
    private readonly authorise: (
      job: JobRecord,
      client?: PoolClient,
    ) => Promise<Actor>,
  ) {
    const config = options.config.backups;
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
  close() {
    this.objects?.destroy();
  }
  private async source(
    client: PoolClient,
    actor: Actor,
    backupId: string,
    lock = false,
  ): Promise<BackupSource> {
    if (lock) {
      const current = (
        await client.query<{ database_id: string }>(
          "SELECT database_id FROM rootset_control.database_backups WHERE id=$1 AND org_id=$2",
          [backupId, actor.orgId],
        )
      ).rows[0];
      if (!current)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "A retained successful backup was not found",
          404,
        );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`rootset:backup:${current.database_id}`],
      );
    }
    const row = (
      await client.query<BackupSource>(
        "SELECT id,database_id,backend_id,bucket,prefix,object_key,checksum,byte_length::text,snapshot_at FROM rootset_control.database_backups WHERE id=$1 AND org_id=$2 AND kind='backup' AND published AND storage_state='available'",
        [backupId, actor.orgId],
      )
    ).rows[0];
    if (!row)
      throw new RootsetError(
        "RESOURCE_NOT_FOUND",
        "A retained successful backup was not found",
        404,
      );
    if (
      !/^[a-f0-9]{64}$/.test(row.checksum) ||
      !/^\d+$/.test(row.byte_length) ||
      BigInt(row.byte_length) < 1n ||
      BigInt(row.byte_length) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      invalid("The backup publication metadata is invalid");
    if (!ownedBackupObject(row))
      invalid("The backup object is outside its published namespace");
    return row;
  }
  private access(actor: Actor, operation: string) {
    for (const scope of getOperation(operation).scopes)
      assertAccess(actor, { scope, orgId: actor.orgId, roles: ["admin"] });
  }
  private async preview(
    client: PoolClient,
    actor: Actor,
    previewId: string,
    backup: BackupSource,
  ): Promise<RestorePreview> {
    const row = (
      await client.query<JobRecord>(
        "SELECT * FROM rootset_control.jobs WHERE id=$1 AND org_id=$2",
        [previewId, actor.orgId],
      )
    ).rows[0];
    if (
      !row ||
      row.kind !== "database_restore_preview" ||
      row.operation_id !== "previewDatabaseRestore" ||
      row.target_type !== "organisation" ||
      row.target_id !== actor.orgId ||
      row.requester_id !== `${actor.kind}:${actor.id}` ||
      row.input.backupId !== backup.id ||
      !this.queue.authenticInput(row) ||
      row.state !== "succeeded"
    )
      invalid("Verify this backup before restoring it");
    const parsed = RestorePreviewSchema.safeParse(row!.result);
    if (
      !parsed.success ||
      parsed.data.backupId !== backup.id ||
      parsed.data.sourceDatabaseId !== backup.database_id ||
      parsed.data.checksum !== backup.checksum ||
      Date.parse(parsed.data.expiresAt) <= Date.now() ||
      row!.input.backendId !== backup.backend_id
    )
      invalid(
        "The restore preview expired or its backup changed. Verify the backup again",
      );
    return parsed.data;
  }
  async enqueue(
    operation: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: OperationContext,
  ) {
    this.access(actor, operation);
    if (!context.client || !context.idempotencyKey)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Restore admission requires an idempotent transaction",
        500,
      );
    const backup = await this.source(
      context.client,
      actor,
      String(input.backupId),
      true,
    );
    const workers = (
      await context.client.query<{ backend: string }>(
        "SELECT DISTINCT backup_backend_id AS backend FROM rootset_control.worker_heartbeats WHERE state='ready' AND heartbeat_at>now()-interval '30 seconds' AND backup_backend_id IS NOT NULL",
      )
    ).rows;
    if (workers.length !== 1 || workers[0]!.backend !== backup.backend_id)
      throw new RootsetError(
        "DEPENDENCY_UNAVAILABLE",
        "A worker with this backup's storage and encryption configuration must be online",
        503,
      );
    if (operation === "restoreDatabaseBackup")
      await this.preview(
        context.client,
        actor,
        String(input.previewId),
        backup,
      );
    const job = await this.queue.enqueue(
      actor,
      operation,
      operation === "previewDatabaseRestore"
        ? restoreJobKinds[0]!
        : restoreJobKinds[1]!,
      { type: "organisation", id: actor.orgId },
      {
        ...input,
        sourceDatabaseId: backup.database_id,
        backendId: backup.backend_id,
        sourceChecksum: backup.checksum,
        ...(operation === "restoreDatabaseBackup"
          ? {
              destinationDatabaseId: destinationId(
                actor,
                context.idempotencyKey,
              ),
            }
          : {}),
        maxRuntimeSeconds: 3600,
      },
      context.idempotencyKey,
      context.client,
    );
    return {
      jobId: job.id,
      state: job.state,
      statusUrl: `/v1/orgs/${actor.orgId}/jobs/${job.id}?workspaceId=${actor.workspaceId ?? actor.orgId}`,
    };
  }
  async prepareRetry(actor: Actor, job: JobRecord, client: PoolClient) {
    this.access(actor, job.operation_id);
    const backup = await this.source(
      client,
      actor,
      String(job.input.backupId),
      true,
    );
    if (
      backup.checksum !== job.input.sourceChecksum ||
      backup.backend_id !== job.input.backendId
    )
      invalid("The published backup changed. Verify it again.");
    if (job.kind === "database_restore")
      await this.preview(client, actor, String(job.input.previewId), backup);
  }
  async committedResult(job: JobRecord): Promise<JsonValue | undefined> {
    if (job.kind !== "database_restore" || !this.queue.authenticInput(job))
      return undefined;
    const row = await withOrg(
      this.queue.workerPool,
      job.org_id,
      async (client) =>
        (
          await client.query<{ result: JsonValue }>(
            "SELECT result FROM rootset_control.restore_results WHERE job_id=$1 AND org_id=$2 AND source_backup_id=$3 AND source_checksum=$4 AND database_id=$5",
            [
              job.id,
              job.org_id,
              job.input.backupId,
              job.input.sourceChecksum,
              job.input.destinationDatabaseId,
            ],
          )
        ).rows[0],
    );
    return row?.result;
  }
  private async check(job: JobRecord, client?: PoolClient): Promise<Actor> {
    const actor = await this.authorise(job, client);
    this.access(actor, job.operation_id);
    if (!client) await this.queue.fenced(job, async () => undefined);
    return actor;
  }
  async run(job: JobRecord): Promise<JsonValue> {
    const prior = await this.committedResult(job);
    if (prior !== undefined) return prior;
    const config = this.options.config.backups;
    if (!config || !this.objects)
      throw new RootsetError(
        "DEPENDENCY_UNAVAILABLE",
        "Backup restore is not configured on this worker",
        503,
      );
    if (
      !this.queue.authenticInput(job) ||
      !restoreJobKinds.includes(job.kind) ||
      job.operation_id !==
        (job.kind === "database_restore_preview"
          ? "previewDatabaseRestore"
          : "restoreDatabaseBackup") ||
      job.target_type !== "organisation" ||
      job.target_id !== job.org_id ||
      job.input.backendId !== backupBackendId(config) ||
      (job.kind === "database_restore" &&
        job.input.destinationDatabaseId !==
          destinationId(job.actor, job.idempotency_key))
    )
      invalid("The restore request changed after admission");
    const actor = await this.check(job);
    const backup = await withOrg(
      this.queue.workerPool,
      job.org_id,
      async (client) => {
        const source = await this.source(
          client,
          actor,
          String(job.input.backupId),
        );
        if (
          source.checksum !== job.input.sourceChecksum ||
          source.backend_id !== job.input.backendId ||
          source.database_id !== job.input.sourceDatabaseId
        )
          invalid("The published backup changed after admission");
        if (job.kind === "database_restore")
          await this.preview(
            client,
            actor,
            String(job.input.previewId),
            source,
          );
        return source;
      },
    );
    const maximum = config.maxBytes ?? DEFAULT_BACKUP_MAX_BYTES,
      size = Number(backup.byte_length);
    if (size > maximum)
      throw new RootsetError(
        "PAYLOAD_TOO_LARGE",
        "The backup exceeds this worker's configured size limit",
        413,
      );
    const temporary = await mkdtemp(
      join(config.tempDirectory ?? tmpdir(), "rootset-restore-"),
    );
    try {
      const space = await statfs(temporary),
        minimum = config.minimumFreeBytes ?? 1024 ** 3;
      if (space.bavail * space.bsize < minimum + size * 2)
        throw new RootsetError(
          "UPSTREAM_UNAVAILABLE",
          "The restore spool has insufficient free disk space",
          503,
        );
      const check = async () => {
        await this.check(job);
      };
      await this.queue.checkpoint(
        job,
        {},
        { completed: 0, total: size, unit: "bytes" },
        "downloading_backup",
      );
      const encrypted = join(temporary, "source.rootset-backup"),
        archivePath = join(temporary, "verified.zip");
      const response = await this.objects.send(
        new GetObjectCommand({ Bucket: backup.bucket, Key: backup.object_key }),
        { abortSignal: AbortSignal.timeout(300_000) },
      );
      if (!response.Body) invalid("The stored backup has no readable body");
      if (response.ContentLength !== size) {
        await response.Body.transformToWebStream().cancel();
        invalid("The stored backup does not match its published size");
      }
      const hash = createHash("sha256");
      let bytes = 0,
        checked = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          void (async () => {
            bytes += chunk.length;
            if (bytes > size)
              invalid("The stored backup exceeds its published size");
            if (bytes - checked >= 8 * 1024 ** 2) {
              await check();
              const disk = await statfs(temporary);
              if (disk.bavail * disk.bsize < minimum + size)
                throw new RootsetError(
                  "UPSTREAM_UNAVAILABLE",
                  "The restore spool has insufficient free disk space",
                  503,
                );
              await this.queue.checkpoint(
                job,
                {},
                { completed: bytes, total: size, unit: "bytes" },
                "downloading_backup",
              );
              checked = bytes;
            }
            hash.update(chunk);
            callback(null, chunk);
          })().catch((error) => callback(error));
        },
      });
      await pipeline(
        response.Body.transformToWebStream(),
        meter,
        createWriteStream(encrypted, { flags: "wx", mode: 0o600 }),
      );
      if (bytes !== size || hash.digest("hex") !== backup.checksum)
        invalid("The stored backup checksum does not match its publication");
      await this.queue.checkpoint(
        job,
        {},
        { completed: size, total: size, unit: "bytes" },
        "verifying_package",
      );
      try {
        await decryptBackupPackage(
          encrypted,
          archivePath,
          config.encryptionKey,
          { check },
        );
      } catch (error) {
        if (error instanceof RootsetError) throw error;
        invalid(
          "The backup package could not be authenticated with this worker's encryption key",
        );
      }
      const migrations = await withOrg(
        this.queue.workerPool,
        job.org_id,
        async (client) =>
          new Map(
            (
              await client.query<{ name: string; digest: string }>(
                "SELECT name,digest FROM rootset_control.migrations",
              )
            ).rows.map((row) => [row.name, row.digest]),
          ),
      );
      const archive = await openRestoreArchive({
        path: archivePath,
        orgId: job.org_id,
        databaseId: backup.database_id,
        maximumBytes: maximum,
        migrations,
        check,
      });
      try {
        if (
          Date.parse(archive.manifest.snapshotAt) !==
          backup.snapshot_at.getTime()
        )
          invalid("The package snapshot does not match its publication");
        if (job.kind === "database_restore_preview")
          return await this.summarize(job, backup, archive.source);
        const result = await this.options.storage.restoreDatabase(
          actor,
          {
            databaseId: String(job.input.destinationDatabaseId),
            name: String(job.input.name),
            backupId: backup.id,
            checksum: backup.checksum,
            snapshotAt: backup.snapshot_at.toISOString(),
            jobId: job.id,
          },
          archive.source,
          {
            context: {
              source: "schema",
              jobId: job.id,
              jobFence: { jobId: job.id, leaseToken: job.lease_token! },
              beforePublish: async (client) => {
                if (!client)
                  throw new Error(
                    "Restore publication requires its database transaction",
                  );
                await this.check(job, client);
              },
            },
            progress: async (stage, completed, total, unit) => {
              await this.queue.checkpoint(
                job,
                {},
                { completed, ...(total === null ? {} : { total }), unit },
                stage,
              );
              await this.options.config.failpoint?.(`restore.${stage}`, job.id);
            },
          },
        );
        await this.options.config.failpoint?.("restore.afterPublish", job.id);
        return DatabaseRestoreResultSchema.parse(result);
      } finally {
        archive.close();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  private async summarize(
    job: JobRecord,
    backup: BackupSource,
    source: RestoreSource,
  ): Promise<RestorePreview> {
    let rowCount = 0;
    const tables = source.tables.filter((table) => table.state === "active");
    const total = tables.reduce((sum, table) => sum + table.rowCount, 0);
    for (const table of tables)
      for await (const rows of source.rows(table.id)) {
        rowCount += rows.length;
        await this.queue.checkpoint(
          job,
          {},
          { completed: rowCount, total, unit: "rows" },
          "checking_records",
        );
      }
    const counts = {
      commentCount: 0,
      historyEvents: 0,
      mutationCount: 0,
      viewCount: 0,
    };
    for (const kind of [
      "comments",
      "cell-changes",
      "resource-history",
      "mutations",
      "views",
    ] as const)
      for await (const rows of source.history(kind)) {
        counts[
          kind === "comments"
            ? "commentCount"
            : kind === "mutations"
              ? "mutationCount"
              : kind === "views"
                ? "viewCount"
                : "historyEvents"
        ] += rows.length;
      }
    await this.check(job);
    return RestorePreviewSchema.parse({
      backupId: backup.id,
      sourceDatabaseId: backup.database_id,
      sourceDatabaseName: source.database.name,
      checksum: backup.checksum,
      snapshotAt: backup.snapshot_at.toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      rowCount,
      ...counts,
      tables: tables.map((table) => ({
        id: table.id,
        name: table.name,
        schemaVersion: table.schemaVersion,
        fieldCount: table.fields.length,
        rowCount: table.rowCount,
        uniqueRules: table.uniqueRules.length,
        foreignKeys: table.foreignKeys.length,
      })),
    });
  }
}
