import {
  createDateTimeFormatter,
  defaultDateTimePreferences,
  formatDisplayDate,
  formatDisplayTime,
  type Preferences,
} from "@rootset/contracts";
import type { TableField } from "./types";
import { allowedValueLabel } from "../../lib/field-choices";

export function fieldConstraints(
  field: TableField,
  preferences?: Pick<Preferences, "timezone" | "dateFormat" | "timeFormat">,
): string[] {
  const dateFormat =
    preferences?.dateFormat ?? defaultDateTimePreferences.dateFormat;
  const timeFormat =
    preferences?.timeFormat ?? defaultDateTimePreferences.timeFormat;
  const timeZone = preferences?.timezone ?? "UTC";
  function displayBound(value: number | string): string {
    if (typeof value !== "string") return String(value);
    if (field.type === "date") return formatDisplayDate(value, dateFormat);
    if (field.type === "time")
      return `${formatDisplayTime(value.replace(/Z$/, ""), timeFormat)} UTC`;
    if (field.type === "date-time") {
      const formatted = createDateTimeFormatter({
        dateFormat,
        timeFormat,
        timeZone,
      })(value);
      return `${formatted.date}, ${formatted.time} ${timeZone}`;
    }
    return value;
  }
  const constraints: string[] = [];
  if (field.allowedValues)
    constraints.push(
      field.allowedValues.length < 10
        ? field.allowedValues.map(allowedValueLabel).join(", ")
        : `${field.allowedValues.length} allowed values`,
    );
  if (field.charLimit !== undefined)
    constraints.push(`Max ${field.charLimit.toLocaleString()} characters`);
  if (field.min !== undefined)
    constraints.push(`Min ${displayBound(field.min)}`);
  if (field.max !== undefined)
    constraints.push(`Max ${displayBound(field.max)}`);
  return constraints;
}
