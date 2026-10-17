import {
  analyseNumberLexeme,
  validateCell,
  type FieldDefinition,
  type FilterNode,
  type ForeignKey,
  type JsonValue,
  type QuerySpec,
  type Row,
} from "@rootset/contracts";
import { createCellDraft, parseCellDraft } from "../components/cells/drafts";
import type { RecordDraft } from "./record-draft";

export function foreignKeyValues(
  rule: ForeignKey,
  fields: readonly FieldDefinition[],
  drafts: RecordDraft,
  timeZone: string,
): JsonValue[] | undefined {
  try {
    const values = rule.fieldIds.map((id) => {
      const field = fields.find((field) => field.id === id)!;
      const draft = drafts[id]!;
      if (draft.mode === "default" && field.autoIncrement) return null;
      return parseCellDraft(
        field,
        { ...draft, isNull: draft.mode === "null" },
        timeZone,
      );
    });
    return values.some((value) => value === null) ? undefined : values;
  } catch {
    return undefined;
  }
}

export function foreignKeyDrafts(
  rule: ForeignKey,
  sourceFields: readonly FieldDefinition[],
  targetFields: readonly FieldDefinition[],
  row: Row,
  timeZone: string,
): RecordDraft {
  return Object.fromEntries(
    rule.fieldIds.map((id, index) => {
      const source = sourceFields.find((field) => field.id === id)!;
      const target = targetFields.find(
        (field) => field.id === rule.referencedFieldIds[index],
      )!;
      const value = validateCell(source, row.values[target.name]);
      return [
        id,
        { ...createCellDraft(source, value, timeZone), mode: "value" as const },
      ];
    }),
  );
}

export function foreignKeyQuery(
  keyFields: readonly FieldDefinition[],
  displayField: FieldDefinition | undefined,
  search: string,
): QuerySpec {
  const constraints: FilterNode[] = keyFields.map((field) => ({
    field: field.id,
    op: "isNotNull",
  }));
  const predicates: FilterNode[] = [];
  const text = search.trim();
  if (text) {
    const fields = new Map(
      [...keyFields, ...(displayField ? [displayField] : [])].map((field) => [
        field.id,
        field,
      ]),
    );
    for (const field of fields.values()) {
      if (["text", "url", "uri", "image"].includes(field.type)) {
        if (field.charLimit !== undefined && [...text].length > field.charLimit)
          continue;
        predicates.push({ field: field.id, op: "iContains", value: text });
        continue;
      }
      try {
        let value: JsonValue = text;
        if (field.type === "integer" || field.type === "float") {
          const number = analyseNumberLexeme(text);
          if (
            field.type === "integer" &&
            (!number.integer || !number.safeInteger)
          )
            continue;
          value = number.value;
        } else if (field.type === "boolean") {
          if (!["true", "false"].includes(text.toLowerCase())) continue;
          value = text.toLowerCase() === "true";
        }
        predicates.push({
          field: field.id,
          op: "eq",
          value: validateCell(field, value),
        });
      } catch {
        // This search term cannot represent a value of this key's type.
      }
    }
    constraints.push(
      predicates.length
        ? { or: predicates }
        : {
            and: [
              { field: keyFields[0]!.id, op: "isNull" },
              { field: keyFields[0]!.id, op: "isNotNull" },
            ],
          },
    );
  }
  return {
    select: [
      ...new Set([
        ...keyFields.map((field) => field.id),
        ...(displayField ? [displayField.id] : []),
      ]),
    ],
    where: { and: constraints },
    orderBy: [{ field: (displayField ?? keyFields[0]!).id, direction: "asc" }],
    limit: 50,
  };
}
