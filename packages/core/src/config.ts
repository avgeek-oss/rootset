import { hkdfSync } from "node:crypto";
import { z } from "zod";

const secret = z.string().min(32);
const url = z.string().url();
function hasProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
const databaseUrl = url.refine(
  (value) => hasProtocol(value, ["postgres:", "postgresql:"]),
  "Use postgres:// or postgresql://",
);
const objectStorageUrl = url.refine(
  (value) => hasProtocol(value, ["http:", "https:"]),
  "Use http:// or https:// for the S3 endpoint",
);
const publicOrigin = url.refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === value &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))
    );
  } catch {
    return false;
  }
}, "Use an HTTPS or loopback HTTP origin");
const schema = z.object({
  ROOTSET_API_URL: publicOrigin,
  ROOTSET_WEB_URL: publicOrigin,
  ROOTSET_DATABASE_URL: databaseUrl,
  ROOTSET_SECRET: secret,
  ROOTSET_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  ROOTSET_PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  ROOTSET_S3_ENDPOINT: objectStorageUrl,
  ROOTSET_S3_REGION: z.string().default("us-east-1"),
  ROOTSET_S3_BUCKET: z.string().min(3),
  ROOTSET_S3_ACCESS_KEY: z.string().min(1),
  ROOTSET_S3_SECRET_KEY: z.string().min(16),
  ROOTSET_ARTIFACT_TEMP_DIR: z.string().trim().min(1).optional(),
  ROOTSET_SMTP_HOST: z.string().min(1),
  ROOTSET_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  ROOTSET_SMTP_USER: z.string().optional(),
  ROOTSET_SMTP_PASSWORD: z.string().optional(),
  ROOTSET_SMTP_SECURE: z.enum(["true", "false"]).default("true"),
  ROOTSET_EMAIL_FROM: z.string().email(),
  ROOTSET_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const v = schema.parse(env);
  const signingKey = (purpose: string) =>
    Buffer.from(
      hkdfSync("sha256", v.ROOTSET_SECRET, "rootset:v1", purpose, 32),
    ).toString("base64url");
  return {
    baseURL: new URL(v.ROOTSET_API_URL).origin,
    webURL: new URL(v.ROOTSET_WEB_URL).origin,
    databaseURL: v.ROOTSET_DATABASE_URL,
    secret: signingKey("auth"),
    bootstrapSecret: v.ROOTSET_SECRET,
    keyHashSecret: signingKey("api-keys"),
    cursorSecret: signingKey("cursors"),
    encryptionKey: Buffer.from(v.ROOTSET_ENCRYPTION_KEY, "hex").toString(
      "base64",
    ),
    port: v.ROOTSET_PORT,
    artifacts: {
      endpoint: v.ROOTSET_S3_ENDPOINT,
      region: v.ROOTSET_S3_REGION,
      bucket: v.ROOTSET_S3_BUCKET,
      accessKeyId: v.ROOTSET_S3_ACCESS_KEY,
      secretAccessKey: v.ROOTSET_S3_SECRET_KEY,
      tempDirectory: v.ROOTSET_ARTIFACT_TEMP_DIR,
    },
    smtp: {
      host: v.ROOTSET_SMTP_HOST,
      port: v.ROOTSET_SMTP_PORT,
      secure: v.ROOTSET_SMTP_SECURE === "true",
      auth: v.ROOTSET_SMTP_USER
        ? { user: v.ROOTSET_SMTP_USER, pass: v.ROOTSET_SMTP_PASSWORD }
        : undefined,
      from: v.ROOTSET_EMAIL_FROM,
    },
    logLevel: v.ROOTSET_LOG_LEVEL,
  };
}
