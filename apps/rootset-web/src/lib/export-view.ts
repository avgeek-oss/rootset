import {
  normalizeExportViewQuery,
  type ExportViewQuery,
  type FieldDefinition,
  type QuerySpec,
} from "@rootset/contracts";

export function exportViewQuery(
  query: QuerySpec,
  fields: readonly FieldDefinition[],
  columnIds: readonly string[],
): ExportViewQuery {
  return normalizeExportViewQuery(
    {
      select: [...columnIds],
      ...(query.where ? { where: query.where } : {}),
      ...(query.orderBy?.length ? { orderBy: query.orderBy } : {}),
    },
    fields,
  );
}
