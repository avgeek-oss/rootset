import {
  analyseNumberLexeme,
  parseStrictJson,
  validateCell,
  type FieldDefinition,
  type JsonValue,
} from "@rootset/contracts";

export function parsePastedCell(
  field: FieldDefinition,
  value: string,
  quoted = false,
): JsonValue {
  if (value === "" && !quoted) return validateCell(field, null);
  let parsed: JsonValue = value;
  if (field.type === "integer") {
    let number;
    try {
      number = analyseNumberLexeme(value.trim());
    } catch {
      throw new Error(
        `${field.label}: enter a whole number in the safe integer range`,
      );
    }
    if (!number.integer || !number.safeInteger)
      throw new Error(
        `${field.label}: enter a whole number in the safe integer range`,
      );
    parsed = number.value;
  } else if (field.type === "float") {
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))
      throw new Error(`${field.label}: enter a number`);
    parsed = Number(value);
  } else if (field.type === "boolean") {
    if (value !== "true" && value !== "false")
      throw new Error(`${field.label}: use true, false, or an empty cell`);
    parsed = value === "true";
  } else if (field.type === "json") {
    try {
      parsed = parseStrictJson(value) as JsonValue;
    } catch {
      throw new Error(`${field.label}: JSON could not be parsed`);
    }
  }
  return validateCell(field, parsed);
}
