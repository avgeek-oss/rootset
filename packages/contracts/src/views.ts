import { z } from "zod";
import {
  AccountNameSchema,
  CanonicalUtcDateTimeSchema,
  IdSchema,
  RootsetError,
  SchemaVersionSchema,
  VersionSchema,
  ViewPreferencesSchema,
  limits,
  type FieldDefinition,
} from "./models";
import {
  FilterNodeSchema,
  QuerySpecSchema,
  preflightQuery,
  validateQuery,
  type FilterNode,
} from "./query";

export const savedViewLimits = Object.freeze({
  perScope: 100,
  definitionBytes: 65_536,
});
export const SavedViewVisibilitySchema = z.enum(["personal", "shared"]);
const ViewQuerySchema = z
  .preprocess(
    preflightQuery,
    z.strictObject({
      where: FilterNodeSchema.optional(),
      orderBy: z
        .array(
          z.strictObject({
            field: z.string().min(1).max(64),
            direction: z.enum(["asc", "desc"]),
          }),
        )
        .max(limits.querySorts)
        .optional(),
    }),
  )
  .superRefine((value, context) => {
    const result = QuerySpecSchema.safeParse(value);
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
  });
export const SavedViewDefinitionSchema = ViewPreferencesSchema.omit({
  query: true,
  foreignKeyDisplayFields: true,
})
  .extend({ query: ViewQuerySchema })
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      savedViewLimits.definitionBytes
    )
      context.addIssue({
        code: "custom",
        message: "A saved view supports up to 64 KiB of filters and layout",
      });
    if (
      new Set(value.columnOrder).size !== value.columnOrder.length ||
      new Set(value.hiddenColumns).size !== value.hiddenColumns.length
    )
      context.addIssue({
        code: "custom",
        message: "Column order and visibility must contain distinct fields",
      });
  });
export type SavedViewDefinition = z.infer<typeof SavedViewDefinitionSchema>;
export const SavedViewSummarySchema = z.strictObject({
  id: IdSchema,
  tableId: IdSchema,
  name: AccountNameSchema,
  visibility: SavedViewVisibilitySchema,
  ownerUserId: IdSchema.nullable(),
  ownerName: z.string(),
  version: VersionSchema,
  schemaVersion: SchemaVersionSchema,
  canEdit: z.boolean(),
  canChangeVisibility: z.boolean(),
  createdAt: CanonicalUtcDateTimeSchema,
  updatedAt: CanonicalUtcDateTimeSchema,
});
export const SavedViewSchema = SavedViewSummarySchema.extend({
  definition: SavedViewDefinitionSchema,
  validationErrors: z.array(z.string()).max(limits.maxFields),
});
export type SavedViewSummary = z.infer<typeof SavedViewSummarySchema>;
export type SavedView = z.infer<typeof SavedViewSchema>;

export function normalizeSavedViewDefinition(
  input: unknown,
  fields: readonly FieldDefinition[],
): SavedViewDefinition {
  const definition = SavedViewDefinitionSchema.parse(input);
  const ids = new Set(fields.map((field) => field.id));
  if (
    [
      ...definition.columnOrder,
      ...definition.hiddenColumns,
      ...Object.keys(definition.columnWidths),
    ].some((id) => !ids.has(id))
  )
    throw new RootsetError(
      "VALIDATION_FAILED",
      "The layout refers to a field that no longer exists",
    );
  if (
    definition.frozenColumns >
    fields.length - definition.hiddenColumns.length
  )
    throw new RootsetError(
      "VALIDATION_FAILED",
      "The frozen column count exceeds the visible fields",
    );
  return {
    ...definition,
    columnOrder: [
      ...definition.columnOrder,
      ...fields
        .filter((field) => !definition.columnOrder.includes(field.id))
        .map((field) => field.id),
    ],
    query: stableViewQuery(definition.query, fields),
  };
}

export function stableViewQuery(
  input: SavedViewDefinition["query"],
  fields: readonly FieldDefinition[],
): SavedViewDefinition["query"] {
  const query = validateQuery(input, fields);
  const names = new Map(fields.map((field) => [field.name, field.id]));
  function stable(node: FilterNode): FilterNode {
    if ("field" in node) return { ...node, field: names.get(node.field)! };
    return "and" in node
      ? { and: node.and.map(stable) }
      : { or: node.or.map(stable) };
  }
  return {
    ...(query.where ? { where: stable(query.where) } : {}),
    ...(query.orderBy?.length
      ? {
          orderBy: query.orderBy.map((sort) => ({
            ...sort,
            field: names.get(sort.field)!,
          })),
        }
      : {}),
  };
}

export function resolveSavedViewDefinition(
  input: SavedViewDefinition,
  fields: readonly FieldDefinition[],
): { definition: SavedViewDefinition; validationErrors: string[] } {
  const ids = new Set(fields.map((field) => field.id));
  const hiddenColumns = input.hiddenColumns.filter((id) => ids.has(id));
  const definition: SavedViewDefinition = {
    ...input,
    columnOrder: [
      ...input.columnOrder.filter((id) => ids.has(id)),
      ...fields
        .filter((field) => !input.columnOrder.includes(field.id))
        .map((field) => field.id),
    ],
    columnWidths: Object.fromEntries(
      Object.entries(input.columnWidths).filter(([id]) => ids.has(id)),
    ),
    hiddenColumns,
    frozenColumns: Math.min(
      input.frozenColumns,
      fields.length - hiddenColumns.length,
    ),
  };
  try {
    return {
      definition: normalizeSavedViewDefinition(definition, fields),
      validationErrors: [],
    };
  } catch (error) {
    if (!(error instanceof RootsetError)) throw error;
    return { definition, validationErrors: [error.message] };
  }
}
