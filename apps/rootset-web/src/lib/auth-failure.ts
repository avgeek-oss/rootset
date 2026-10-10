function stringFrom(
  value: unknown,
  key: "message" | "code",
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const message = (value as Record<string, unknown>)[key];
  return typeof message === "string" && message.trim() ? message : undefined;
}

export function authFailure(result: { error?: unknown }) {
  if (!result.error) return;
  const nested =
    typeof result.error === "object" && !Array.isArray(result.error)
      ? (result.error as Record<string, unknown>).error
      : undefined;
  throw Object.assign(
    new Error(
      stringFrom(result.error, "message") ??
        stringFrom(nested, "message") ??
        "Authentication could not be completed",
    ),
    { code: stringFrom(result.error, "code") ?? stringFrom(nested, "code") },
  );
}
