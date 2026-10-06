export function cn(...values: unknown[]) {
  return values
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" ");
}
