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
const keyringSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  z.string().regex(/^[a-fA-F0-9]{64}$/),
);
const invalidKeyringMessage =
  "ROOTSET_ENCRYPTION_KEYS must be a JSON object mapping 1-64 character alphanumeric, underscore or hyphen key IDs to 64 hexadecimal characters";
const schema = z.object({
  ROOTSET_BASE_URL: url.refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
      );
    } catch {
      return false;
    }
  }, "Use HTTPS or loopback HTTP"),
  ROOTSET_DATABASE_URL: databaseUrl,
  ROOTSET_DDL_DATABASE_URL: databaseUrl,
  ROOTSET_IDENTITY_DATABASE_URL: databaseUrl,
  ROOTSET_AUTH_SECRET: secret,
  ROOTSET_KEY_HASH_SECRET: secret,
  ROOTSET_CURSOR_SECRET: secret,
  ROOTSET_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  ROOTSET_ENCRYPTION_KEYS: z.string().optional(),
  ROOTSET_ENCRYPTION_KEY_ID: z.string().min(1).default("primary"),
  ROOTSET_BOOTSTRAP_SECRET: secret,
  ROOTSET_PASSWORD_BREACH_CHECK: z.enum(["true", "false"]).default("true"),
  ROOTSET_PASSWORD_VERIFY_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(2),
  ROOTSET_PASSWORD_VERIFY_QUEUE_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(16),
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
  ROOTSET_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});

export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const v = schema.parse(env);
  let decodedKeys: unknown;
  try {
    decodedKeys = v.ROOTSET_ENCRYPTION_KEYS
      ? JSON.parse(v.ROOTSET_ENCRYPTION_KEYS)
      : v.ROOTSET_ENCRYPTION_KEY
        ? { [v.ROOTSET_ENCRYPTION_KEY_ID]: v.ROOTSET_ENCRYPTION_KEY }
        : {};
  } catch {
    throw new Error(invalidKeyringMessage);
  }
  const parsedKeys = keyringSchema.safeParse(decodedKeys);
  if (!parsedKeys.success) throw new Error(invalidKeyringMessage);
  const rawKeys = parsedKeys.data;
  if (!Object.hasOwn(rawKeys, v.ROOTSET_ENCRYPTION_KEY_ID))
    throw new Error(
      "The active encryption key must be present in ROOTSET_ENCRYPTION_KEYS or ROOTSET_ENCRYPTION_KEY",
    );
  const encryptionKeys: Record<string, string> = Object.fromEntries(
    Object.entries(rawKeys).map(([id, key]) => [
      id,
      Buffer.from(key, "hex").toString("base64"),
    ]),
  );
  return {
    baseURL: v.ROOTSET_BASE_URL,
    databaseURL: v.ROOTSET_DATABASE_URL,
    ddlDatabaseURL: v.ROOTSET_DDL_DATABASE_URL,
    identityDatabaseURL: v.ROOTSET_IDENTITY_DATABASE_URL,
    secret: v.ROOTSET_AUTH_SECRET,
    bootstrapSecret: v.ROOTSET_BOOTSTRAP_SECRET,
    passwordPolicy: {
      breachCheck: v.ROOTSET_PASSWORD_BREACH_CHECK === "true",
      maximumActive: v.ROOTSET_PASSWORD_VERIFY_CONCURRENCY,
      maximumWaiting: v.ROOTSET_PASSWORD_VERIFY_QUEUE_LIMIT,
    },
    keyHashSecret: v.ROOTSET_KEY_HASH_SECRET,
    cursorSecret: v.ROOTSET_CURSOR_SECRET,
    encryptionKeys,
    activeEncryptionKeyId: v.ROOTSET_ENCRYPTION_KEY_ID,
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
    workerConcurrency: v.ROOTSET_WORKER_CONCURRENCY,
  };
}
