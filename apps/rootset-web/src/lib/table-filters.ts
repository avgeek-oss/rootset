import {
  operatorsByType,
  parseStrictJson,
  validateQuery,
  type FieldDefinition,
  type FilterNode,
  type JsonValue,
  type QueryOperator,
} from "@rootset/contracts";
import { parsePastedCell } from "./pasted-cell";

export interface FilterCondition {
  id: string;
  fieldId: string;
  operator: QueryOperator;
  value: string;
  path: string;
}
export type FilterCombination = "and" | "or";

export const operatorLabels: Record<QueryOperator, string> = {
  eq: "is",
  ne: "is not",
  lt: "is less than",
  lte: "is at most",
  gt: "is greater than",
  gte: "is at least",
  between: "is between",
  in: "is one of",
  isNull: "is empty",
  isNotNull: "is not empty",
  prefix: "starts with",
  contains: "contains",
  iContains: "contains (ignore case)",
  pathExists: "has JSON path",
  pathEq: "JSON path is",
  jsonContains: "JSON contains",
};

export function needsFilterValue(operator: QueryOperator): boolean {
  return !["isNull", "isNotNull", "pathExists"].includes(operator);
}

export function buildTableFilter(
  conditions: readonly FilterCondition[],
  combination: FilterCombination,
  fields: readonly FieldDefinition[],
): FilterNode | undefined {
  if (!conditions.length) return undefined;
  const predicates: FilterNode[] = conditions.map((condition) => {
    const field = fields.find((entry) => entry.id === condition.fieldId);
    if (!field)
      throw new Error("Choose a field that still exists in this table.");
    if (
      !(operatorsByType[field.type] as readonly string[]).includes(
        condition.operator,
      )
    )
      throw new Error(`${field.name}: choose a supported match condition.`);
    const unbounded: FieldDefinition = {
      id: field.id,
      name: field.name,
      type: field.type,
      ...(field.charLimit !== undefined ? { charLimit: field.charLimit } : {}),
    };
    let value: JsonValue | undefined;
    if (needsFilterValue(condition.operator)) {
      value = ["in", "between"].includes(condition.operator)
        ? parseStrictJson(condition.value)
        : parsePastedCell(unbounded, condition.value, true);
    }
    const path = condition.operator.startsWith("path")
      ? parseStrictJson(condition.path)
      : undefined;
    return {
      field: field.name,
      op: condition.operator,
      ...(value !== undefined ? { value } : {}),
      ...(path !== undefined ? { path: path as (string | number)[] } : {}),
    };
  });
  const unique = predicates.filter(
    (predicate, index, all) =>
      all.findIndex(
        (entry) => JSON.stringify(entry) === JSON.stringify(predicate),
      ) === index,
  );
  return validateQuery(
    { where: unique.length === 1 ? unique[0] : { [combination]: unique } },
    fields,
  ).where;
}
