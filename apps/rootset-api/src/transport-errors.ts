import { RootsetError } from "@rootset/contracts";

export function normaliseTransportError(error: unknown): unknown {
  if (
    error instanceof Error &&
    !(error instanceof RootsetError) &&
    [
      "timeout exceeded when trying to connect",
      "Connection terminated due to connection timeout",
    ].includes(error.message)
  )
    return new RootsetError(
      "DEPENDENCY_UNAVAILABLE",
      "Database capacity is temporarily unavailable. Retry this request.",
      503,
      { retryAfter: 1 },
    );
  return error;
}
