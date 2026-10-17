import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { withOrg, type PoolClient } from "@rootset/database";
import {
  BackupPolicyInputSchema,
  BackupPolicyResultSchema,
  newId,
  RootsetError,
  type Actor,
  type BackupPolicyResult,
} from "@rootset/contracts";
import type { DurableQueue } from "../queue.js";
import type { JobsOptions, OperationContext } from "../types.js";
import { latestBackupRun } from "./schedule.js";
import { ownedBackupObject } from "./ownership.js";

interface PolicyRow {
  database_id: string;
  org_id: string;
  version: number;
  retention_count: number | null;
  overdue_grace_minutes: number;
  alerts_started_at: Date;
  updated_at: Date;
}
interface PublishedBackup {
  id: string;
  database_id: string;
  bucket: string;
  prefix: string;
  object_key: string;
  backend_id: string;
  snapshot_at: Date;
  completed_at: Date;
  prune_lease_token: string | null;
  prune_attempts: number;
}
interface AlertRow {
  id: string;
  kind: "failed" | "overdue";
  backup_id: string | null;
  occurrence_at: Date;
  detected_at: Date;
  notified_at: Date | null;
}
export class BackupLifecycle {
  private cursor: string | null = null;
  private lastRun = 0;
  constructor(
    private readonly options: JobsOptions,
    private readonly queue: DurableQueue,
    private readonly objects: S3Client | undefined,
    private readonly backendId: string | null,
  ) {}
  private async lock(client: PoolClient, databaseId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `rootset:backup:${databaseId}`,
    ]);
  }
  private async latest(
    client: PoolClient,
    databaseId: string,
  ): Promise<PublishedBackup | undefined> {
    return (
      await client.query<PublishedBackup>(
        "SELECT * FROM rootset_control.database_backups WHERE database_id=$1 AND kind='backup' AND published AND storage_state='available' ORDER BY completed_at DESC,id DESC LIMIT 1",
        [databaseId],
      )
    ).rows[0];
  }
  async ensurePolicy(client: PoolClient, databaseId: string, orgId: string) {
    await client.query(
      "INSERT INTO rootset_control.backup_policies(database_id,org_id) VALUES($1,$2) ON CONFLICT(database_id) DO NOTHING",
      [databaseId, orgId],
    );
  }
  async result(
    client: PoolClient,
    databaseId: string,
  ): Promise<BackupPolicyResult> {
    const row = (
      await client.query<PolicyRow>(
        "SELECT * FROM rootset_control.backup_policies WHERE database_id=$1",
        [databaseId],
      )
    ).rows[0];
    const latest = await this.latest(client, databaseId);
    const alerts = (
      await client.query<AlertRow>(
        "SELECT * FROM rootset_control.backup_alerts WHERE database_id=$1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 20",
        [databaseId],
      )
    ).rows;
    const delivery = (
      await client.query<{ available: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM rootset_control.worker_heartbeats WHERE state='ready' AND heartbeat_at>now()-interval '30 seconds' AND backup_alert_delivery) AS available",
      )
    ).rows[0]!.available;
    const error =
      (
        await client.query<{ prune_error: string }>(
          "SELECT prune_error FROM rootset_control.database_backups WHERE database_id=$1 AND storage_state='deleting' AND prune_error IS NOT NULL ORDER BY next_prune_at LIMIT 1",
          [databaseId],
        )
      ).rows[0]?.prune_error ?? null;
    return BackupPolicyResultSchema.parse({
      policy: {
        databaseId,
        version: row?.version ?? 0,
        retentionCount: row?.retention_count ?? null,
        overdueGraceMinutes: row?.overdue_grace_minutes ?? 60,
        updatedAt: row?.updated_at.toISOString() ?? null,
      },
      emailDeliveryAvailable: delivery,
      lastSuccessful: latest
        ? {
            backupId: latest.id,
            snapshotAt: latest.snapshot_at.toISOString(),
            completedAt: latest.completed_at.toISOString(),
            bucket: latest.bucket,
            objectKey: latest.object_key,
          }
        : null,
      alerts: alerts.map((alert) => ({
        id: alert.id,
        kind: alert.kind,
        backupId: alert.backup_id,
        occurrenceAt: alert.occurrence_at.toISOString(),
        detectedAt: alert.detected_at.toISOString(),
        notifiedAt: alert.notified_at?.toISOString() ?? null,
      })),
      retentionError: error,
    });
  }
  async execute(
    operation: string,
    actor: Actor,
    input: Record<string, unknown>,
    client: PoolClient,
    context: OperationContext,
  ) {
    const databaseId = String(input.databaseId);
    if (operation === "getDatabaseBackupPolicy")
      return this.result(client, databaseId);
    const parsed = BackupPolicyInputSchema.parse({
      expectedVersion: input.expectedVersion,
      retentionCount: input.retentionCount,
      overdueGraceMinutes: input.overdueGraceMinutes,
    });
    await this.lock(client, databaseId);
    const before = await this.result(client, databaseId);
    if (before.policy.version !== parsed.expectedVersion)
      throw new RootsetError(
        "ROW_VERSION_CONFLICT",
        "The backup policy changed. Reload it before saving your changes.",
        409,
      );
    await client.query(
      `INSERT INTO rootset_control.backup_policies(database_id,org_id,retention_count,overdue_grace_minutes) VALUES($1,$2,$3,$4)
      ON CONFLICT(database_id) DO UPDATE SET version=backup_policies.version+1,retention_count=excluded.retention_count,overdue_grace_minutes=excluded.overdue_grace_minutes,updated_at=now()`,
      [
        databaseId,
        actor.orgId,
        parsed.retentionCount,
        parsed.overdueGraceMinutes,
      ],
    );
    const result = await this.result(client, databaseId);
    await client.query(
      "INSERT INTO rootset_control.resource_history(org_id,database_id,resource_id,operation,before_value,after_value,actor,context) VALUES($1,$2,$2,'database.backup_policy.update',$3,$4,$5,$6)",
      [
        actor.orgId,
        databaseId,
        before.policy,
        result.policy,
        actor,
        { source: context.source ?? "rest", requestId: context.requestId },
      ],
    );
    return result;
  }
  private async claimPrune(
    orgId: string,
    databaseId: string,
  ): Promise<PublishedBackup | undefined> {
    if (!this.backendId || !this.objects) return undefined;
    return withOrg(this.queue.workerPool, orgId, async (client) => {
      await this.lock(client, databaseId);
      const policy = (
        await client.query<PolicyRow>(
          "SELECT p.* FROM rootset_control.backup_policies p JOIN rootset_control.databases d ON d.id=p.database_id WHERE p.database_id=$1 AND d.state='active'",
          [databaseId],
        )
      ).rows[0];
      if (!policy) return undefined;
      const candidate = (
        await client.query<PublishedBackup>(
          `WITH ranked AS (
        SELECT b.*,row_number() OVER(ORDER BY completed_at DESC,id DESC) AS position FROM rootset_control.database_backups b
        WHERE b.database_id=$1 AND b.kind='backup' AND b.published AND b.storage_state<>'pruned'
      ) SELECT r.* FROM ranked r WHERE r.backend_id=$2 AND r.position>1 AND r.next_prune_at<=now()
        AND (r.prune_lease_until IS NULL OR r.prune_lease_until<clock_timestamp())
        AND (r.storage_state='deleting' OR ($3::integer IS NOT NULL AND r.position>$3))
        AND NOT EXISTS(SELECT 1 FROM rootset_control.jobs j WHERE j.org_id=$4 AND j.input->>'backupId'=r.id
          AND j.kind IN ('database_restore_preview','database_restore')
          AND (j.state IN ('queued','running') OR (j.kind='database_restore_preview' AND j.state='succeeded'
            AND j.result->>'expiresAt'>to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
        ORDER BY (r.storage_state='deleting') DESC,r.completed_at,r.id LIMIT 1`,
          [databaseId, this.backendId, policy.retention_count, orgId],
        )
      ).rows[0];
      if (!candidate) return undefined;
      if (!ownedBackupObject(candidate))
        throw new RootsetError(
          "ACCESS_DENIED",
          "Backup retention refused an object outside its published namespace",
          403,
        );
      const token = newId();
      const claimed = await client.query<PublishedBackup>(
        "UPDATE rootset_control.database_backups SET storage_state='deleting',prune_lease_token=$2,prune_lease_until=clock_timestamp()+interval '2 minutes',prune_attempts=least(100,prune_attempts+1) WHERE id=$1 RETURNING *",
        [candidate.id, token],
      );
      return claimed.rows[0];
    });
  }
  async pruneOne(orgId: string, databaseId: string): Promise<boolean> {
    const item = await this.claimPrune(orgId, databaseId);
    if (!item) return false;
    try {
      await this.options.config.failpoint?.(
        "backupRetention.beforeDelete",
        item.id,
      );
      await this.objects!.send(
        new DeleteObjectCommand({ Bucket: item.bucket, Key: item.object_key }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
      await this.options.config.failpoint?.(
        "backupRetention.afterDelete",
        item.id,
      );
      await withOrg(this.queue.workerPool, orgId, async (client) => {
        const updated = await client.query(
          "UPDATE rootset_control.database_backups SET storage_state='pruned',pruned_at=now(),prune_error=NULL,prune_lease_token=NULL,prune_lease_until=NULL WHERE id=$1 AND storage_state='deleting' AND prune_lease_token=$2 RETURNING id",
          [item.id, item.prune_lease_token],
        );
        if (updated.rowCount)
          await client.query(
            "INSERT INTO rootset_control.resource_history(org_id,database_id,resource_id,operation,before_value,after_value,actor,context) VALUES($1,$2,$3,'database.backup.prune',$4,$5,$6,$7)",
            [
              orgId,
              databaseId,
              item.id,
              { storageState: "available" },
              { storageState: "pruned" },
              { kind: "operator", id: "backup-retention" },
              { source: "worker" },
            ],
          );
      });
    } catch {
      await withOrg(this.queue.workerPool, orgId, (client) =>
        client.query(
          "UPDATE rootset_control.database_backups SET prune_error='The worker could not remove this backup package. Retention will retry.',prune_lease_token=NULL,prune_lease_until=NULL,next_prune_at=now()+($3*interval '1 second') WHERE id=$1 AND storage_state='deleting' AND prune_lease_token=$2",
          [
            item.id,
            item.prune_lease_token,
            Math.min(3600, 15 * 2 ** Math.min(item.prune_attempts, 8)),
          ],
        ),
      );
    }
    return true;
  }
  async checkAlerts(orgId: string, databaseId: string, now = new Date()) {
    await withOrg(this.queue.workerPool, orgId, async (client) => {
      await this.lock(client, databaseId);
      const database = (
        await client.query<{ name: string; state: string }>(
          "SELECT name,state FROM rootset_control.databases WHERE id=$1",
          [databaseId],
        )
      ).rows[0];
      if (!database || database.state !== "active") {
        await client.query(
          "UPDATE rootset_control.backup_alerts SET resolved_at=$2 WHERE database_id=$1 AND resolved_at IS NULL",
          [databaseId, now],
        );
        return;
      }
      const policy = (
        await client.query<PolicyRow>(
          "SELECT * FROM rootset_control.backup_policies WHERE database_id=$1",
          [databaseId],
        )
      ).rows[0];
      if (!policy) return;
      const latest = await this.latest(client, databaseId);
      await client.query(
        `UPDATE rootset_control.backup_alerts a SET resolved_at=$2 WHERE a.database_id=$1 AND a.kind='failed' AND a.resolved_at IS NULL
        AND (a.occurrence_at<=$3::timestamptz OR EXISTS(SELECT 1 FROM rootset_control.database_backups b WHERE b.id=a.backup_id AND b.published))`,
        [databaseId, now, latest?.completed_at ?? null],
      );
      await client.query(
        `INSERT INTO rootset_control.backup_alerts(id,org_id,database_id,kind,backup_id,occurrence_at,detected_at)
        SELECT rootset_control.new_ulid(),b.org_id,b.database_id,'failed',b.id,j.completed_at,$2
        FROM rootset_control.database_backups b JOIN rootset_control.jobs j ON j.id=b.job_id
        WHERE b.database_id=$1 AND b.kind='backup' AND NOT b.published AND j.state='failed'
          AND j.completed_at>=$3 AND ($4::timestamptz IS NULL OR j.completed_at>$4)
          AND NOT EXISTS(SELECT 1 FROM rootset_control.backup_alerts a WHERE a.backup_id=b.id AND a.kind='failed')
        ORDER BY j.completed_at DESC LIMIT 20 ON CONFLICT DO NOTHING`,
        [
          databaseId,
          now,
          policy.alerts_started_at,
          latest?.completed_at ?? null,
        ],
      );
      const schedule = (
        await client.query<{
          cron: string;
          timezone: string;
          updated_at: Date;
        }>(
          "SELECT cron,timezone,updated_at FROM rootset_control.backup_schedules WHERE database_id=$1",
          [databaseId],
        )
      ).rows[0];
      const due = schedule
        ? latestBackupRun(
            schedule,
            new Date(now.getTime() - policy.overdue_grace_minutes * 60_000),
          )
        : null;
      const overdue = Boolean(
        due &&
        schedule &&
        due.getTime() >= schedule.updated_at.getTime() &&
        due.getTime() >= policy.alerts_started_at.getTime() &&
        (!latest || latest.snapshot_at.getTime() < due.getTime()),
      );
      if (!overdue)
        await client.query(
          "UPDATE rootset_control.backup_alerts SET resolved_at=$2 WHERE database_id=$1 AND kind='overdue' AND resolved_at IS NULL",
          [databaseId, now],
        );
      else
        await client.query(
          "INSERT INTO rootset_control.backup_alerts(id,org_id,database_id,kind,occurrence_at,detected_at) VALUES($1,$2,$3,'overdue',$4,$5) ON CONFLICT DO NOTHING",
          [newId(), orgId, databaseId, due, now],
        );
      if (!this.options.config.notifyBackupAdministrators) return;
      const pending = (
        await client.query<AlertRow>(
          "SELECT * FROM rootset_control.backup_alerts WHERE database_id=$1 AND resolved_at IS NULL AND notified_at IS NULL ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED",
          [databaseId],
        )
      ).rows;
      for (const alert of pending) {
        await this.options.config.notifyBackupAdministrators(client, {
          id: alert.id,
          orgId,
          databaseId,
          databaseName: database.name,
          kind: alert.kind,
          occurrenceAt: alert.occurrence_at.toISOString(),
          lastSuccessfulAt: latest?.snapshot_at.toISOString() ?? null,
        });
        await client.query(
          "UPDATE rootset_control.backup_alerts SET notified_at=$2 WHERE id=$1",
          [alert.id, now],
        );
      }
    });
  }
  async maintain(orgId: string, now = new Date()) {
    if (now.getTime() - this.lastRun < 10_000) return;
    this.lastRun = now.getTime();
    const policies = await withOrg(
      this.queue.workerPool,
      orgId,
      async (client) => {
        await client.query(
          "INSERT INTO rootset_control.backup_policies(database_id,org_id) SELECT s.database_id,s.org_id FROM rootset_control.backup_schedules s JOIN rootset_control.databases d ON d.id=s.database_id AND d.state='active' ON CONFLICT(database_id) DO NOTHING",
        );
        return (
          await client.query<{ database_id: string }>(
            "SELECT database_id FROM rootset_control.backup_policies WHERE ($1::text IS NULL OR database_id>$1) ORDER BY database_id LIMIT 20",
            [this.cursor],
          )
        ).rows;
      },
    );
    this.cursor = policies.length ? policies.at(-1)!.database_id : null;
    for (const policy of policies) {
      await this.checkAlerts(orgId, policy.database_id, now);
      await this.pruneOne(orgId, policy.database_id);
    }
  }
}
