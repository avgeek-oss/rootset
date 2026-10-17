import { z } from "zod";
import { CanonicalUtcDateTimeSchema, IdSchema } from "./models";

export const ActivityCategorySchema = z.enum([
  "records",
  "schema",
  "imports",
  "exports",
  "backups",
  "restores",
]);
export type ActivityCategory = z.infer<typeof ActivityCategorySchema>;
export const ActivityInputSchema = z
  .strictObject({
    orgId: IdSchema,
    databaseId: IdSchema.optional(),
    tableId: IdSchema.optional(),
    category: ActivityCategorySchema.optional(),
    q: z.string().trim().max(200).optional(),
    from: CanonicalUtcDateTimeSchema.optional(),
    to: CanonicalUtcDateTimeSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(131200).nullable().optional(),
  })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: "The start date must be before the end date",
    path: ["from"],
  });
export type ActivityInput = z.infer<typeof ActivityInputSchema>;
const resource = z.strictObject({
  id: IdSchema,
  name: z.string(),
  state: z.enum(["active", "maintenance", "deleted"]),
});
export const ActivityEventSchema = z.strictObject({
  id: z.string(),
  category: ActivityCategorySchema,
  occurredAt: CanonicalUtcDateTimeSchema,
  summary: z.string(),
  status: z.enum([
    "requested",
    "succeeded",
    "failed",
    "cancelled",
    "partially_completed",
    "resolved",
  ]),
  actor: z.strictObject({
    id: z.string().nullable(),
    kind: z.string(),
    name: z.string(),
  }),
  database: resource.nullable(),
  table: resource.nullable(),
  rowId: IdSchema.nullable(),
  affectedRows: z.number().int().nonnegative().nullable(),
  jobId: IdSchema.nullable(),
  fileName: z.string().nullable(),
  destination: z
    .enum([
      "record",
      "table",
      "database",
      "imports",
      "exports",
      "database-exports",
      "backup-history",
      "backup-schedule",
    ])
    .nullable(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export const ActivityPageSchema = z.strictObject({
  data: z.array(ActivityEventSchema).max(100),
  asOf: CanonicalUtcDateTimeSchema,
  startCursor: z.string(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  availableCategories: z.array(ActivityCategorySchema),
  scope: z.strictObject({
    database: resource.nullable(),
    table: resource.nullable(),
  }),
});
export type ActivityPage = z.infer<typeof ActivityPageSchema>;
