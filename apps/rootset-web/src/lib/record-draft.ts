import {
  canonicalJson,
  validateValues,
  type FieldDefinition,
  type JsonValue,
  type Row,
} from "@rootset/contracts";
import {
  createCellDraft,
  parseCellDraft,
  type CellDraft,
} from "../components/cells/drafts";

export interface RecordFieldDraft extends CellDraft {
  mode: "value" | "null" | "default";
}
export type RecordDraft = Record<string, RecordFieldDraft>;

export function createRecordDraft(
  fields: readonly FieldDefinition[],
  row?: Row,
  timeZone = "UTC",
): RecordDraft {
  return Object.fromEntries(
    fields.map((field) => {
      const useDefault =
        !row &&
        (Object.hasOwn(field, "default") ||
          (field.type === "integer" && field.autoIncrement));
      const value = row
        ? (row.values[field.name] ?? null)
        : (field.default ?? null);
      const draft = createCellDraft(field, value, timeZone);
      return [
        field.id,
        {
          ...draft,
          mode: useDefault ? "default" : draft.isNull ? "null" : "value",
        },
      ];
    }),
  );
}

export function recordValues(
  fields: readonly FieldDefinition[],
  drafts: RecordDraft,
  row?: Row,
  timeZone = "UTC",
) {
  const values: Record<string, JsonValue> = Object.create(null);
  const errors: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const draft = drafts[field.id]!;
    if (!row && draft.mode === "default") continue;
    try {
      const value = parseCellDraft(
        field,
        { ...draft, isNull: draft.mode === "null" },
        timeZone,
      );
      if (
        !row ||
        canonicalJson(value) !== canonicalJson(row.values[field.name])
      )
        values[field.name] = value;
    } catch (error) {
      errors[field.id] =
        error instanceof Error ? error.message : "This value is invalid.";
    }
  }
  if (!row && !Object.keys(errors).length) validateValues(fields, values);
  return { values, errors };
}
