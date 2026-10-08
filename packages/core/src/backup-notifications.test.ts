import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { newId, type Actor } from "@rootset/contracts";
import {
  EmailOutbox,
  decryptProtected,
  type EmailPayload,
} from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { loadConfig } from "./config.js";
import { createBackupNotifications } from "./backup-notifications.js";

test("BACKUP terminal notifications resolve verified recipients and report actual SMTP delivery through outage/recovery", async (t) => {
  const db = await isolatedDatabase();
  try {
    const config = loadConfig(),
      orgId = newId(),
      foreignOrgId = newId(),
      databaseId = newId();
    const requesterId = newId(),
      ownerId = newId();
    const email = (id: string) =>
      `rootset-backup-${id.toLowerCase()}@example.test`;
    const ciphertextKey = randomBytes(32).toString("base64");
    const emailConfig = {
      ...config,
      encryptionKey: ciphertextKey,

      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        from: config.smtp.from,
        user: config.smtp.auth?.user,
        password: config.smtp.auth?.pass,
      },
    };
    const outbox = new EmailOutbox(db.identity, emailConfig);
    const broken = new EmailOutbox(db.identity, {
      ...emailConfig,
      smtp: { ...emailConfig.smtp, port: 1 },
    });
    const notifications = createBackupNotifications(
      db.identity,
      outbox,
      config.baseURL,
    );
    await db.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Backup notifications')",
      [orgId],
    );
    for (const [userId, org, role] of [
      [requesterId, orgId, "admin"],
      [ownerId, orgId, "admin"],
    ]) {
      await db.owner.query(
        "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Notification recipient',$2,true)",
        [userId, email(userId!)],
      );
      await db.owner.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
        [newId(), org, userId, role],
      );
    }
    await db.owner.query(
      "INSERT INTO rootset_control.databases(id,org_id,name,schema_name) VALUES($1,$2,'MDM backup source',$3)",
      [databaseId, orgId, `rsd_${databaseId.toLowerCase()}`],
    );
    const actor: Actor = {
      id: newId(),
      kind: "session",
      orgId,
      userId: requesterId,
      role: "admin",
      scopes: ["backups:manage"],
    };
    const seed = async (
      state: "succeeded" | "failed" | "queued" | "cancelled",
      jobActor: Actor = actor,
      verified = state === "succeeded",
    ) => {
      const backupId = newId(),
        jobId = newId();
      await db.owner.query(
        "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key,state) VALUES($1,$2,'backup','createBackup',$3,$4,'database',$5,'{}','fixture',$7,$6)",
        [
          jobId,
          orgId,
          JSON.stringify(jobActor),
          jobActor.id,
          databaseId,
          state === "queued"
            ? "queued"
            : state === "succeeded"
              ? "succeeded"
              : state,
          jobId,
        ],
      );
      await db.owner.query(
        "INSERT INTO rootset_control.backups(id,org_id,database_id,job_id,state,verified_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END)",
        [backupId, orgId, databaseId, jobId, state, verified],
      );
      return { orgId, databaseId, backupId, state };
    };
    let succeeded: Awaited<ReturnType<typeof seed>>, deliveryId: string;
    await t.test(
      "Database terminal state controls template; concurrent events dedupe one verified requester and encrypted payload",
      async () => {
        succeeded = await seed("succeeded");
        const events = await Promise.all([
          notifications.notify({ ...succeeded, state: "failed" }),
          notifications.notify(succeeded),
        ]);
        deliveryId = events[0]!.deliveryId!;
        assert.equal(events[0]!.state, "pending");
        assert.equal(events[1]!.deliveryId, deliveryId);
        const feed = (
          await db.owner.query(
            "SELECT e.id,e.type,e.payload,r.user_id,r.read_at FROM rootset_control.notification_events e JOIN rootset_control.notification_receipts r ON r.event_id=e.id AND r.org_id=e.org_id WHERE e.dedupe_key=$1",
            [`backup:${succeeded.backupId}:succeeded`],
          )
        ).rows;
        assert.equal(feed.length, 1);
        assert.equal(feed[0].user_id, requesterId);
        assert.equal(feed[0].read_at, null);
        assert.equal(feed[0].type, "backup.succeeded");
        assert.equal(feed[0].payload.backupId, succeeded.backupId);
        const rows = (
          await db.owner.query(
            "SELECT to_address,template,payload_encrypted,state,provider_id FROM rootset_control.email_outbox WHERE dedupe_key=$1",
            [`backup:${succeeded.backupId}:succeeded`],
          )
        ).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].to_address, email(requesterId));
        assert.equal(rows[0].template, "backup-verified");
        assert.equal(rows[0].state, "pending");
        assert.equal(rows[0].provider_id, null);
        assert.equal(
          rows[0].payload_encrypted.includes(succeeded.backupId),
          false,
        );
        const payload = decryptProtected<EmailPayload>(
          rows[0].payload_encrypted,
          emailConfig,
        );
        assert.ok(payload.details?.includes(succeeded.backupId));
        assert.ok(payload.details?.includes("Verified:"));
        const actionUrl = new URL(payload.actionUrl!);
        assert.equal(actionUrl.origin, new URL(config.baseURL).origin);
        assert.equal(actionUrl.pathname, "/settings/backups");
        assert.equal(actionUrl.searchParams.has("organisationId"), false);
        assert.equal(actionUrl.searchParams.get("databaseId"), databaseId);
        assert.equal(
          await notifications.notificationStatus(deliveryId),
          "pending",
        );
        await assert.rejects(
          () => notifications.notify({ ...succeeded, orgId: foreignOrgId }),
          (error) => (error as { code: string }).code === "RESOURCE_NOT_FOUND",
        );
      },
    );
    await t.test(
      "SMTP outage remains pending with retry metadata; restarted outbox sends once and Mailpit captures real HTML/plaintext",
      async () => {
        assert.equal(await broken.deliverNext(), true);
        const retry = (
          await db.owner.query(
            "SELECT state,attempts,next_attempt_at,last_error FROM rootset_control.email_outbox WHERE id=$1",
            [deliveryId!],
          )
        ).rows[0];
        assert.equal(retry.state, "pending");
        assert.equal(retry.attempts, 1);
        assert.ok(retry.next_attempt_at.getTime() > Date.now());
        assert.equal(retry.last_error, "SMTP delivery failed");
        assert.equal(
          await notifications.notificationStatus(deliveryId!),
          "pending",
        );
        await db.owner.query(
          "UPDATE rootset_control.email_outbox SET next_attempt_at=now() WHERE id=$1",
          [deliveryId!],
        );
        const restarted = new EmailOutbox(db.identity, emailConfig);
        assert.equal(await restarted.deliverNext(), true);
        const sent = (
          await db.owner.query(
            "SELECT state,attempts,provider_id,sent_at,payload_encrypted FROM rootset_control.email_outbox WHERE id=$1",
            [deliveryId!],
          )
        ).rows[0];
        assert.equal(sent.state, "sent");
        assert.equal(sent.attempts, 2);
        assert.ok(sent.sent_at);
        assert.ok(sent.provider_id);
        assert.equal(sent.payload_encrypted, "");
        assert.equal(
          await notifications.notificationStatus(deliveryId!),
          "sent",
        );
        const repeat = await notifications.notify(succeeded!);
        assert.equal(repeat.state, "sent");
        assert.equal(repeat.deliveryId, deliveryId);
        assert.equal(await restarted.deliverNext(), false);
        const mailpitURL =
          process.env.ROOTSET_TEST_MAILPIT_URL ??
          `http://${config.smtp.host}:${config.smtp.port === 59025 ? 59080 : 8025}`;
        const response = await fetch(
          `${mailpitURL}/api/v1/search?query=${encodeURIComponent(`to:${email(requesterId)}`)}`,
        );
        assert.ok(
          response.ok,
          "Actual Mailpit verification service is required",
        );
        const messages = (await response.json()) as {
          messages: Array<{ ID: string; MessageID: string }>;
        };
        const matching = messages.messages.filter(
          (message) =>
            message.MessageID.replace(/^<|>$/g, "") ===
            String(sent.provider_id).replace(/^<|>$/g, ""),
        );
        assert.equal(matching.length, 1);
        const deliveredResponse = await fetch(
          `${mailpitURL}/api/v1/message/${matching[0]!.ID}`,
        );
        assert.ok(deliveredResponse.ok);
        const delivered = (await deliveredResponse.json()) as {
          HTML: string;
          Text: string;
          Subject: string;
        };
        assert.ok(delivered.Subject.includes("Rootset backup"));
        assert.ok(delivered.HTML.includes(succeeded!.backupId));
        assert.ok(delivered.Text.includes(succeeded!.backupId));
        assert.ok(delivered.Text.includes("Verified:"));
      },
    );
    await t.test(
      "Failed backup notice omits raw errors, exhausted delivery is failed and recovery is truthful",
      async () => {
        const failed = await seed("failed"),
          secret = "credential-password-must-not-enter-backup-email";
        const event = await notifications.notify({
          ...failed,
          error: { message: secret },
        });
        const row = (
          await db.owner.query(
            "SELECT template,payload_encrypted FROM rootset_control.email_outbox WHERE id=$1",
            [event.deliveryId],
          )
        ).rows[0];
        assert.equal(row.template, "backup-failed");
        assert.equal(
          JSON.stringify(
            decryptProtected(row.payload_encrypted, emailConfig),
          ).includes(secret),
          false,
        );
        await db.owner.query(
          "UPDATE rootset_control.email_outbox SET attempts=7,next_attempt_at=now() WHERE id=$1",
          [event.deliveryId],
        );
        await broken.deliverNext();
        assert.equal(
          await notifications.notificationStatus(event.deliveryId!),
          "failed",
        );
        await assert.rejects(
          () => notifications.notify(failed),
          (error) =>
            (error as { code: string }).code ===
            "BACKUP_NOTIFICATION_DELIVERY_FAILED",
        );
        await db.owner.query(
          "UPDATE rootset_control.email_outbox SET state='pending',attempts=0,next_attempt_at=now() WHERE id=$1",
          [event.deliveryId],
        );
        assert.equal(
          await notifications.notificationStatus(event.deliveryId!),
          "pending",
        );
        assert.equal(
          (await notifications.notify(failed)).deliveryId,
          event.deliveryId,
        );
        await outbox.deliverNext();
        assert.equal(
          await notifications.notificationStatus(event.deliveryId!),
          "sent",
        );
        assert.equal(await notifications.notificationStatus(newId()), "failed");
      },
    );
    await t.test(
      "Personal-key backup uses its verified user, requester invalidity is material failure and nonterminal events refuse enqueue",
      async () => {
        const team = await seed("cancelled", {
          ...actor,
          id: newId(),
          kind: "personal_key",
          userId: ownerId,
        });
        const selected = await notifications.notify(team);
        assert.equal(
          (
            await db.owner.query(
              "SELECT to_address,template FROM rootset_control.email_outbox WHERE id=$1",
              [selected.deliveryId],
            )
          ).rows[0].to_address,
          email(ownerId),
        );
        const pending = await seed("queued");
        await assert.rejects(
          () => notifications.notify(pending),
          (error) =>
            (error as { code: string }).code ===
            "BACKUP_NOTIFICATION_NOT_TERMINAL",
        );
        const invalid = await seed("succeeded", actor, false);
        await assert.rejects(
          () => notifications.notify(invalid),
          (error) =>
            (error as { code: string }).code ===
            "BACKUP_NOTIFICATION_NOT_TERMINAL",
        );
        await db.owner.query(
          "DELETE FROM rootset_control.memberships WHERE user_id=$1",
          [requesterId],
        );
        await assert.rejects(
          async () => notifications.notify(await seed("failed")),
          (error) =>
            (error as { code: string }).code ===
            "BACKUP_NOTIFICATION_RECIPIENT_UNAVAILABLE",
        );
        await db.owner.query(
          "UPDATE rootset_control.users SET email_verified=false WHERE id=$1",
          [ownerId],
        );
        await assert.rejects(
          async () =>
            notifications.notify(
              await seed("failed", {
                ...actor,
                kind: "personal_key",
                userId: ownerId,
              }),
            ),
          (error) =>
            (error as { code: string }).code ===
            "BACKUP_NOTIFICATION_RECIPIENT_UNAVAILABLE",
        );
        const count = (
          await db.owner.query(
            "SELECT count(*)::int count FROM rootset_control.email_outbox WHERE template IN ('backup-verified','backup-failed')",
          )
        ).rows[0].count;
        assert.equal(count, 3);
        assert.equal(
          (
            await db.owner.query(
              "SELECT count(*)::integer count FROM rootset_control.notification_events",
            )
          ).rows[0].count,
          3,
        );
      },
    );
  } finally {
    await db.close();
  }
});
