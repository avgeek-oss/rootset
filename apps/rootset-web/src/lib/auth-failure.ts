function messageFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

export function authFailure(result: { error?: unknown }) {
  if (!result.error) return;
  const nested =
    typeof result.error === "object" && !Array.isArray(result.error)
      ? (result.error as Record<string, unknown>).error
      : undefined;
  throw new Error(
    messageFrom(result.error) ??
      messageFrom(nested) ??
      "Authentication could not be completed",
  );
}
