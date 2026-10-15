export function allowedValueLabel(value: string): string {
  return value === "NULL" || value.trim() !== value || /[\r\n\t]/.test(value)
    ? JSON.stringify(value)
    : value;
}
