import { z } from "zod";
import {
  CanonicalUtcDateTimeSchema,
  IdSchema,
  VersionSchema,
  SchemaVersionSchema,
  limits,
} from "./models";
export const RelationshipFilterSchema = z
  .array(
    z.strictObject({
      fieldId: IdSchema,
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
  )
  .min(1)
  .max(limits.maxUniqueFields);
export const RowRelationshipSchema = z.strictObject({
  id: IdSchema,
  tableId: IdSchema,
  tableName: z.string(),
  tableState: z.string(),
  fieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  fieldNames: z.array(z.string()).min(1).max(limits.maxUniqueFields),
  referencedFieldIds: z.array(IdSchema).min(1).max(limits.maxUniqueFields),
  count: z.number().int().nonnegative(),
  hasKey: z.boolean(),
});
export const RowRelationshipsSchema = z.strictObject({
  rowVersion: VersionSchema,
  asOf: CanonicalUtcDateTimeSchema,
  data: z.array(RowRelationshipSchema).max(20),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export const RelatedRowFilterSchema = z.strictObject({
  filter: RelationshipFilterSchema,
  schemaVersion: SchemaVersionSchema,
  referencedTableId: IdSchema,
  referencedRowId: IdSchema,
  referencedVersion: VersionSchema,
});
export type RowRelationship = z.infer<typeof RowRelationshipSchema>;
export type RowRelationships = z.infer<typeof RowRelationshipsSchema>;
export type RelatedRowFilter = z.infer<typeof RelatedRowFilterSchema>;
