import { createInterface } from "node:readline";
import { withOrg, type PoolClient } from "@rootset/database";
import {
  canonicalJson,
  newId,
  parseStrictJson,
  RootsetError,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";
import { ArtifactStore } from "./artifacts.js";
import { HistoryFingerprint } from "./backups.js";
import { DurableQueue, snapshotTransaction } from "./queue.js";
import type { JobRecord, StoragePort } from "./types.js";

export interface HistoryArchiveManifest {
  formatVersion: 1;
  archiveId: string;
  orgId: string;
  databaseId: string;
  tableId: string;
  from: string;
  to: string;
  snapshotAt: string;
  cellCount: number;
  rowCount: number;
  artifactId: string;
  checksum: string;
  byteLength: number;
  encryptionKeyId: string;
  fingerprint: string;
  interpretations: unknown[];
  verifiedAt: string;
}
export interface HistoryArchiveRecord {
  id: string;
  org_id: string;
  database_id: string;
  table_id: string;
  job_id: string;
  state: string;
  from_time: Date | null;
  to_time: Date;
  artifact_id: string | null;
  manifest: HistoryArchiveManifest | null;
  cell_count: string;
  row_count: string;
  purged_cells: string;
  purged_rows: string;
  verified_at: Date | null;
  created_at: Date;
  error: Record<string, unknown> | null;
}

export function archiveView(
  row: HistoryArchiveRecord,
): Record<string, unknown> {
  return {
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    tableId: row.table_id,
    jobId: row.job_id,
    artifactId: row.artifact_id,
    state: row.state === "verified" ? "verifying" : row.state,
    from: row.from_time?.toISOString() ?? null,
    to: row.to_time.toISOString(),
    createdAt: row.created_at.toISOString(),
    verifiedAt: row.verified_at?.toISOString() ?? null,
    cellEvents: Number(row.cell_count),
    rowEvents: Number(row.row_count),
    ...(row.manifest
      ? {
          sizeBytes: row.manifest.byteLength,
          checksum: row.manifest.checksum,
          manifest: row.manifest,
        }
      : {}),
    ...(row.error
      ? { error: String(row.error.message ?? "History archive failed") }
      : {}),
  };
}

export async function* archiveRecords(
  store: ArtifactStore,
  actor: Actor,
  manifest: HistoryArchiveManifest,
): AsyncGenerator<Record<string, unknown>[]> {
  const artifact = await store.get(actor, manifest.artifactId);
  if (
    artifact.purpose !== "history-archive" ||
    artifact.target_id !== manifest.tableId ||
    artifact.checksum !== manifest.checksum ||
    Number(artifact.byte_length) !== manifest.byteLength
  )
    throw new RootsetError(
      "BACKUP_UNVERIFIED",
      "History archive manifest artifact binding is invalid",
      409,
    );
  const opened = await store.openVerified(actor, artifact);
  const reader = createInterface({ input: opened.stream, crlfDelay: Infinity });
  let batch: Record<string, unknown>[] = [];
  try {
    for await (const line of reader) {
      const value = parseStrictJson(line, {
        maxBytes: 1024 * 1024,
        maxDepth: 96,
        safeIntegers: false,
      });
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !["cell", "row"].includes(String(value.recordType)) ||
        !value.data ||
        typeof value.data !== "object" ||
        Array.isArray(value.data) ||
        (value.data as Record<string, unknown>).table_id !== manifest.tableId
      )
        throw new RootsetError(
          "BACKUP_UNVERIFIED",
          "History archive contains an incompatible event",
          409,
        );
      batch.push(value as Record<string, unknown>);
      if (batch.length === 1000) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  } finally {
    reader.close();
    opened.stream.destroy();
    await opened.cleanup();
  }
}

export class HistoryArchiveRunner {
  constructor(
    readonly queue: DurableQueue,
    readonly artifacts: ArtifactStore,
    readonly storage: StoragePort,
    readonly failpoint?: (point: string, jobId: string) => Promise<void>,
    readonly recheck?: (job: JobRecord) => Promise<Actor>,
  ) {}

  async ensureRecord(
    actor: Actor,
    job: JobRecord,
    client?: PoolClient,
  ): Promise<HistoryArchiveRecord> {
    const run = async (c: PoolClient) => {
      const existing = (
        await c.query<HistoryArchiveRecord>(
          "SELECT * FROM rootset_control.history_archives WHERE job_id=$1",
          [job.id],
        )
      ).rows[0];
      if (existing) return existing;
      const table = await this.storage.getTable(actor, job.target_id);
      const before = new Date(String(job.input.before));
      if (!Number.isFinite(before.getTime()) || before.getTime() > Date.now())
        throw new RootsetError(
          "VALIDATION_FAILED",
          "History archive cutoff must be a past UTC instant",
        );
      const range = (
        await c.query<{ from: Date }>(
          'SELECT coalesce(max(to_time),$2::timestamptz) AS "from" FROM rootset_control.history_gaps WHERE table_id=$1',
          [table.id, "0001-01-01T00:00:00.000Z"],
        )
      ).rows[0]!.from;
      if (before <= range)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "History archive cutoff must advance the already archived range",
        );
      const active = await c.query(
        "SELECT 1 FROM rootset_control.jobs WHERE target_type='table' AND target_id=$1 AND kind='history_archive' AND id<>$2 AND state IN ('queued','running')",
        [table.id, job.id],
      );
      if (active.rowCount)
        throw new RootsetError(
          "STATE_CONFLICT",
          "Another history archive is active for this table",
          409,
        );
      return (
        await c.query<HistoryArchiveRecord>(
          `INSERT INTO rootset_control.history_archives(id,org_id,database_id,table_id,job_id,from_time,to_time)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            newId(),
            actor.orgId,
            table.databaseId,
            table.id,
            job.id,
            range,
            before,
          ],
        )
      ).rows[0]!;
    };
    return client
      ? run(client)
      : withOrg(this.queue.workerPool, actor.orgId, run);
  }

  async verify(actor: Actor, manifest: HistoryArchiveManifest): Promise<void> {
    const fingerprint = new HistoryFingerprint();
    let cells = 0,
      rows = 0;
    for await (const batch of archiveRecords(this.artifacts, actor, manifest))
      for (const record of batch) {
        fingerprint.add(record);
        if (record.recordType === "cell") cells++;
        else rows++;
      }
    if (
      cells !== manifest.cellCount ||
      rows !== manifest.rowCount ||
      fingerprint.digest() !== manifest.fingerprint
    )
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "History archive counts or canonical event fingerprint differ",
        409,
      );
  }

  async run(actor: Actor, job: JobRecord): Promise<JsonValue> {
    const record = await this.ensureRecord(actor, job);
    if (record.state === "succeeded")
      return {
        archiveId: record.id,
        artifactId: record.artifact_id!,
        state: "succeeded",
        cellEvents: Number(record.cell_count),
        rowEvents: Number(record.row_count),
      };
    let manifest = record.manifest;
    try {
      if (!manifest) {
        await this.queue.checkpoint(
          job,
          { ...job.checkpoint, archiveId: record.id },
          job.progress,
          "snapshotting",
        );
        const extracted = await snapshotTransaction(
          this.queue.workerPool,
          actor.orgId,
          record.database_id,
          async (client) => {
            await client.query(
              "SELECT set_config('idle_in_transaction_session_timeout','600000',true)",
            );
            const source = await this.storage.snapshotHistory(
              actor,
              record.table_id,
              {
                from: record.from_time!.toISOString(),
                to: record.to_time.toISOString(),
              },
              client,
            );
            const fingerprint = new HistoryFingerprint();
            let cells = 0,
              rows = 0;
            async function* events() {
              for await (const batch of source.history())
                for (const event of batch) {
                  fingerprint.add(event);
                  if (event.recordType === "cell") cells++;
                  else if (event.recordType === "row") rows++;
                  else
                    throw new RootsetError(
                      "BACKUP_UNVERIFIED",
                      "History snapshot contains an incompatible section",
                      409,
                    );
                  yield `${canonicalJson(event, { maxDepth: 96 })}\n`;
                }
            }
            const artifact = await this.artifacts.write(
              actor,
              job,
              { type: "table", id: record.table_id },
              "history-archive",
              "jsonl",
              "application/x-ndjson",
              events(),
              { archiveId: record.id },
              { expiresAt: new Date("9999-12-31T23:59:59.999Z") },
            );
            if (
              cells !== source.metadata.cellCount ||
              rows !== source.metadata.rowCount
            )
              throw new RootsetError(
                "BACKUP_UNVERIFIED",
                "History snapshot count changed within extraction",
                409,
              );
            return {
              formatVersion: 1,
              archiveId: record.id,
              orgId: actor.orgId,
              databaseId: record.database_id,
              tableId: record.table_id,
              from: record.from_time!.toISOString(),
              to: record.to_time.toISOString(),
              snapshotAt: source.metadata.snapshotAt,
              cellCount: cells,
              rowCount: rows,
              artifactId: artifact.id,
              checksum: artifact.checksum!,
              byteLength: Number(artifact.byte_length),
              encryptionKeyId: artifact.encryption_key_id!,
              fingerprint: fingerprint.digest(),
              interpretations: source.metadata.interpretations,
              verifiedAt: "",
            } satisfies HistoryArchiveManifest;
          },
        );
        manifest = extracted;
        await this.queue.fenced(job, async (client) => {
          await client.query(
            "UPDATE rootset_control.history_archives SET state='uploading',artifact_id=$2,manifest=$3,cell_count=$4,row_count=$5,error=NULL,updated_at=now() WHERE id=$1",
            [
              record.id,
              manifest!.artifactId,
              manifest,
              manifest!.cellCount,
              manifest!.rowCount,
            ],
          );
        });
        await this.failpoint?.("archive.afterUpload", job.id);
      }
      await this.queue.checkpoint(
        job,
        { ...job.checkpoint, archiveId: record.id },
        job.progress,
        "verifying_archive",
      );
      await this.verify(actor, manifest);
      if (!manifest.verifiedAt)
        manifest = { ...manifest, verifiedAt: new Date().toISOString() };
      await this.queue.fenced(job, async (client) => {
        await client.query(
          "UPDATE rootset_control.history_archives SET state='verified',verified_at=$2,manifest=$3,error=NULL,updated_at=now() WHERE id=$1",
          [record.id, manifest!.verifiedAt, manifest],
        );
      });
      await this.failpoint?.("archive.beforePublish", job.id);
      actor = (await this.recheck?.(job)) ?? actor;
      await this.storage.publishHistoryArchive(
        actor,
        record.table_id,
        manifest,
        { jobId: job.id, leaseToken: job.lease_token! },
      );
      await this.queue.checkpoint(
        job,
        { ...job.checkpoint, archiveId: record.id },
        job.progress,
        "purging_history",
      );
      for (;;) {
        actor = (await this.recheck?.(job)) ?? actor;
        const purge = await this.storage.purgeArchivedHistory(
          actor,
          record.table_id,
          record.id,
          { jobId: job.id, leaseToken: job.lease_token!, batchSize: 1000 },
        );
        await this.failpoint?.("archive.afterPurgeBatch", job.id);
        if (purge.done) break;
      }
      await this.queue.fenced(job, async (client) => {
        await client.query(
          "UPDATE rootset_control.history_archives SET state='succeeded',error=NULL,updated_at=now() WHERE id=$1",
          [record.id],
        );
      });
      return {
        archiveId: record.id,
        artifactId: manifest.artifactId,
        state: "succeeded",
        verifiedAt: manifest.verifiedAt,
        cellEvents: manifest.cellCount,
        rowEvents: manifest.rowCount,
      };
    } catch (error) {
      await withOrg(this.queue.workerPool, actor.orgId, (client) =>
        client.query(
          "UPDATE rootset_control.history_archives SET error=$2,updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM rootset_control.jobs j WHERE j.id=$3 AND j.state='running' AND j.lease_token=$4 AND j.lease_until>clock_timestamp())",
          [
            record.id,
            error instanceof RootsetError
              ? error.toJSON()
              : {
                  code: "JOB_FAILED",
                  message: "History archive worker was interrupted",
                },
            job.id,
            job.lease_token,
          ],
        ),
      );
      throw error;
    }
  }
}
