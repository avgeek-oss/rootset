import assert from "node:assert/strict";

export function nativeTestDatabaseURLs(
  environment: Record<string, string | undefined>,
): URL[] {
  const value = environment.ROOTSET_TEST_DATABASE_URL;
  assert(value, "Missing disposable prerequisite ROOTSET_TEST_DATABASE_URL");
  const url = new URL(value);
  const port = environment.CI === "true" ? "5432" : "55468";
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(
    url.port === port,
    "Only the isolated local or explicit CI test port may be used",
  );
  assert(
    /^rootset(?:_[a-z0-9_]+)?$/.test(url.username),
    "Use a dedicated non-admin Rootset verification role",
  );
  assert(
    !url.search && !url.hash,
    "Disposable URL cannot override connection parameters",
  );
  return [url];
}
