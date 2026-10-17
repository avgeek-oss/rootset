import { z } from "zod";
import { limits, RootsetError, type FieldDefinition } from "./models";
import {
  FilterNodeSchema,
  preflightQuery,
  QuerySpecSchema,
  validateQuery,
} from "./query";
import { stableViewQuery } from "./views";

export const ExportViewQuerySchema = z
  .preprocess(
    preflightQuery,
    z.strictObject({
      select: z.array(z.string().min(1).max(64)).min(1).max(limits.maxFields),
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
          path: issue.path,
          message: issue.message,
        });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536)
      context.addIssue({
        code: "custom",
        message: "An export view supports up to 64 KiB of filters and columns",
      });
  });
export type ExportViewQuery = z.infer<typeof ExportViewQuerySchema>;

export function normalizeExportViewQuery(
  input: unknown,
  fields: readonly FieldDefinition[],
): ExportViewQuery {
  const query = ExportViewQuerySchema.parse(input);
  const resolved = validateQuery(query, fields);
  const ids = new Map(fields.map((field) => [field.name, field.id]));
  const select = resolved.select!.map((name) => ids.get(name)!);
  if (new Set(select).size !== select.length)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Export columns must be distinct",
    );
  return { ...stableViewQuery(query, fields), select };
}
