import { z } from "zod";
import { IdSchema, CanonicalUtcDateTimeSchema } from "./models";
import { isTimeZone } from "./date-time-preferences";

export const BackupDestinationSchema = z.strictObject({
  bucket: z
    .string()
    .trim()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)
    .refine(
      (value) => !value.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(value),
      "Use a valid S3 bucket name",
    ),
  prefix: z
    .string()
    .trim()
    .max(512)
    .transform((value) => value.replace(/^\/+|\/+$/g, ""))
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= 768,
      "The path prefix must fit within 768 UTF-8 bytes",
    )
    .refine(
      (value) =>
        !/[\u0000-\u001f\u007f\\]/.test(value) &&
        !value.split("/").some((part) => part === "." || part === ".."),
      "Use a bucket path without dot segments or control characters",
    ),
});
export const BackupCronSchema = z
  .string()
  .trim()
  .max(120)
  .regex(
    /^[\d*/,\-]+(?:\s+[\d*/,\-]+){4}$/,
    "Use five cron fields: minute, hour, day, month, weekday",
  );
export const BackupTimeZoneSchema = z
  .string()
  .max(100)
  .refine(isTimeZone, "Use an IANA timezone");
export const BackupTimingSchema = z.strictObject({
  cron: BackupCronSchema,
  timezone: BackupTimeZoneSchema,
});
export const BackupScheduleInputSchema = BackupDestinationSchema.extend({
  ...BackupTimingSchema.shape,
  expectedVersion: z.number().int().min(0).max(2147483646),
});
export const BackupScheduleSchema = BackupDestinationSchema.extend({
  ...BackupTimingSchema.shape,
  databaseId: IdSchema,
  version: z.number().int().positive(),
  backendId: z.string(),
  nextRunAt: CanonicalUtcDateTimeSchema.nullable(),
  testedAt: CanonicalUtcDateTimeSchema.nullable(),
  updatedAt: CanonicalUtcDateTimeSchema,
});
export const BackupScheduleResultSchema = z.strictObject({
  schedule: BackupScheduleSchema.nullable(),
  version: z.number().int().nonnegative(),
  pendingSaveJobId: IdSchema.nullable(),
  worker: z.strictObject({
    available: z.boolean(),
    backendId: z.string().nullable(),
    matchesSchedule: z.boolean(),
  }),
  nextRuns: z.array(CanonicalUtcDateTimeSchema),
});
export const DatabaseBackupSchema = z.strictObject({
  storageState: z.enum(["available", "deleting", "pruned"]),
  prunedAt: CanonicalUtcDateTimeSchema.nullable(),
  retentionError: z.string().nullable(),
  id: IdSchema,
  jobId: IdSchema.nullable(),
  kind: z.enum(["backup", "destination_test", "skipped"]),
  trigger: z.enum(["manual", "schedule"]),
  state: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "skipped",
    "partially_completed",
  ]),
  stage: z.string(),
  scheduledAt: CanonicalUtcDateTimeSchema,
  skippedUntil: CanonicalUtcDateTimeSchema.nullable(),
  snapshotAt: CanonicalUtcDateTimeSchema.nullable(),
  startedAt: CanonicalUtcDateTimeSchema.nullable(),
  completedAt: CanonicalUtcDateTimeSchema.nullable(),
  bucket: z.string(),
  objectKey: z.string().nullable(),
  sizeBytes: z.number().nonnegative().nullable(),
  checksum: z.string().nullable(),
  tableCount: z.number().int().nonnegative().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  attempt: z.number().int().nonnegative(),
  error: z.string().nullable(),
  note: z.string().nullable(),
});
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;
export type BackupScheduleInput = z.infer<typeof BackupScheduleInputSchema>;
export type BackupScheduleResult = z.infer<typeof BackupScheduleResultSchema>;
export type BackupDestination = z.infer<typeof BackupDestinationSchema>;
export type BackupTiming = z.infer<typeof BackupTimingSchema>;
export type DatabaseBackup = z.infer<typeof DatabaseBackupSchema>;
