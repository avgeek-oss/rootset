import { z } from "zod";
import { CanonicalUtcDateTimeSchema, IdSchema } from "./models";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RestorePreviewSchema = z.strictObject({
  backupId: IdSchema,
  sourceDatabaseId: IdSchema,
  sourceDatabaseName: z.string(),
  snapshotAt: CanonicalUtcDateTimeSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: CanonicalUtcDateTimeSchema,
  rowCount: count,
  commentCount: count,
  historyEvents: count,
  mutationCount: count,
  viewCount: count,
  tables: z
    .array(
      z.strictObject({
        id: IdSchema,
        name: z.string(),
        schemaVersion: z.number().int().positive(),
        fieldCount: count,
        rowCount: count,
        uniqueRules: count,
        foreignKeys: count,
      }),
    )
    .max(1000),
});
export const DatabaseRestoreResultSchema = z.strictObject({
  databaseId: IdSchema,
  sourceDatabaseId: IdSchema,
  sourceBackupId: IdSchema,
  snapshotAt: CanonicalUtcDateTimeSchema,
  tableCount: count,
  rowCount: count,
  commentCount: count,
  historyEvents: count,
  mutationCount: count,
  viewCount: count,
  skippedPersonalViews: count,
});
export type RestorePreview = z.infer<typeof RestorePreviewSchema>;
export type DatabaseRestoreResult = z.infer<typeof DatabaseRestoreResultSchema>;
