import { FieldDefinitionSchema } from "@rootset/contracts";
import type { TableField } from "./types";

export interface FieldDraft {
  name: string;
  type: TableField["type"];
  required: boolean;
  charLimit: string;
  min: string;
  max: string;
  defaultMode: "null" | "value";
  defaultValue: string;
  defaultBoolean: boolean;
}

export type FieldDraftErrors = Partial<Record<keyof FieldDraft, string>>;

export function fieldDraft(field?: TableField): FieldDraft {
  return {
    name: field?.name ?? "",
    type: field?.type ?? "text",
    required: field?.required ?? false,
    charLimit: String(field?.charLimit ?? 4096),
    min: String(field?.min ?? ""),
    max: String(field?.max ?? ""),
    defaultMode:
      field && Object.hasOwn(field, "default")
        ? field.default === null
          ? "null"
          : "value"
        : field?.required
          ? "value"
          : "null",
    defaultValue:
      field && field.default !== undefined && field.default !== null
        ? field.type === "json"
          ? JSON.stringify(field.default, null, 2)
          : String(field.default)
        : "",
    defaultBoolean: field?.default === true,
  };
}

export function parseFieldDraft(
  value: FieldDraft,
):
  | { input: Record<string, unknown>; errors?: never }
  | { errors: FieldDraftErrors; input?: never } {
  const errors: FieldDraftErrors = {};
  const result: Record<string, unknown> = {
    id: "00000000000000000000000000",
    name: value.name,
    type: value.type,
    required: value.required,
  };
  if (value.type === "text") result.charLimit = Number(value.charLimit);
  if (["integer", "float", "date", "date-time"].includes(value.type))
    for (const bound of ["min", "max"] as const)
      if (value[bound] !== "")
        result[bound] = ["integer", "float"].includes(value.type)
          ? Number(value[bound])
          : value[bound];
  if (value.defaultMode === "null") result.default = null;
  if (value.defaultMode === "value") {
    if (
      value.required &&
      value.type !== "boolean" &&
      !value.defaultValue.trim()
    )
      errors.defaultValue = "Enter a default value for this required field.";
    if (["integer", "float"].includes(value.type) && !value.defaultValue.trim())
      errors.defaultValue = "Enter a default value.";
    try {
      result.default =
        value.type === "json"
          ? JSON.parse(value.defaultValue)
          : value.type === "boolean"
            ? value.defaultBoolean
            : ["integer", "float"].includes(value.type)
              ? Number(value.defaultValue)
              : value.defaultValue;
    } catch {
      errors.defaultValue = "Enter a valid JSON value.";
    }
  }
  const parsed = FieldDefinitionSchema.safeParse(result);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const property = String(issue.path[0]);
      const key =
        property === "default"
          ? value.defaultMode === "value"
            ? "defaultValue"
            : "defaultMode"
          : (property as keyof FieldDraft);
      errors[key] ??=
        key === "name" && issue.code === "invalid_format"
          ? "Use only English letters and underscores."
          : issue.message;
    }
    return { errors };
  }
  if (Object.keys(errors).length) return { errors };
  const input: Record<string, unknown> = { ...parsed.data };
  delete input.id;
  return { input };
}
