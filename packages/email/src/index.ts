import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { createElement } from "react";
import { render } from "@react-email/render";
import { EmailShell } from "./email-shell";
import { newId, RootsetError } from "@rootset/contracts";
import { transaction, type Pool, type PoolClient } from "@rootset/database";

export interface EncryptionConfig {
  encryptionKeys: Record<string, string>;
  activeEncryptionKeyId: string;
}
export function encryptProtected(
  value: unknown,
  config: EncryptionConfig,
): string {
  const key = Buffer.from(
    config.encryptionKeys[config.activeEncryptionKeyId] ?? "",
    "base64",
  );
  if (key.length !== 32)
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "An encryption key must contain 32 bytes",
      500,
    );
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`rootset:v1:${config.activeEncryptionKeyId}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    config.activeEncryptionKeyId,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}
export function decryptProtected<T>(
  value: string,
  config: EncryptionConfig,
): T {
  const [keyId, iv, tag, ciphertext, ...extra] = value.split(":");
  if (!keyId || !iv || !tag || ciphertext === undefined || extra.length)
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "Protected data is invalid",
      500,
    );
  const key = Buffer.from(config.encryptionKeys[keyId] ?? "", "base64");
  if (key.length !== 32)
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "The protected-data key is unavailable",
      500,
    );
  const ivBytes = Buffer.from(iv, "base64url"),
    tagBytes = Buffer.from(tag, "base64url"),
    ciphertextBytes = Buffer.from(ciphertext, "base64url");
  if (
    ivBytes.length !== 12 ||
    tagBytes.length !== 16 ||
    ivBytes.toString("base64url") !== iv ||
    tagBytes.toString("base64url") !== tag ||
    ciphertextBytes.toString("base64url") !== ciphertext
  )
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "Protected data encoding is invalid",
      500,
    );
  const decipher = createDecipheriv("aes-256-gcm", key, ivBytes);
  decipher.setAAD(Buffer.from(`rootset:v1:${keyId}`));
  decipher.setAuthTag(tagBytes);
  return JSON.parse(
    Buffer.concat([
      decipher.update(ciphertextBytes),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}
export const emailTemplates = {
  invitation: {
    subject: "You're invited to Rootset",
    title: "Join your team",
    body: "You have been invited to an organisation in Rootset.",
    action: "Accept invitation",
  },
  "invitation-verification": {
    subject: "Verify your Rootset invitation",
    title: "Verify your email",
    body: "Confirm this email address before joining your team.",
    action: "Verify email",
  },
  "account-verification": {
    subject: "Verify your Rootset email",
    title: "Verify your email",
    body: "Confirm your email address to finish setting up your Rootset account.",
    action: "Verify email",
  },
  "password-reset": {
    subject: "Reset your Rootset password",
    title: "Reset your password",
    body: "Use the link below to choose a new password. Your second factor will remain enabled.",
    action: "Reset password",
  },
  "password-changed": {
    subject: "Your Rootset password changed",
    title: "Password changed",
    body: "Your password changed and existing sessions were revoked. If you did not make this change, contact your installation operator.",
  },
  "email-change-verification": {
    subject: "Confirm your new Rootset email",
    title: "Confirm your new email",
    body: "Your existing email remains active until you confirm this address.",
    action: "Confirm email",
  },
  "email-changed": {
    subject: "Your Rootset email changed",
    title: "Email changed",
    body: "Your Rootset account email changed. Existing sessions and delegated access were revoked. Contact your installation operator if you did not request this.",
  },
  "factor-changed": {
    subject: "Your Rootset security settings changed",
    title: "Security settings changed",
    body: "An authentication factor or recovery codes changed. Contact your installation operator if you did not request this.",
  },
  "team-key-created": {
    subject: "A Rootset team key was created",
    title: "Team API key created",
    body: "A new organisation-owned API key was created. Review the key's scopes, targets and expiry in team settings.",
  },
  "team-key-revoked": {
    subject: "A Rootset team key was revoked",
    title: "Team API key revoked",
    body: "An organisation-owned API key was revoked. Integrations using that key can no longer authenticate.",
  },
  "account-recovery": {
    subject: "Your Rootset account was recovered",
    title: "Account recovery performed",
    body: "Your installation operator performed account recovery. Existing sessions and delegated access were revoked. Check your security settings before reconnecting integrations.",
  },
  "backup-verified": {
    subject: "Your Rootset backup was verified",
    title: "Backup verified",
    body: "Your database backup completed and passed its verification checks. Review the backup in Rootset before planning a restore.",
    action: "View backups",
  },
  "backup-failed": {
    subject: "Your Rootset backup did not complete",
    title: "Backup needs attention",
    body: "Your database backup did not complete successfully. Review its status and retry after resolving the reported issue.",
    action: "View backups",
  },
  "operator-access-changed": {
    subject: "Your Rootset operator access changed",
    title: "Installation operator access changed",
    body: "Your installation operator changed your installation authority through the deployment CLI. This authority is separate from your organisation role. Contact your operator if you did not expect this change.",
  },
} as const;
export type EmailTemplate = keyof typeof emailTemplates;
export interface EmailPayload {
  name?: string;
  organisationName?: string;
  actionUrl?: string;
  expiresAt?: string;
  details?: string;
}
export async function renderEmail(
  template: EmailTemplate,
  payload: EmailPayload,
  baseURL: string,
): Promise<{ subject: string; html: string; text: string }> {
  const entry = emailTemplates[template];
  if (!entry)
    throw new RootsetError("VALIDATION_FAILED", "Unknown email template");
  const url = payload.actionUrl ? new URL(payload.actionUrl) : undefined;
  if (
    url &&
    (url.origin !== new URL(baseURL).origin ||
      !["http:", "https:"].includes(url.protocol))
  )
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "Email action origin is invalid",
      500,
    );
  const greeting = payload.name ? `Hello ${payload.name},` : "Hello,";
  const context = [
    payload.organisationName && `Organisation: ${payload.organisationName}`,
    payload.details,
    payload.expiresAt && `Expires: ${payload.expiresAt} (UTC)`,
  ]
    .filter(Boolean)
    .join("\n");
  const action = url && "action" in entry ? entry.action : undefined;
  const text = [
    "Rootset",
    entry.title,
    greeting,
    entry.body,
    context,
    action && `${action}: ${url!.href}`,
    "If you did not request this, contact your installation operator.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const html = await render(
    createElement(EmailShell, {
      title: entry.title,
      body: entry.body,
      name: payload.name,
      context,
      actionUrl: url?.href,
      actionLabel: action,
    }),
  );
  return { subject: entry.subject, html, text };
}
export interface EmailConfig extends EncryptionConfig {
  baseURL: string;
  smtp?: {
    host: string;
    port: number;
    secure?: boolean;
    user?: string;
    password?: string;
    from: string;
  };
}
export class EmailOutbox {
  constructor(
    private readonly pool: Pool,
    private readonly config: EmailConfig,
  ) {}
  async verifyConnection(): Promise<void> {
    const smtp = this.config.smtp;
    if (!smtp) throw new Error("SMTP is not configured");
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure ?? false,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  }
  async enqueue(
    client: PoolClient | Pool,
    input: {
      template: EmailTemplate;
      to: string;
      payload: EmailPayload;
      dedupeKey: string;
      expiresAt?: Date;
    },
  ): Promise<string> {
    await renderEmail(input.template, input.payload, this.config.baseURL);
    const id = newId();
    const result = await client.query<{ id: string }>(
      `INSERT INTO rootset_control.email_outbox(id,to_address,template,payload_encrypted,dedupe_key,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id`,
      [
        id,
        input.to,
        input.template,
        encryptProtected(input.payload, this.config),
        input.dedupeKey,
        input.expiresAt ?? null,
      ],
    );
    return result.rows[0]!.id;
  }
  async deliverNext(): Promise<boolean> {
    if (!this.config.smtp) return false;
    const row = await transaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT * FROM rootset_control.email_outbox WHERE (state='pending' AND next_attempt_at<=now()) OR (state='sending' AND lease_until<now()) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const item = result.rows[0];
      if (!item) return undefined;
      await client.query(
        `UPDATE rootset_control.email_outbox SET state='sending',attempts=attempts+1,lease_until=now()+interval '2 minutes' WHERE id=$1`,
        [item.id],
      );
      return item;
    });
    if (!row) return false;
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await this.pool.query(
        `UPDATE rootset_control.email_outbox SET state='failed',payload_encrypted='',last_error='Message expired',lease_until=NULL WHERE id=$1`,
        [row.id],
      );
      return true;
    }
    const smtp = this.config.smtp;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure ?? false,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      connectionTimeout: 15000,
      socketTimeout: 30000,
    });
    try {
      const rendered = await renderEmail(
        row.template as EmailTemplate,
        decryptProtected<EmailPayload>(row.payload_encrypted, this.config),
        this.config.baseURL,
      );
      const result = await transport.sendMail({
        from: smtp.from,
        to: row.to_address,
        ...rendered,
        messageId: `<${row.id}@${new URL(this.config.baseURL).hostname}>`,
      });
      await this.pool.query(
        `UPDATE rootset_control.email_outbox SET state='sent',sent_at=now(),lease_until=NULL,provider_id=$2,last_error=NULL,payload_encrypted='' WHERE id=$1`,
        [row.id, result.messageId],
      );
    } catch {
      const attempt = Number(row.attempts) + 1;
      await this.pool.query(
        `UPDATE rootset_control.email_outbox SET state=$2,next_attempt_at=now()+($3 * interval '1 second'),lease_until=NULL,last_error='SMTP delivery failed' WHERE id=$1`,
        [
          row.id,
          attempt >= 8 ? "failed" : "pending",
          Math.min(3600, 15 * 2 ** attempt),
        ],
      );
    } finally {
      transport.close();
    }
    return true;
  }
  async drain(limit = 100): Promise<number> {
    let n = 0;
    while (n < limit && (await this.deliverNext())) n++;
    return n;
  }
}
