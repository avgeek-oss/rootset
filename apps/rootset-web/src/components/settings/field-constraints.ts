import type { TableField } from "./types";

export function fieldConstraints(field: TableField): string[] {
  const constraints: string[] = [];
  if (field.charLimit !== undefined)
    constraints.push(`Max ${field.charLimit.toLocaleString()} characters`);
  if (field.min !== undefined) constraints.push(`Min ${field.min}`);
  if (field.max !== undefined) constraints.push(`Max ${field.max}`);
  if (Object.hasOwn(field, "default"))
    constraints.push(`Default ${JSON.stringify(field.default) ?? "null"}`);
  return constraints;
}
