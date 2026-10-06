import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  IdSchema,
  NotificationPageSchema,
  NotificationSchema,
  RootsetError,
  newId,
  type Actor,
  type Notification,
  type NotificationPage,
} from "@rootset/contracts";
import type { PoolClient } from "@rootset/database";

const querySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2048).nullable().optional(),
});
const cursorSchema = z.strictObject({
  version: z.literal(1),
  binding: z.string(),
  time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: IdSchema,
  expires: z.number().int(),
});
function invalidCursor(): never {
  throw new RootsetError(
    "CURSOR_INVALID",
    "Notification cursor is invalid or belongs to a different request",
    400,
  );
}
function signature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest();
}
function binding(actor: Actor, limit: number) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        actor.orgId,
        actor.userId,
        actor.kind,
        actor.id,
        actor.credentialId,
        actor.membershipVersion,
        actor.role,
        [...actor.scopes].sort(),
        limit,
      ]),
    )
    .digest("hex");
}

export async function listNotifications(
  client: PoolClient,
  actor: Actor,
  value: unknown,
  secret: string,
): Promise<NotificationPage> {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Invalid notification pagination",
      422,
    );
  const { limit, cursor } = parsed.data;
  const owner = binding(actor, limit);
  let time: string | null = null;
  let id: string | null = null;
  if (cursor) {
    const [encoded, mac, extra] = cursor.split(".");
    if (!encoded || !mac || extra) invalidCursor();
    const actual = Buffer.from(mac, "base64url"),
      expected = signature(encoded, secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      invalidCursor();
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      invalidCursor();
    }
    const checked = cursorSchema.safeParse(decoded);
    if (
      !checked.success ||
      checked.data.binding !== owner ||
      checked.data.expires < Date.now()
    )
      invalidCursor();
    time = checked.data.time;
    id = checked.data.id;
  }
  // A single statement shares the snapshot between the badge and page. The
  // signed cursor retains PostgreSQL microseconds instead of JS Date rounding.
  const result = (
    await client.query<{
      unreadCount: number;
      rows: Array<{ event: Notification; cursorTime: string }>;
    }>(
      `WITH owned AS (
    SELECT e.*,r.read_at FROM rootset_control.notification_events e
    JOIN rootset_control.notification_receipts r ON r.org_id=e.org_id AND r.event_id=e.id
    WHERE e.org_id=$1 AND r.user_id=$2
  ), page AS (
    SELECT * FROM owned WHERE (read_at IS NULL OR read_at>=statement_timestamp()-interval '24 hours')
    AND ($3::timestamptz IS NULL OR (occurred_at,id)<($3::timestamptz,$4::varchar))
    ORDER BY occurred_at DESC,id DESC LIMIT $5
  ) SELECT (SELECT count(*)::integer FROM owned WHERE read_at IS NULL) AS "unreadCount",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'event',jsonb_build_object('id',id,'type',type,'payload',payload,
        'occurredAt',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'readAt',CASE WHEN read_at IS NULL THEN NULL ELSE to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END),
      'cursorTime',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) ORDER BY occurred_at DESC,id DESC) FROM page),'[]'::jsonb) AS rows`,
      [actor.orgId, actor.userId, time, id, limit + 1],
    )
  ).rows[0];
  if (!result)
    throw new RootsetError(
      "DEPENDENCY_UNAVAILABLE",
      "Notification query did not return a result",
      503,
    );
  const rows = result.rows.slice(0, limit),
    last = rows.at(-1);
  let nextCursor: string | null = null;
  if (result.rows.length > limit && last) {
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        binding: owner,
        time: last.cursorTime,
        id: last.event.id,
        expires: Date.now() + 86_400_000,
      }),
    ).toString("base64url");
    nextCursor = `${encoded}.${signature(encoded, secret).toString("base64url")}`;
  }
  return NotificationPageSchema.parse({
    notifications: rows.map((row) => row.event),
    unreadCount: result.unreadCount,
    nextCursor,
  });
}

export async function markAllNotificationsRead(
  client: PoolClient,
  actor: Actor,
) {
  // UPDATE sees existing receipts in one statement snapshot. New arrivals stay
  // unread, and the predicate plus database guard preserve the first read time.
  await client.query(
    `UPDATE rootset_control.notification_receipts
    SET read_at=statement_timestamp() WHERE org_id=$1 AND user_id=$2 AND read_at IS NULL`,
    [actor.orgId, actor.userId],
  );
  return { ok: true as const };
}

export async function publishNotification(
  client: PoolClient,
  input: {
    orgId: string;
    userId: string;
    dedupeKey: string;
    type: Notification["type"];
    occurredAt: string;
    payload: Notification["payload"];
  },
) {
  const event = NotificationSchema.parse({
    id: newId(),
    type: input.type,
    occurredAt: input.occurredAt,
    createdAt: new Date().toISOString(),
    payload: input.payload,
    readAt: null,
  });
  await client.query(
    `INSERT INTO rootset_control.notification_events
    (id,org_id,dedupe_key,type,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(org_id,dedupe_key) DO NOTHING`,
    [
      event.id,
      input.orgId,
      input.dedupeKey,
      event.type,
      event.occurredAt,
      event.payload,
    ],
  );
  const row = (
    await client.query<{ id: string }>(
      "SELECT id FROM rootset_control.notification_events WHERE org_id=$1 AND dedupe_key=$2",
      [input.orgId, input.dedupeKey],
    )
  ).rows[0];
  if (!row)
    throw new RootsetError(
      "DEPENDENCY_UNAVAILABLE",
      "Notification publication was not persisted",
      503,
    );
  await client.query(
    `INSERT INTO rootset_control.notification_receipts(org_id,user_id,event_id)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [input.orgId, input.userId, row.id],
  );
  return row.id;
}
