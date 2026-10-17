import {
  RelationshipFilterSchema,
  parseStrictJson,
  type FilterNode,
  type ForeignKey,
  type Row,
} from "@rootset/contracts";
import type { FilterCondition } from "./table-filters";

export interface ForeignKeyLink {
  id: string;
  name: string;
  href: string;
}

export function foreignKeyLinks(
  databaseId: string,
  rules: readonly ForeignKey[],
  row: Row,
  fieldNames: ReadonlyMap<string, string>,
): ForeignKeyLink[] {
  return rules.flatMap((rule) => {
    const filter = [];
    for (const [index, fieldId] of rule.fieldIds.entries()) {
      const name = fieldNames.get(fieldId);
      const value = name === undefined ? undefined : row.values[name];
      if (value === null || value === undefined) return [];
      filter.push({ fieldId: rule.referencedFieldIds[index], value });
    }
    const parameters = new URLSearchParams({ filter: JSON.stringify(filter) });
    return [
      {
        id: rule.id,
        name: rule.referencedTableName,
        href: `/databases/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(rule.referencedTableId)}?${parameters}`,
      },
    ];
  });
}

export function readLinkedTableFilter(value: string | null): {
  where?: FilterNode;
  conditions: FilterCondition[];
  error?: string;
} {
  if (value === null) return { conditions: [] };
  try {
    const filter = RelationshipFilterSchema.parse(parseStrictJson(value));
    const predicates = filter.map(({ fieldId, value }) => ({
      field: fieldId,
      op: "eq" as const,
      value,
    }));
    return {
      where: predicates.length === 1 ? predicates[0] : { and: predicates },
      conditions: filter.map(({ fieldId, value }, index) => ({
        id: `linked-${index}`,
        fieldId,
        operator: "eq",
        value: String(value),
        path: "",
      })),
    };
  } catch {
    return {
      conditions: [],
      error:
        "The linked record filter is invalid. Clear it to view this table.",
    };
  }
}

export function reverseRelationshipPath(
  databaseId: string,
  tableId: string,
  ruleId: string,
  rowId: string,
): string {
  return `/databases/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(tableId)}?${new URLSearchParams({ relationship: ruleId, record: rowId })}`;
}
