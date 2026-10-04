import assert from "node:assert/strict";

export function nativeTestDatabaseURLs(
  environment: Record<string, string | undefined>,
): URL[] {
  const prerequisites = [
    ["ROOTSET_TEST_DATABASE_URL", "rootset_owner"],
    ["ROOTSET_TEST_APP_DATABASE_URL", "rootset_app"],
    ["ROOTSET_TEST_DDL_DATABASE_URL", "rootset_ddl"],
    ["ROOTSET_TEST_IDENTITY_DATABASE_URL", "rootset_identity"],
  ] as const;
  const port = environment.CI === "true" ? "5432" : "55467";
  const urls = prerequisites.map(([key, role]) => {
    assert(environment[key], `Missing disposable prerequisite ${key}`);
    const url = new URL(environment[key]!);
    assert(["postgres:", "postgresql:"].includes(url.protocol));
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert(
      url.port === port,
      "Only the isolated local or explicit CI test port may be used",
    );
    assert(
      url.username === role,
      "Disposable role must match its declared prerequisite",
    );
    assert(
      !url.search && !url.hash,
      "Disposable URL cannot override connection parameters",
    );
    return url;
  });
  const first = urls[0]!;
  assert(
    urls.every(
      (url) =>
        url.hostname === first.hostname &&
        url.port === first.port &&
        url.pathname === first.pathname,
    ),
    "All disposable roles must use the same isolated endpoint and database",
  );
  return urls;
}
