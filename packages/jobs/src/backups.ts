import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { withOrg, type PoolClient } from "@rootset/database";
import {
  canonicalJson,
  newId,
  parseStrictJson,
  RootsetError,
  type Actor,
  type JsonValue,
  type Row,
} from "@rootset/contracts";
import { ArtifactStore } from "./artifacts.js";
import { DurableQueue, snapshotTransaction, LeaseLost } from "./queue.js";
import type {
  JobRecord,
  RestoreResult,
  SnapshotMetadata,
  SnapshotSource,
  StoragePort,
} from "./types.js";

interface BackupEntry {
  tableId?: string;
  artifactId: string;
  count: number;
  checksum: string;
  byteLength: number;
}
export interface BackupManifest {
  formatVersion: 1;
  appVersion: string;
  controlSchemaVersions: Array<{ name: string; digest: string }>;
  backupId: string;
  organisationId: string;
  databaseId: string;
  snapshotAt: string;
  snapshot: string;
  metadata: SnapshotMetadata;
  rows: BackupEntry[];
  history: BackupEntry;
  archiveReferences: JsonValue[];
  encryptionKeyId: string;
  rowCount: number;
  historyCount: number;
  completion: "extracted";
}
interface BackupRecord {
  id: string;
  org_id: string;
  database_id: string;
  job_id: string;
  state: string;
  manifest_artifact_id: string | null;
  manifest: BackupManifest | null;
  verified_at: Date | null;
  snapshot_at: Date | null;
  recovery_for_database_id: string | null;
}

