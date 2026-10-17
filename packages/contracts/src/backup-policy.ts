import { z } from "zod";
import { CanonicalUtcDateTimeSchema, IdSchema } from "./models";

export const BackupPolicyInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative().max(2147483646),
  retentionCount: z.number().int().min(1).max(10000).nullable(),
  overdueGraceMinutes: z.number().int().min(5).max(1440),
});
export const BackupAlertSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(["failed", "overdue"]),
  backupId: IdSchema.nullable(),
  occurrenceAt: CanonicalUtcDateTimeSchema,
  detectedAt: CanonicalUtcDateTimeSchema,
  notifiedAt: CanonicalUtcDateTimeSchema.nullable(),
});
export const BackupPolicySchema = BackupPolicyInputSchema.omit({
  expectedVersion: true,
}).extend({
  databaseId: IdSchema,
  version: z.number().int().nonnegative(),
  updatedAt: CanonicalUtcDateTimeSchema.nullable(),
});
export const BackupPolicyResultSchema = z.strictObject({
  policy: BackupPolicySchema,
  emailDeliveryAvailable: z.boolean(),
  lastSuccessful: z
    .strictObject({
      backupId: IdSchema,
      snapshotAt: CanonicalUtcDateTimeSchema,
      completedAt: CanonicalUtcDateTimeSchema,
      bucket: z.string(),
      objectKey: z.string(),
    })
    .nullable(),
  alerts: z.array(BackupAlertSchema).max(20),
  retentionError: z.string().nullable(),
});
export type BackupPolicyInput = z.infer<typeof BackupPolicyInputSchema>;
export type BackupPolicyResult = z.infer<typeof BackupPolicyResultSchema>;

export interface BackupAlertNotice {
  id: string;
  orgId: string;
  databaseId: string;
  databaseName: string;
  kind: "failed" | "overdue";
  occurrenceAt: string;
  lastSuccessfulAt: string | null;
}
