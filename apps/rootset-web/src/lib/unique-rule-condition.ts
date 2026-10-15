import {
  validateUniqueRuleCondition,
  type FieldDefinition,
  type UniqueRuleCondition,
} from "@rootset/contracts";
import { parsePastedCell } from "./pasted-cell";
import { operatorLabels } from "./table-filters";

export function parseUniqueRuleCondition(
  fields: readonly Pick<
    FieldDefinition,
    "id" | "name" | "type" | "charLimit"
  >[],
  fieldId: string,
  op: UniqueRuleCondition["op"],
  raw: string,
): UniqueRuleCondition {
  const field = fields.find((field) => field.id === fieldId);
  if (!field) throw new Error("Choose a condition field.");
  const value =
    op === "eq" || op === "ne"
      ? parsePastedCell(
          {
            id: field.id,
            name: field.name,
            type: field.type,
            charLimit: field.charLimit,
          },
          raw,
          true,
        )
      : undefined;
  return validateUniqueRuleCondition(
    { field: fieldId, op, ...(value !== undefined ? { value } : {}) },
    fields,
  )!;
}

export function uniqueRuleConditionLabel(
  where: UniqueRuleCondition | undefined,
  fields: readonly Pick<FieldDefinition, "id" | "name">[],
): string {
  if (!where) return "All rows";
  const name =
    fields.find((field) => field.id === where.field)?.name ?? where.field;
  return `${name} ${operatorLabels[where.op]}${"value" in where ? ` ${JSON.stringify(where.value)}` : ""}`;
}