function jsonRecord(record: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}
function semanticSchema(metadata: SnapshotMetadata): string {
  return canonicalJson(
    {
      databaseDescription: metadata.database.description ?? "",
      tables: metadata.tables.map((table) => {
        const lookup = new Map([
          ...(table.allFields ?? []).map(
            (item) => [item.definition.id, item.definition.apiKey] as const,
          ),
          ...table.fields.map((field) => [field.id, field.apiKey] as const),
        ]);
        const rules = table.rules ?? [];
        const indexes = table.indexes ?? [];
        return {
          name: table.name,
          description: table.description ?? "",
          state: table.state === "creating" ? "active" : table.state,
          schemaVersion: table.schemaVersion,
          fields: table.fields.map((field) =>
            Object.fromEntries(
              Object.entries(field).filter(([key]) => key !== "id"),
            ),
          ),
          retainedFields: (table.allFields ?? []).map((item) => ({
            definition: Object.fromEntries(
              Object.entries(item.definition).filter(([key]) => key !== "id"),
            ),
            state: item.state,
          })),
          rules: rules
            .map((rule) => ({
              name: rule.name,
              fieldApiKeys: (rule.fieldIds as string[]).map((fieldId) =>
                lookup.get(fieldId),
              ),
              strategy: rule.strategy,
              state: rule.state,
              error: rule.error ?? null,
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
          indexes: indexes
            .map((index) => ({
              kind: index.kind,
              fieldApiKey: lookup.get(String(index.fieldId)),
              state: index.state,
              error: index.error ?? null,
            }))
            .sort((a, b) =>
              String(a.fieldApiKey).localeCompare(String(b.fieldApiKey)),
            ),
        };
      }),
    },
    { maxDepth: 96 },
  );
}
export function historyContent(
  record: Record<string, unknown>,
  reverse: Map<string, string>,
): string {
  const outer = jsonRecord(record);
  const data =
    outer.recordType && outer.data && typeof outer.data === "object"
      ? { ...(outer.data as Record<string, unknown>) }
      : outer;
  for (const key of ["id", "public_id", "org_id", "database_id"])
    delete data[key];
  for (const key of ["table_id", "field_id", "mutation_id", "resource_id"])
    if (typeof data[key] === "string")
      data[key] = reverse.get(data[key]) ?? data[key];
  if (
    data.field_definition &&
    typeof data.field_definition === "object" &&
    !Array.isArray(data.field_definition)
  ) {
    const definition = {
      ...(data.field_definition as Record<string, unknown>),
    };
    if (typeof definition.id === "string")
      definition.id = reverse.get(definition.id) ?? definition.id;
    data.field_definition = definition;
  }
  const identityKeys = new Set([
    "id",
    "databaseId",
    "tableId",
    "fieldId",
    "resourceId",
    "ruleId",
    "indexId",
    "mutationId",
    "fieldIds",
    "table_id",
    "field_id",
    "database_id",
    "resource_id",
    "mutation_id",
  ]);
  function metadata(value: unknown, key = ""): unknown {
    if (
      [
        "values",
        "default",
        "old_value",
        "new_value",
        "actor",
        "context",
      ].includes(key)
    )
      return value;
    if (Array.isArray(value)) return value.map((item) => metadata(item, key));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([child, item]) => [
          child,
          metadata(item, child),
        ]),
      );
    return identityKeys.has(key) && typeof value === "string"
      ? (reverse.get(value) ?? value)
      : value;
  }
  if (outer.recordType === "resource") {
    data.before_value = metadata(data.before_value);
    data.after_value = metadata(data.after_value);
  }
  if (outer.recordType === "schemaOperation") {
    data.before_definition = metadata(data.before_definition);
    data.after_definition = metadata(data.after_definition);
    data.plan = metadata(data.plan);
  }
  if (outer.recordType === "mutation") data.outcome = metadata(data.outcome);
  return canonicalJson(
    outer.recordType
      ? { recordType: outer.recordType, sequence: outer.sequence, data }
      : data,
    { maxDepth: 96 },
  );
}

export class HistoryFingerprint {
  private sum = 0n;
  count = 0;
  add(record: Record<string, unknown>, reverse = new Map<string, string>()) {
    const digest = createHash("sha512")
      .update(historyContent(record, reverse))
      .digest("hex");
    this.sum = (this.sum + BigInt(`0x${digest}`)) & ((1n << 512n) - 1n);
    this.count++;
  }
  digest() {
    return `${this.count}:${this.sum.toString(16).padStart(128, "0")}`;
  }
}

export class BackupRunner {
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
    databaseId: string,
    recoveryFor?: string,
    client?: PoolClient,
  ): Promise<BackupRecord> {
    const run = async (client: PoolClient) => {
      const record = await client.query<BackupRecord>(
        `INSERT INTO rootset_control.backups(id,org_id,database_id,job_id,state,recovery_for_database_id)
        VALUES($1,$2,$3,$4,'queued',$5) ON CONFLICT(job_id) DO UPDATE SET job_id=excluded.job_id RETURNING *`,
        [newId(), actor.orgId, databaseId, job.id, recoveryFor ?? null],
      );
      return record.rows[0]!;
    };
    return client
      ? run(client)
      : withOrg(this.queue.workerPool, actor.orgId, run);
  }

  async run(
    actor: Actor,
    job: JobRecord,
    databaseId = job.target_id,
    recoveryFor?: string,
  ): Promise<JsonValue> {
    const backup = await this.ensureRecord(actor, job, databaseId, recoveryFor);
    if (backup.state === "succeeded" && backup.manifest)
      return {
        backupId: backup.id,
        state: "succeeded",
        verifiedAt: backup.verified_at!.toISOString(),
        rowCount: backup.manifest.rowCount,
        historyCount: backup.manifest.historyCount,
      };
    let manifest = backup.manifest;
    try {
      if (!manifest) {
        await this.state(job, backup.id, "snapshotting");
        await this.queue.checkpoint(
          job,
          { ...job.checkpoint, backupId: backup.id },
          job.progress,
          "snapshotting",
        );
        manifest = await snapshotTransaction(
          this.queue.workerPool,
          actor.orgId,
          databaseId,
          async (client) => {
            await client.query(
              "SELECT set_config('idle_in_transaction_session_timeout','600000',true)",
            );
            const snapshot = (
              await client.query<{ snapshot: string; at: Date }>(
                "SELECT pg_current_snapshot()::text AS snapshot,clock_timestamp() AS at",
              )
            ).rows[0]!;
            const source = await this.storage.snapshotDatabase(
              actor,
              databaseId,
              client,
            );
            const controlSchemaVersions = (
              await client.query<{ name: string; digest: string }>(
                "SELECT name,digest FROM rootset_control.migrations ORDER BY name",
              )
            ).rows;
            const entries: BackupEntry[] = [];
            let rowCount = 0;
            for (const table of source.metadata.tables) {
              await this.queue.fenced(job, async () => undefined);
              let count = 0;
              async function* rows() {
                for await (const batch of source.rows(table.id))
                  for (const row of batch) {
                    count++;
                    yield `${canonicalJson(row, { maxDepth: 96 })}\n`;
                  }
              }
              const artifact = await this.artifacts.write(
                actor,
                job,
                { type: "database", id: databaseId },
                `backup-rows-${table.id}`,
                "jsonl",
                "application/x-ndjson",
                rows(),
                { tableId: table.id },
                { expiresAt: new Date("9999-12-31T23:59:59.999Z") },
              );
              entries.push({
                tableId: table.id,
                artifactId: artifact.id,
                count,
                checksum: artifact.checksum!,
                byteLength: Number(artifact.byte_length),
              });
              rowCount += count;
              await this.failpoint?.("backup.afterTableExtraction", job.id);
            }
            let historyCount = 0;
            const archiveReferences = ((source.metadata as SnapshotMetadata)
              .archiveReferences ?? []) as unknown as Array<{
              archiveId: string;
              orgId: string;
              tableId: string;
              artifactId: string;
              checksum: string;
              byteLength: number;
              cellCount: number;
              rowCount: number;
              fingerprint: string;
            }>;
            const materialized = new Set(
              archiveReferences.map((reference) => reference.archiveId),
            );
            const coldHistory = this.coldHistory.bind(this);
            async function* history() {
              for await (const batch of source.history())
                for (const event of batch) {
                  if (
                    event.recordType === "retentionGap" &&
                    event.data &&
                    typeof event.data === "object"
                  ) {
                    const gap = (event.data as Record<string, unknown>)
                      .manifest;
                    if (
                      gap &&
                      typeof gap === "object" &&
                      materialized.has(
                        String((gap as Record<string, unknown>).archiveId),
                      )
                    )
                      continue;
                  }
                  historyCount++;
                  yield `${canonicalJson(jsonRecord(event), { maxDepth: 96 })}\n`;
                }
              for (const reference of archiveReferences)
                for await (const batch of coldHistory(actor, reference))
                  for (const event of batch) {
                    historyCount++;
                    yield `${canonicalJson(event, { maxDepth: 96 })}\n`;
                  }
            }
            const historyArtifact = await this.artifacts.write(
              actor,
              job,
              { type: "database", id: databaseId },
              "backup-history",
              "jsonl",
              "application/x-ndjson",
              history(),
              {},
              { expiresAt: new Date("9999-12-31T23:59:59.999Z") },
            );
            await this.failpoint?.("backup.afterExtraction", job.id);
            return {
              formatVersion: 1,
              appVersion: "0.1.0",
              controlSchemaVersions,
              backupId: backup.id,
              organisationId: actor.orgId,
              databaseId,
              snapshotAt: snapshot.at.toISOString(),
              snapshot: snapshot.snapshot,
              metadata: JSON.parse(
                JSON.stringify(source.metadata),
              ) as SnapshotMetadata,
              rows: entries,
              history: {
                artifactId: historyArtifact.id,
                count: historyCount,
                checksum: historyArtifact.checksum!,
                byteLength: Number(historyArtifact.byte_length),
              },
              archiveReferences: archiveReferences.map((reference) => ({
                ...reference,
                embedded: true,
              })) as unknown as JsonValue[],
              encryptionKeyId: this.artifacts.config.activeKeyId,
              rowCount,
              historyCount,
              completion: "extracted",
            } satisfies BackupManifest;
          },
        );
        // The schema barrier is released before manifest upload and isolated restore.
        await this.state(job, backup.id, "uploading");
        const manifestArtifact = await this.artifacts.write(
          actor,
          job,
          { type: "database", id: databaseId },
          "backup-manifest",
          "json",
          "application/json",
          (async function* () {
            yield canonicalJson(manifest, { maxDepth: 96 });
          })(),
          { formatVersion: 1 },
          { expiresAt: new Date("9999-12-31T23:59:59.999Z") },
        );
        const extracted = manifest;
        await this.queue.fenced(job, async (client) => {
          await client.query(
            "UPDATE rootset_control.backups SET manifest=$2,manifest_artifact_id=$3,snapshot_at=$4,state='verifying',updated_at=now() WHERE id=$1",
            [backup.id, extracted, manifestArtifact.id, extracted.snapshotAt],
          );
        });
        await this.failpoint?.("backup.afterUpload", job.id);
      }
      await this.queue.checkpoint(
        job,
        { ...job.checkpoint, backupId: backup.id },
        job.progress,
        "verifying",
      );
      await this.state(job, backup.id, "verifying");
      await this.validateArtifacts(actor, manifest);
      const verification = await this.storage.restoreDatabase(
        actor,
        this.source(actor, manifest),
        {
          name: `Verification ${backup.id}`,
          jobId: job.id,
          staged: true,
          verification: true,
          jobFence: { jobId: job.id, leaseToken: job.lease_token! },
        },
      );
      try {
        await this.failpoint?.("backup.beforeValidation", job.id);
        await this.verifyRestored(actor, manifest, verification);
      } finally {
        if (!this.storage.discardRestore)
          throw new RootsetError(
            "CONFIGURATION_INVALID",
            "Isolated verification cleanup is not configured",
            500,
          );
        try {
          await this.failpoint?.("backup.beforeCleanup", job.id);
          await this.queue.fenced(
            job,
            async () => {
              await this.storage.discardRestore(actor, verification);
            },
            { allowCancelled: true, allowExpiredDeadline: true },
          );
        } catch (cleanupError) {
          if (cleanupError instanceof LeaseLost) throw cleanupError;
          await this.queue.fenced(
            job,
            (client) =>
              client.query(
                "UPDATE rootset_control.backups SET cleanup_error=$2 WHERE id=$1",
                [
                  backup.id,
                  {
                    code: "CLEANUP_FAILED",
                    message: "Verification namespace cleanup must be retried",
                    databaseId: verification.databaseId,
                  },
                ],
              ),
            { allowCancelled: true, allowExpiredDeadline: true },
          );
          throw new RootsetError(
            "BACKUP_UNVERIFIED",
            "Isolated verification cleanup failed",
            409,
          );
        }
      }
      await this.failpoint?.("backup.afterVerification", job.id);
      actor = (await this.recheck?.(job)) ?? actor;
      const verifiedAt = new Date().toISOString();
      await this.queue.fenced(job, async (client) => {
        await client.query(
          "UPDATE rootset_control.backups SET state='succeeded',verified_at=$2,cleanup_error=NULL,updated_at=now() WHERE id=$1",
          [backup.id, verifiedAt],
        );
      });
      return {
        backupId: backup.id,
        state: "succeeded",
        verifiedAt,
        rowCount: manifest.rowCount,
        historyCount: manifest.historyCount,
      };
    } catch (error) {
      await this.state(job, backup.id, "failed", true);
      throw error;
    }
  }

  private async state(
    job: JobRecord,
    id: string,
    state: string,
    closing = false,
  ): Promise<void> {
    await this.queue.fenced(
      job,
      (client, current) =>
        client.query(
          "UPDATE rootset_control.backups SET state=$2,updated_at=now() WHERE id=$1",
          [id, current.cancel_requested ? "cancelled" : state],
        ),
      { allowCancelled: closing, allowExpiredDeadline: closing },
    );
  }

  private async *coldHistory(
    actor: Actor,
    reference: {
      archiveId: string;
      orgId: string;
      tableId: string;
      artifactId: string;
      checksum: string;
      byteLength: number;
      cellCount: number;
      rowCount: number;
      fingerprint: string;
    },
  ): AsyncGenerator<Record<string, unknown>[]> {
    const artifact = await this.artifacts.get(actor, reference.artifactId);
    if (
      reference.orgId !== actor.orgId ||
      artifact.purpose !== "history-archive" ||
      artifact.target_id !== reference.tableId ||
      artifact.checksum !== reference.checksum ||
      Number(artifact.byte_length) !== reference.byteLength
    )
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Backup cold history artifact binding is invalid",
        409,
      );
    const opened = await this.artifacts.openVerified(actor, artifact);
    const reader = createInterface({
      input: opened.stream,
      crlfDelay: Infinity,
    });
    const fingerprint = new HistoryFingerprint();
    let cells = 0,
      rows = 0;
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
          (value.data as Record<string, unknown>).table_id !== reference.tableId
        )
          throw new RootsetError(
            "BACKUP_UNVERIFIED",
            "Cold history event format is invalid",
            409,
          );
        const record = value as Record<string, unknown>;
        fingerprint.add(record);
        if (record.recordType === "cell") cells++;
        else rows++;
        batch.push(record);
        if (batch.length === 1000) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length) yield batch;
      if (
        cells !== reference.cellCount ||
        rows !== reference.rowCount ||
        fingerprint.digest() !== reference.fingerprint
      )
        throw new RootsetError(
          "BACKUP_UNVERIFIED",
          "Cold history count or event fingerprint differs",
          409,
        );
    } finally {
      reader.close();
      opened.stream.destroy();
      await opened.cleanup();
    }
  }

  async load(
    actor: Actor,
    backupId: string,
  ): Promise<{ backup: BackupRecord; manifest: BackupManifest }> {
    const backup = await withOrg(
      this.queue.pool,
      actor.orgId,
      async (client) =>
        (
          await client.query<BackupRecord>(
            "SELECT * FROM rootset_control.backups WHERE id=$1",
            [backupId],
          )
        ).rows[0],
    );
    if (!backup)
      throw new RootsetError("RESOURCE_NOT_FOUND", "Backup not found", 404);
    if (
      backup.state !== "succeeded" ||
      !backup.verified_at ||
      !backup.manifest ||
      !backup.manifest_artifact_id
    )
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Only an isolated-restore-verified backup can be restored",
        409,
      );
    const stored = await this.artifacts.get(actor, backup.manifest_artifact_id);
    const opened = await this.artifacts.openVerified(actor, stored);
    let content = "";
    try {
      for await (const chunk of opened.stream) {
        content += String(chunk);
        if (Buffer.byteLength(content) > 8 * 1024 ** 2)
          throw new RootsetError(
            "PAYLOAD_TOO_LARGE",
            "Backup manifest is beyond the supported format limit",
            413,
          );
      }
    } finally {
      opened.stream.destroy();
      await opened.cleanup();
    }
    const manifest = parseStrictJson(content, {
      maxBytes: 8 * 1024 ** 2,
      maxDepth: 96,
      safeIntegers: false,
    }) as unknown as BackupManifest;
    if (
      manifest.formatVersion !== 1 ||
      manifest.backupId !== backup.id ||
      manifest.organisationId !== actor.orgId ||
      canonicalJson(manifest, { maxDepth: 96 }) !==
        canonicalJson(backup.manifest, { maxDepth: 96 })
    )
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Backup manifest format or identity is incompatible",
        409,
      );
    await this.validateArtifacts(actor, manifest);
    return { backup, manifest };
  }

  private async validateArtifacts(
    actor: Actor,
    manifest: BackupManifest,
  ): Promise<void> {
    if (
      manifest.formatVersion !== 1 ||
      manifest.organisationId !== actor.orgId ||
      manifest.completion !== "extracted"
    )
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Backup format or organisation mapping is invalid",
        409,
      );
    for (const entry of [...manifest.rows, manifest.history]) {
      const artifact = await this.artifacts.get(actor, entry.artifactId);
      if (
        artifact.purpose === "import_upload" ||
        artifact.target_id !== manifest.databaseId ||
        artifact.checksum !== entry.checksum ||
        Number(artifact.byte_length) !== entry.byteLength
      )
        throw new RootsetError(
          "BACKUP_UNVERIFIED",
          "Manifest artifact identity/checksum mismatch",
          409,
        );
      const opened = await this.artifacts.openVerified(actor, artifact);
      opened.stream.destroy();
      await opened.cleanup();
    }
  }

  source(actor: Actor, manifest: BackupManifest): SnapshotSource {
    const store = this.artifacts;
    async function* records(entry: BackupEntry) {
      const artifact = await store.get(actor, entry.artifactId);
      const opened = await store.openVerified(actor, artifact);
      const reader = createInterface({
        input: opened.stream,
        crlfDelay: Infinity,
      });
      let count = 0;
      let batch: Record<string, unknown>[] = [];
      try {
        for await (const line of reader) {
          const record = parseStrictJson(line, {
            maxBytes: 1024 * 1024,
            maxDepth: 96,
            safeIntegers: false,
          });
          if (!record || typeof record !== "object" || Array.isArray(record))
            throw new RootsetError(
              "BACKUP_UNVERIFIED",
              "Backup record format is invalid",
              409,
            );
          count++;
          batch.push(record);
          if (batch.length === 1000) {
            yield batch;
            batch = [];
          }
        }
        if (batch.length) yield batch;
        if (count !== entry.count)
          throw new RootsetError(
            "BACKUP_UNVERIFIED",
            "Backup record count differs from the manifest",
            409,
          );
      } finally {
        reader.close();
        opened.stream.destroy();
        await opened.cleanup();
      }
    }
    return {
      metadata: manifest.metadata,
      materializedArchiveIds: manifest.archiveReferences
        .filter(
          (reference) =>
            reference &&
            typeof reference === "object" &&
            !Array.isArray(reference) &&
            reference.embedded === true,
        )
        .map((reference) =>
          String((reference as Record<string, JsonValue>).archiveId),
        ),
      rows: (tableId) => {
        const entry = manifest.rows.find(
          (candidate) => candidate.tableId === tableId,
        );
        if (!entry)
          throw new RootsetError(
            "BACKUP_UNVERIFIED",
            "Backup has no row artifact for this table",
            409,
          );
        return records(entry) as AsyncIterable<Row[]>;
      },
      history: () => records(manifest.history),
    };
  }

  async verifyRestored(
    actor: Actor,
    manifest: BackupManifest,
    restored: RestoreResult,
  ): Promise<void> {
    if (
      restored.rowCount !== manifest.rowCount ||
      restored.historyCount !== manifest.historyCount
    )
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Restored row/history counts differ",
        409,
      );
    await snapshotTransaction(
      this.queue.workerPool,
      actor.orgId,
      restored.databaseId,
      async (client) => {
        const snapshot = await this.storage.snapshotDatabase(
          actor,
          restored.databaseId,
          client,
          { includeStaged: true },
        );
        const orderedMetadata = {
          ...snapshot.metadata,
          tables: manifest.metadata.tables
            .map((original) =>
              snapshot.metadata.tables.find(
                (table) => table.id === restored.tableMapping[original.id],
              )!,
            )
            .filter(Boolean),
        };
        if (
          orderedMetadata.tables.length !== manifest.metadata.tables.length ||
          semanticSchema(orderedMetadata) !== semanticSchema(manifest.metadata)
        )
          throw new RootsetError(
            "BACKUP_UNVERIFIED",
            "Restored schema/rule/index definitions differ",
            409,
          );
        for (const entry of manifest.rows) {
          const hash = createHash("sha256");
          let count = 0;
          const tableId = restored.tableMapping[entry.tableId!];
          if (!tableId)
            throw new RootsetError(
              "BACKUP_UNVERIFIED",
              "Restored table mapping is incomplete",
              409,
            );
          for await (const batch of snapshot.rows(tableId))
            for (const row of batch) {
              count++;
              hash.update(`${canonicalJson(row, { maxDepth: 96 })}\n`);
            }
          if (count !== entry.count || hash.digest("hex") !== entry.checksum)
            throw new RootsetError(
              "BACKUP_UNVERIFIED",
              "Restored canonical row content differs",
              409,
            );
        }
        const expected = new HistoryFingerprint();
        const actual = new HistoryFingerprint();
        const reverse = new Map(
          [
            ...Object.entries(restored.tableMapping),
            ...Object.entries(restored.fieldMapping),
            ...Object.entries(restored.resourceMapping ?? {}),
            ...Object.entries(restored.mutationMapping ?? {}),
          ].map(([oldId, newId]) => [newId, oldId]),
        );
        reverse.set(restored.databaseId, manifest.databaseId);
        for await (const batch of this.source(actor, manifest).history())
          for (const record of batch) expected.add(record);
        for await (const batch of snapshot.history())
          for (const record of batch) actual.add(record, reverse);
        if (expected.digest() !== actual.digest())
          throw new RootsetError(
            "BACKUP_UNVERIFIED",
            "Restored canonical history content differs",
            409,
          );
      },
    );
  }

  async restore(actor: Actor, job: JobRecord): Promise<JsonValue> {
    const { backup, manifest } = await this.load(actor, String(job.input.id));
    let publication = await withOrg(
      this.queue.workerPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{
            state: string;
            result: RestoreResult;
            staged_database_id: string;
            recovery_backup_id: string;
          }>(
            "SELECT * FROM rootset_control.restore_publications WHERE job_id=$1",
            [job.id],
          )
        ).rows[0],
    );
    if (publication?.state === "published")
      return {
        ...publication.result,
        state: "succeeded",
        backupId: backup.id,
        ...(publication.recovery_backup_id
          ? { recoveryBackupId: publication.recovery_backup_id }
          : {}),
      } as JsonValue;
    const replace = job.input.mode === "replace";
    const targetId = replace
      ? String(job.input.targetDatabaseId ?? backup.database_id)
      : undefined;
    if (replace && !job.input.stepUpApproved)
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Replacement restore requires a bound approved action",
        403,
      );
    await withOrg(this.queue.workerPool, actor.orgId, async (client) => {
      await client.query(
        "INSERT INTO rootset_control.restore_publications(job_id,org_id,target_database_id,state) VALUES($1,$2,$3,'preparing') ON CONFLICT(job_id) DO NOTHING",
        [job.id, actor.orgId, targetId ?? null],
      );
    });
    if (replace) {
      await this.storage.acquireRestoreBarrier(actor, targetId!, {
        jobId: job.id,
        leaseToken: job.lease_token!,
      });
      const current = await withOrg(
        this.queue.workerPool,
        actor.orgId,
        async (client) => ({
          publication: (
            await client.query<NonNullable<typeof publication>>(
              "SELECT * FROM rootset_control.restore_publications WHERE job_id=$1",
              [job.id],
            )
          ).rows[0],
          checkpoint: (
            await client.query<{ checkpoint: JobRecord["checkpoint"] }>(
              "SELECT checkpoint FROM rootset_control.jobs WHERE id=$1",
              [job.id],
            )
          ).rows[0]!.checkpoint,
        }),
      );
      publication = current.publication;
      job.checkpoint = current.checkpoint;
    }
    if (replace && !publication?.recovery_backup_id) {
      // A separate durable child run captures the target immediately before replacement.
      const child = await this.queue.enqueue(
        actor,
        "createBackup",
        "backup",
        { type: "database", id: targetId! },
        { databaseId: targetId, recoveryFor: targetId },
        `restore:${job.id}:${String(job.checkpoint.recoveryEpoch ?? "initial")}:recovery`,
      );
      await this.queue.checkpoint(
        job,
        { ...job.checkpoint, recoveryJobId: child.id },
        job.progress,
        "waiting_recovery",
      );
      const completed = await withOrg(
        this.queue.workerPool,
        actor.orgId,
        async (client) =>
          (
            await client.query<JobRecord>(
              "SELECT * FROM rootset_control.jobs WHERE id=$1",
              [child.id],
            )
          ).rows[0],
      );
      if (
        completed &&
        ["failed", "cancelled", "partially_completed"].includes(completed.state)
      )
        throw new RootsetError(
          "BACKUP_UNVERIFIED",
          "The required current recovery backup failed; replacement was not published",
          409,
        );
      if (!completed || completed.state !== "succeeded")
        throw new RecoveryPending(child.id);
      const recoveryBackupId = (completed.result as Record<string, JsonValue>)
        .backupId;
      await withOrg(this.queue.workerPool, actor.orgId, (client) =>
        client.query(
          "UPDATE rootset_control.restore_publications SET recovery_backup_id=$2,updated_at=now() WHERE job_id=$1",
          [job.id, recoveryBackupId],
        ),
      );
      publication = {
        ...publication!,
        recovery_backup_id: String(recoveryBackupId),
      };
    }
    const staged =
      publication?.result ??
      (await this.storage.restoreDatabase(actor, this.source(actor, manifest), {
        name:
          typeof job.input.name === "string"
            ? job.input.name
            : `${String(manifest.metadata.database.name)} restored`,
        jobId: job.id,
        staged: true,
        jobFence: { jobId: job.id, leaseToken: job.lease_token! },
        ...(targetId ? { targetDatabaseId: targetId } : {}),
      }));
    await this.queue.fenced(job, async (client) => {
      await client.query(
        "UPDATE rootset_control.restore_publications SET state='staged',staged_database_id=$2,result=$3,updated_at=now() WHERE job_id=$1",
        [job.id, staged.databaseId, staged],
      );
    });
    await this.queue.checkpoint(
      job,
      { ...job.checkpoint, stagedDatabaseId: staged.databaseId },
      job.progress,
      "validating_restore",
    );
    await this.verifyRestored(actor, manifest, staged);
    await this.queue.fenced(job, async (client) => {
      await client.query(
        "UPDATE rootset_control.restore_publications SET state='verified',updated_at=now() WHERE job_id=$1",
        [job.id],
      );
    });
    await this.failpoint?.("restore.beforeCutover", job.id);
    actor = (await this.recheck?.(job)) ?? actor;
    await this.queue.fenced(job, async () => undefined);
    if (!this.storage.publishRestore)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Restore publication is not configured",
        500,
      );
    const published = await this.storage.publishRestore(actor, staged, {
      jobId: job.id,
      leaseToken: job.lease_token ?? undefined,
      ...(targetId
        ? {
            targetDatabaseId: targetId,
            recoveryBackupId: publication!.recovery_backup_id,
          }
        : {}),
    });
    await this.failpoint?.("restore.afterCutover", job.id);
    await this.queue.fenced(job, async (client) => {
      await client.query(
        "UPDATE rootset_control.restore_publications SET state='published',result=$2,updated_at=now() WHERE job_id=$1",
        [job.id, published],
      );
    });
    return {
      ...published,
      state: "succeeded",
      backupId: backup.id,
      ...(targetId
        ? { recoveryBackupId: publication!.recovery_backup_id }
        : {}),
    } as JsonValue;
  }
}

export class RecoveryPending extends Error {
  constructor(readonly jobId: string) {
    super("Waiting for a verified current recovery backup");
  }
}
