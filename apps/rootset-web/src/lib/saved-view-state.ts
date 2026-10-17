import { ZodError } from "zod";
import {
  canonicalJson,
  RootsetError,
  normalizeSavedViewDefinition,
  resolveSavedViewDefinition,
  type FieldDefinition,
  type FilterNode,
  type QuerySpec,
  type SavedViewDefinition,
} from "@rootset/contracts";
import type { FilterCombination, FilterCondition } from "./table-filters";

export type ViewLayout = Pick<
  SavedViewDefinition,
  "columnOrder" | "columnWidths" | "hiddenColumns" | "frozenColumns"
>;
export function orderedViewFields(
  fields: readonly FieldDefinition[],
  layout: ViewLayout,
): FieldDefinition[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const order = [
    ...new Set([...layout.columnOrder, ...fields.map((field) => field.id)]),
  ];
  return order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}
export function resolvedViewLayout(
  fields: readonly FieldDefinition[],
  layout: ViewLayout,
): ViewLayout {
  const ids = new Set(fields.map((field) => field.id));
  const hiddenColumns = layout.hiddenColumns.filter((id) => ids.has(id));
  return {
    columnOrder: orderedViewFields(fields, layout).map((field) => field.id),
    columnWidths: Object.fromEntries(
      Object.entries(layout.columnWidths).filter(([id]) => ids.has(id)),
    ),
    hiddenColumns,
    frozenColumns: Math.min(
      layout.frozenColumns,
      fields.length - hiddenColumns.length,
    ),
  };
}
export function visibleViewFields(
  fields: readonly FieldDefinition[],
  layout: ViewLayout,
): FieldDefinition[] {
  return orderedViewFields(fields, layout).filter(
    (field) => !layout.hiddenColumns.includes(field.id),
  );
}
export function viewDefinition(
  layout: ViewLayout,
  query: QuerySpec,
): SavedViewDefinition {
  return {
    columnOrder: layout.columnOrder,
    columnWidths: layout.columnWidths,
    frozenColumns: layout.frozenColumns,
    hiddenColumns: layout.hiddenColumns,
    query: {
      ...(query.where ? { where: query.where } : {}),
      ...(query.orderBy?.length ? { orderBy: query.orderBy } : {}),
    },
  };
}
export function savedViewDirty(
  definition: SavedViewDefinition,
  saved: SavedViewDefinition,
  fields: readonly FieldDefinition[],
): boolean {
  const baseline = resolveSavedViewDefinition(saved, fields).definition;
  let current = definition;
  try {
    current = normalizeSavedViewDefinition(definition, fields);
  } catch (error) {
    if (!(error instanceof RootsetError) && !(error instanceof ZodError))
      throw error;
  }
  return (
    canonicalJson(current, { maxDepth: 96 }) !==
    canonicalJson(baseline, { maxDepth: 96 })
  );
}
export function savedViewFilterState(
  where: FilterNode | undefined,
  fields: readonly FieldDefinition[],
): {
  conditions: FilterCondition[];
  combination: FilterCombination;
  advanced?: FilterNode;
} {
  if (!where) return { conditions: [], combination: "and" };
  const nodes =
    "field" in where ? [where] : "and" in where ? where.and : where.or;
  const combination = "or" in where ? "or" : "and";
  if (nodes.some((node) => !("field" in node)))
    return { conditions: [], combination, advanced: where };
  return {
    combination,
    conditions: nodes.map((node, index) => {
      if (!("field" in node)) throw new Error("Expected a simple predicate");
      const field = fields.find(
        (field) => field.id === node.field || field.name === node.field,
      );
      return {
        id: `view-${index}`,
        fieldId: field?.id ?? node.field,
        operator: node.op,
        value:
          node.value === undefined
            ? ""
            : field?.type === "json" || ["in", "between"].includes(node.op)
              ? JSON.stringify(node.value)
              : String(node.value),
        path: node.path ? JSON.stringify(node.path) : "",
      };
    }),
  };
}
export function linkedViewQuery(
  query: SavedViewDefinition["query"],
  linked?: FilterNode,
): QuerySpec {
  return {
    ...query,
    ...(linked
      ? { where: query.where ? { and: [query.where, linked] } : linked }
      : {}),
  };
}
export function savedViewPath(
  databaseId: string,
  tableId: string,
  viewId: string | null,
): string {
  const path = `/databases/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(tableId)}`;
  return viewId ? `${path}?${new URLSearchParams({ view: viewId })}` : path;
}
