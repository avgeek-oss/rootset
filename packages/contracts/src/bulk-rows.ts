import { z } from "zod";
import {
  IdSchema,
  JsonValueSchema,
  VersionSchema,
  SchemaVersionSchema,
} from "./models";

export const bulkRowsLimits = Object.freeze({
  rows: 200,
  sampleRows: 10,
  sampleBytes: 256 * 1024,
});
const values = z
  .record(z.string().min(1).max(64), JsonValueSchema)
  .refine(
    (value) => Object.keys(value).length > 0,
    "Choose at least one field to update",
  );
export const BulkRowsActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set"), values }),
  z.strictObject({ type: z.literal("duplicate") }),
  z.strictObject({ type: z.literal("delete") }),
]);
export const BulkRowsInputSchema = z.strictObject({
  expectedSchemaVersion: SchemaVersionSchema,
  rows: z
    .array(z.strictObject({ rowId: IdSchema, expectedVersion: VersionSchema }))
    .min(1)
    .max(bulkRowsLimits.rows)
    .refine(
      (rows) => new Set(rows.map((row) => row.rowId)).size === rows.length,
      "Select each record only once",
    ),
  action: BulkRowsActionSchema,
});
export type BulkRowsInput = z.infer<typeof BulkRowsInputSchema>;
export const BulkRowsIssueSchema = z.strictObject({
  index: z
    .number()
    .int()
    .nonnegative()
    .max(bulkRowsLimits.rows - 1),
  rowId: IdSchema,
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1024),
  fieldId: IdSchema.optional(),
  ruleId: IdSchema.optional(),
});
export const BulkRowsPreviewSchema = z.strictObject({
  action: z.enum(["set", "duplicate", "delete"]),
  total: z.number().int().positive().max(bulkRowsLimits.rows),
  valid: z.number().int().nonnegative().max(bulkRowsLimits.rows),
  schemaVersion: SchemaVersionSchema,
  issues: z.array(BulkRowsIssueSchema).max(bulkRowsLimits.rows),
  sample: z
    .array(
      z.strictObject({
        rowId: IdSchema,
        before: z.record(z.string(), JsonValueSchema),
        after: z.record(z.string(), JsonValueSchema).optional(),
      }),
    )
    .max(bulkRowsLimits.sampleRows),
});
export type BulkRowsPreview = z.infer<typeof BulkRowsPreviewSchema>;
export type BulkRowsIssue = z.infer<typeof BulkRowsIssueSchema>;
export const BulkRowsResultSchema = z.strictObject({
  mutationId: IdSchema,
  action: z.enum(["set", "duplicate", "delete"]),
  affected: z.number().int().positive().max(bulkRowsLimits.rows),
  createdIds: z.array(IdSchema).max(bulkRowsLimits.rows),
  deletedIds: z.array(IdSchema).max(bulkRowsLimits.rows),
});
export type BulkRowsResult = z.infer<typeof BulkRowsResultSchema>;
