import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { withOrg } from "@rootset/database";
import { newId, type Actor, type NotificationPage } from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { IdentityService } from "./index.js";
import {
  markAllNotificationsRead,
  publishNotification,
} from "./notifications.js";

test("durable notification feed preserves all unread pages, user isolation, immutable receipts and snapshot arrivals", async (t) => {
  const db = await isolatedDatabase();
  try {
    const orgId = newId(),
      userId = newId(),
      otherUserId = newId();
    const service = new IdentityService({
      pool: db.identity,
      baseURL: "http://localhost:6300",
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    });
    await db.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Feed fixture')",
      [orgId],
    );
    const actors: Actor[] = [];
    for (const user of [userId, otherUserId]) {
      const sessionId = newId();
      await db.owner.query(
        "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Reader',$2,true)",
        [user, `${user.toLowerCase()}@example.test`],
      );
      await db.owner.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'viewer')",
        [newId(), orgId, user],
      );
      await db.owner.query(
        "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
        [sessionId, user, randomBytes(32).toString("hex")],
      );
      actors.push({
        kind: "session",
        id: sessionId,
        userId: user,
        orgId,
        role: "viewer",
        scopes: ["profile:manage"],
      });
    }
    const actor = actors[0]!,
      other = actors[1]!;
    const ids = Array.from({ length: 121 }, () => newId());
    const payload = {
      title: "Backup verified",
      message: "A durable fixture",
      databaseId: newId(),
      databaseName: "Feed database",
      backupId: newId(),
    };
    for (const [index, id] of ids.entries()) {
      await db.owner.query(
        `INSERT INTO rootset_control.notification_events(id,org_id,dedupe_key,type,payload,occurred_at)
        VALUES($1::varchar,$2,$1::text,'backup.succeeded',$3,'2020-01-01T00:00:00.123000Z'::timestamptz+$4*interval '1 microsecond')`,
        [id, orgId, payload, index],
      );
      await db.owner.query(
        "INSERT INTO rootset_control.notification_receipts(org_id,user_id,event_id) VALUES($1,$2,$3)",
        [orgId, userId, id],
      );
    }
    const read = async (
      target = actor,
      input: Record<string, unknown> = { limit: 50 },
    ) =>
      (await service.execute(
        "listNotifications",
        target,
        input,
      )) as NotificationPage;
    await t.test(
      "no auto-read; every old unread event is paginated with full badge counts and precision",
      async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page = await read(actor, { limit: 50, cursor });
          assert.equal(page.unreadCount, 121);
          assert.ok(page.notifications.length <= 50);
          assert.ok(page.notifications.every((item) => item.readAt === null));
          seen.push(...page.notifications.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor);
        assert.equal(new Set(seen).size, 121);
        assert.equal(seen.length, 121);
        assert.deepEqual(new Set(seen), new Set(ids));
        assert.equal((await read(other)).unreadCount, 0);
        const firstCursor = (await read()).nextCursor!;
        await assert.rejects(read(other, { limit: 50, cursor: firstCursor }), {
          code: "CURSOR_INVALID",
        });
        await assert.rejects(read(actor, { limit: 49, cursor: firstCursor }), {
          code: "CURSOR_INVALID",
        });
        await assert.rejects(
          read(actor, { limit: 50, cursor: firstCursor + "x" }),
          {
            code: "CURSOR_INVALID",
          },
        );
        await assert.rejects(read({ ...actor, orgId: newId() }), {
          code: "UNAUTHENTICATED",
        });
        await assert.rejects(
          withOrg(db.identity, newId(), (client) =>
            client.query(
              "INSERT INTO rootset_control.notification_receipts(org_id,user_id,event_id) VALUES($1,$2,$3)",
              [orgId, otherUserId, ids[0]],
            ),
          ),
          { code: "42501" },
        );
        assert.equal(
          (
            await withOrg(db.identity, newId(), (client) =>
              client.query(
                "SELECT id FROM rootset_control.notification_events",
              ),
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      "read retention filters on first read time, retains rows, and retry does not acknowledge later arrivals",
      async () => {
        const agedId = newId();
        await db.owner.query(
          "INSERT INTO rootset_control.notification_events(id,org_id,dedupe_key,type,payload,occurred_at) VALUES($1::varchar,$2,$1::text,'backup.failed',$3,now())",
          [agedId, orgId, payload],
        );
        await db.owner.query(
          "INSERT INTO rootset_control.notification_receipts(org_id,user_id,event_id,read_at) VALUES($1,$2,$3,now()-interval '25 hours')",
          [orgId, userId, agedId],
        );
        assert.equal((await read()).unreadCount, 121);
        const key = newId();
        const marked = await service.execute(
          "markAllNotificationsRead",
          actor,
          {},
          { idempotencyKey: key },
        );
        assert.deepEqual(marked, { ok: true });
        const timesBefore = (
          await db.owner.query(
            "SELECT event_id,read_at::text FROM rootset_control.notification_receipts WHERE user_id=$1 ORDER BY event_id",
            [userId],
          )
        ).rows;
        const after = await read();
        assert.equal(after.unreadCount, 0);
        assert.equal(after.notifications.length, 50);
        assert.ok(
          after.notifications.every(
            (item) => item.readAt !== null && item.id !== agedId,
          ),
        );
        const published = await withOrg(db.identity, orgId, (client) =>
          publishNotification(client, {
            orgId,
            userId,
            dedupeKey: "new-arrival",
            type: "backup.succeeded",
            occurredAt: new Date().toISOString(),
            payload,
          }),
        );
        await service.execute(
          "markAllNotificationsRead",
          actor,
          {},
          { idempotencyKey: key },
        );
        assert.equal((await read()).unreadCount, 1);
        const timesAfter = (
          await db.owner.query(
            "SELECT event_id,read_at::text FROM rootset_control.notification_receipts WHERE user_id=$1 AND event_id<>$2 ORDER BY event_id",
            [userId, published],
          )
        ).rows;
        assert.deepEqual(timesAfter, timesBefore);
        const duplicate = await withOrg(db.identity, orgId, (client) =>
          publishNotification(client, {
            orgId,
            userId,
            dedupeKey: "new-arrival",
            type: "backup.succeeded",
            occurredAt: new Date().toISOString(),
            payload,
          }),
        );
        assert.equal(duplicate, published);
        assert.equal((await read()).unreadCount, 1);
        await assert.rejects(
          withOrg(db.identity, orgId, (client) =>
            client.query(
              "UPDATE rootset_control.notification_receipts SET read_at=now() WHERE event_id=$1",
              [agedId],
            ),
          ),
          { code: "23514" },
        );
        assert.equal(
          (
            await db.owner.query(
              "SELECT count(*)::integer count FROM rootset_control.notification_receipts WHERE user_id=$1",
              [userId],
            )
          ).rows[0].count,
          123,
        );
      },
    );
    await t.test(
      "a concurrent arrival after the mark statement snapshot remains unread",
      async () => {
        const lock = await db.owner.connect();
        try {
          await lock.query("BEGIN");
          await lock.query(
            "SELECT event_id FROM rootset_control.notification_receipts WHERE user_id=$1 AND read_at IS NULL FOR UPDATE",
            [userId],
          );
          const marking = withOrg(db.identity, orgId, (client) =>
            markAllNotificationsRead(client, actor),
          );
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const active = await db.owner.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE rootset_control.notification_receipts%'",
            );
            if (active.rowCount) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(
            waiting,
            "The mark statement must acquire its snapshot before the next arrival",
          );
          const later = await withOrg(db.identity, orgId, (client) =>
            publishNotification(client, {
              orgId,
              userId,
              dedupeKey: "concurrent-arrival",
              type: "backup.failed",
              occurredAt: new Date().toISOString(),
              payload,
            }),
          );
          await lock.query("COMMIT");
          await marking;
          const page = await read();
          assert.equal(page.unreadCount, 1);
          assert.equal(
            page.notifications.find((item) => item.id === later)?.readAt,
            null,
          );
          assert.equal((await read(other)).unreadCount, 0);
        } finally {
          await lock.query("ROLLBACK");
          lock.release();
        }
      },
    );
    await t.test(
      "removed membership cannot list or mark receipts, and runtime roles cannot alter their storage",
      async () => {
        const before = (await read()).unreadCount;
        await db.owner.query(
          "DELETE FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
          [orgId, userId],
        );
        await assert.rejects(read(), { code: "UNAUTHENTICATED" });
        await assert.rejects(
          service.execute(
            "markAllNotificationsRead",
            actor,
            {},
            { idempotencyKey: newId() },
          ),
          { code: "UNAUTHENTICATED" },
        );
        assert.equal(
          (
            await db.owner.query(
              "SELECT count(*)::integer count FROM rootset_control.notification_receipts WHERE user_id=$1 AND read_at IS NULL",
              [userId],
            )
          ).rows[0].count,
          before,
        );
        await assert.rejects(
          db.ddl.query(
            "ALTER TABLE rootset_control.notification_events ADD COLUMN forbidden text",
          ),
          { code: "42501" },
        );
        await assert.rejects(
          db.app.query("SELECT * FROM rootset_control.notification_receipts"),
          { code: "42501" },
        );
      },
    );
  } finally {
    await db.close();
  }
});
