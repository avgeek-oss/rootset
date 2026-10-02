import { IdSchema, RootsetError } from "@rootset/contracts";
import { withOrg, type Pool } from "@rootset/database";
import { type EmailOutbox } from "@rootset/email";
import { type JobsConfig } from "@rootset/jobs";

type NotificationState = "pending" | "sent" | "failed";
type BackupNotify = (
  event: Parameters<NonNullable<JobsConfig["notify"]>>[0],
) => Promise<{ state: "pending" | "sent"; deliveryId: string }>;
interface DeliveryRow {
  id: string;
  state: string;
  provider_id: string | null;
  sent_at: Date | null;
}
function deliveryState(row: DeliveryRow | undefined): NotificationState {
  if (!row) return "failed";
  if (row.state === "sent")
    return row.provider_id && row.sent_at ? "sent" : "failed";
  return row.state === "pending" || row.state === "sending"
    ? "pending"
    : "failed";
}
export function createBackupNotifications(
  pool: Pool,
  outbox: EmailOutbox,
  baseURL: string,
): {
  notify: BackupNotify;
  notificationStatus: NonNullable<JobsConfig["notificationStatus"]>;
} {
  const base = new URL(baseURL);
  const notificationStatus = async (
    deliveryId: string,
  ): Promise<NotificationState> => {
    const id = IdSchema.parse(deliveryId);
    const row = (
      await pool.query<DeliveryRow>(
        "SELECT id,state,provider_id,sent_at FROM rootset_control.email_outbox WHERE id=$1 AND template IN ('backup-verified','backup-failed')",
        [id],
      )
    ).rows[0];
    return deliveryState(row);
  };
  const notify: BackupNotify = async (event) => {
    const orgId = IdSchema.parse(event.orgId),
      databaseId = IdSchema.parse(event.databaseId),
      backupId = IdSchema.parse(event.backupId);
    return withOrg(pool, orgId, async (client) => {
      const backup = (
        await client.query<{
          state: string;
          verified_at: Date | null;
          database_name: string;
          organisation_name: string;
          actor: { kind?: string; userId?: string };
        }>(
          `SELECT b.state,b.verified_at,d.name database_name,o.name organisation_name,j.actor
         FROM rootset_control.backups b JOIN rootset_control.jobs j ON j.id=b.job_id AND j.org_id=b.org_id
         JOIN rootset_control.databases d ON d.id=b.database_id AND d.org_id=b.org_id
         JOIN rootset_control.organisations o ON o.id=b.org_id AND o.state='active'
         WHERE b.id=$1 AND b.org_id=$2 AND b.database_id=$3`,
          [backupId, orgId, databaseId],
        )
      ).rows[0];
      if (!backup)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "The terminal backup notification target is unavailable",
          404,
        );
      if (
        !["succeeded", "failed", "cancelled"].includes(backup.state) ||
        (backup.state === "succeeded" && !backup.verified_at)
      )
        throw new RootsetError(
          "BACKUP_NOTIFICATION_NOT_TERMINAL",
          "Backup email requires a terminal state and successful verification for completed backups",
          409,
        );
      const dedupeKey = `backup:${backupId}:${backup.state}`;
      const existing = (
        await client.query<DeliveryRow>(
          "SELECT id,state,provider_id,sent_at FROM rootset_control.email_outbox WHERE dedupe_key=$1",
          [dedupeKey],
        )
      ).rows[0];
      if (existing && deliveryState(existing) === "failed")
        throw new RootsetError(
          "BACKUP_NOTIFICATION_DELIVERY_FAILED",
          "Backup notification delivery failed; inspect and recover the email outbox before retrying",
          503,
        );
      if (existing)
        return {
          state:
            deliveryState(existing) === "sent"
              ? ("sent" as const)
              : ("pending" as const),
          deliveryId: existing.id,
        };
      const requester =
        backup.actor.kind === "team_key"
          ? undefined
          : IdSchema.safeParse(backup.actor.userId);
      const recipient = (
        await client.query<{ email: string; name: string }>(
          `SELECT u.email,u.name FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id
         WHERE m.org_id=$1 AND m.state='active' AND u.email_verified AND NOT u.disabled AND
          CASE WHEN $2::boolean THEN m.role='owner' ELSE u.id=$3 END
         ORDER BY m.created_at,m.id LIMIT 1`,
          [
            orgId,
            backup.actor.kind === "team_key",
            requester?.success ? requester.data : null,
          ],
        )
      ).rows[0];
      if (!recipient)
        throw new RootsetError(
          "BACKUP_NOTIFICATION_RECIPIENT_UNAVAILABLE",
          "No active verified backup requester or eligible team-key Owner can receive this notification",
          503,
        );
      const details = [
        `Database: ${backup.database_name}`,
        `Database ID: ${databaseId}`,
        `Backup ID: ${backupId}`,
        `Status: ${backup.state}`,
        backup.verified_at
          ? `Verified: ${backup.verified_at.toISOString()} (UTC)`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      const actionUrl = new URL("/settings/backups", base);
      actionUrl.searchParams.set("organisationId", orgId);
      actionUrl.searchParams.set("databaseId", databaseId);
      const deliveryId = await outbox.enqueue(client, {
        template:
          backup.state === "succeeded" ? "backup-verified" : "backup-failed",
        to: recipient.email,
        payload: {
          name: recipient.name,
          organisationName: backup.organisation_name,
          details,
          actionUrl: actionUrl.href,
        },
        dedupeKey,
      });
      return { state: "pending" as const, deliveryId };
    });
  };
  return { notify, notificationStatus };
}
