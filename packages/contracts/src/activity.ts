import { z } from "zod";
import {
  CanonicalUtcDateTimeSchema,
  IdSchema,
  JsonValueSchema,
} from "./models";
import { ActivityEventNameSchema } from "./activity-events";

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
    workspaceId: IdSchema,
    databaseId: IdSchema.optional(),
    tableId: IdSchema.optional(),
    category: ActivityCategorySchema.optional(),
    event: ActivityEventNameSchema.optional(),
    actor: z.string().min(1).max(256).optional(),
    resource: z
      .string()
      .regex(/^(database|table):[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
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
  event: ActivityEventNameSchema,
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
    key: z.string(),
    kind: z.string(),
    name: z.string(),
    avatarUrl: z.url().nullable(),
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

export const ActivityDetailsInputSchema = z.strictObject({
  orgId: IdSchema,
  workspaceId: IdSchema,
  eventId: z
    .string()
    .regex(
      /^(?:[mj]:[0-9A-HJKMNP-TV-Z]{26}|r:[1-9][0-9]{0,18}|a:[0-9A-HJKMNP-TV-Z]{26}:(?:detected|resolved))$/,
    )
    .refine(
      (value) =>
        !value.startsWith("r:") ||
        (/^r:\d+$/.test(value) &&
          BigInt(value.slice(2)) <= 9223372036854775807n),
      "Invalid audit event ID",
    ),
});
export const ActivityDetailsSchema = z.strictObject({
  event: ActivityEventNameSchema,
  occurredAt: CanonicalUtcDateTimeSchema,
  actor: z.string(),
  resource: z
    .strictObject({
      type: z.enum(["database", "table"]),
      id: IdSchema,
      name: z.string(),
    })
    .nullable(),
  context: z.record(z.string(), JsonValueSchema),
});
export type ActivityDetails = z.infer<typeof ActivityDetailsSchema>;

export const ActivityFilterInputSchema = z.strictObject({
  orgId: IdSchema,
  workspaceId: IdSchema,
  kind: z.enum(["actors", "resources"]),
  q: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const ActivityFilterOptionsSchema = z.strictObject({
  data: z
    .array(
      z.strictObject({
        value: z.string(),
        label: z.string(),
        kind: z.enum(["actor", "database", "table"]),
        avatarUrl: z.url().nullable(),
        description: z.string().nullable(),
      }),
    )
    .max(100),
  hasMore: z.boolean(),
});
export type ActivityFilterOptions = z.infer<typeof ActivityFilterOptionsSchema>;
