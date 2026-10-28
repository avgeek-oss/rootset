import { FieldDefinitionSchema } from "@rootset/contracts";
import type { TableField } from "./types";

export interface FieldDraft {
  name: string;
  type: TableField["type"];
  required: boolean;
  charLimit: string;
  restrictValues: boolean;
  allowedValues: string[];
  hadAllowedValues: boolean;
  hadAutoIncrement: boolean;
  zodSchema: string;
  hadZodSchema: boolean;
  min: string;
  max: string;
  defaultMode: "none" | "value" | "autoIncrement";
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
    restrictValues: Boolean(field?.allowedValues),
    allowedValues: field?.allowedValues ? [...field.allowedValues] : [""],
    hadAllowedValues: Boolean(field?.allowedValues),
    hadAutoIncrement: Boolean(field?.autoIncrement),
    zodSchema: field?.zodSchema ?? "",
    hadZodSchema: Boolean(field?.zodSchema),
    min: String(field?.min ?? ""),
    max: String(field?.max ?? ""),
    defaultMode: field?.autoIncrement
      ? "autoIncrement"
      : field?.default != null
        ? "value"
        : "none",
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
  if (value.type === "text") {
    result.charLimit = Number(value.charLimit);
    if (value.restrictValues) result.allowedValues = value.allowedValues;
    else if (value.hadAllowedValues) result.allowedValues = null;
  }
  if (value.type === "json") {
    if (value.zodSchema.trim()) result.zodSchema = value.zodSchema.trim();
    else if (value.hadZodSchema) result.zodSchema = null;
  }
  if (["integer", "float", "date", "date-time"].includes(value.type))
    for (const bound of ["min", "max"] as const)
      if (value[bound] !== "")
        result[bound] = ["integer", "float"].includes(value.type)
          ? Number(value[bound])
          : value.type === "date-time" &&
              /^\d{4}-\d{2}-\d{2}$/.test(value[bound])
            ? `${value[bound]}T00:00:00.000Z`
            : value[bound];
  if (value.type === "integer") {
    if (value.defaultMode === "autoIncrement") result.autoIncrement = true;
    else if (value.hadAutoIncrement) result.autoIncrement = false;
  } else if (value.defaultMode === "autoIncrement")
    errors.defaultMode = "Auto-increment is available for integer fields.";
  if (value.defaultMode === "value") {
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
