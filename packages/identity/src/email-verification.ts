import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { transaction, type Pool } from "@rootset/database";
import { EmailOutbox } from "@rootset/email";

export function isPrivateVerificationRejection(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.body?.code === "EMAIL_VERIFICATION_LIMIT" ||
      error.body?.code === "EMAIL_VERIFICATION_COOLDOWN" ||
      error.body?.message === "This email address does not need verification.")
  );
}

export async function enqueueVerificationEmail(
  pool: Pool,
  outbox: EmailOutbox,
  input: { userId: string; email: string; name: string; actionUrl: string },
): Promise<void> {
  await transaction(pool, async (client) => {
    const user = (
      await client.query(
        "SELECT email,email_verified FROM rootset_control.users WHERE id=$1 FOR UPDATE",
        [input.userId],
      )
    ).rows[0];
    if (!user || user.email !== input.email || user.email_verified)
      throw new APIError("BAD_REQUEST", {
        message: "This email address does not need verification.",
      });
    const now = Date.now();
    const recent = await client.query<{ created_at: Date }>(
      "SELECT created_at FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-verification' AND created_at>$2 ORDER BY created_at DESC LIMIT 5",
      [input.email, new Date(now - 24 * 60 * 60_000)],
    );
    if (recent.rowCount === 5)
      throw new APIError("TOO_MANY_REQUESTS", {
        code: "EMAIL_VERIFICATION_LIMIT",
        message:
          "You’ve requested 5 confirmation emails in the last 24 hours. Try again later.",
      });
    if (recent.rows[0] && recent.rows[0].created_at.getTime() > now - 60_000)
      throw new APIError("TOO_MANY_REQUESTS", {
        code: "EMAIL_VERIFICATION_COOLDOWN",
        message:
          "Wait at least one minute before requesting another confirmation email.",
      });
    const expiresAt = new Date(now + 60 * 60_000);
    await outbox.enqueue(client, {
      template: "account-verification",
      to: input.email,
      payload: {
        name: input.name,
        actionUrl: input.actionUrl,
        expiresAt: expiresAt.toISOString(),
      },
      dedupeKey: `email-verify:${input.userId}:${createHash("sha256").update(input.actionUrl).digest("hex")}`,
      expiresAt,
    });
  });
}

export async function requestPublicVerificationEmail(input: {
  pool: Pool;
  hash: (value: string) => string;
  email: string;
  address: string;
  send: (email: string) => Promise<unknown>;
}): Promise<Response> {
  const started = performance.now();
  try {
    const now = Date.now();
    const blocked: Date[] = [];
    for (const [key, duration, limit] of [
      [`verification-address:${input.address}`, 60_000, 20],
      [`verification-email-minute:${input.email}`, 60_000, 1],
      [`verification-email-day:${input.email}`, 24 * 60 * 60_000, 5],
    ] as const) {
      const { rows } = await input.pool.query<{
        attempts: number;
        expires_at: Date;
      }>(
        "INSERT INTO rootset_control.identity_rate_limits(bucket_hash,attempts,expires_at) VALUES($1,1,$2) ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN identity_rate_limits.expires_at<=$3 THEN 1 ELSE identity_rate_limits.attempts+1 END,expires_at=CASE WHEN identity_rate_limits.expires_at<=$3 THEN EXCLUDED.expires_at ELSE identity_rate_limits.expires_at END RETURNING attempts,expires_at",
        [input.hash(key), new Date(now + duration), new Date(now)],
      );
      if (rows[0]!.attempts > limit) blocked.push(rows[0]!.expires_at);
    }
    if (blocked.length)
      return Response.json(
        {
          error: {
            code: "EMAIL_VERIFICATION_RATE_LIMITED",
            message: "Too many verification requests. Try again later.",
          },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(
              Math.max(
                ...blocked.map((expiry) =>
                  Math.max(1, Math.ceil((expiry.getTime() - now) / 1000)),
                ),
              ),
            ),
          },
        },
      );
    try {
      await input.send(input.email);
    } catch (error) {
      if (!isPrivateVerificationRejection(error)) throw error;
    }
    return Response.json({ status: true });
  } finally {
    await delay(Math.max(0, 500 - (performance.now() - started)));
  }
}
