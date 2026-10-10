import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTestDatabaseURLs } from "./native-test-database.js";
const environment = (port: string, CI?: string) => ({
  CI,
  ROOTSET_TEST_DATABASE_URL: `postgres://rootset:fixture@127.0.0.1:${port}/rootset`,
});
test("native fixtures accept one database URL on the disposable local or CI port", () => {
  assert.equal(nativeTestDatabaseURLs(environment("55468")).length, 1);
  assert.equal(nativeTestDatabaseURLs(environment("5432", "true")).length, 1);
  for (const input of [
    environment("5432"),
    environment("5432", "1"),
    environment("55468", "true"),
    environment("5433", "true"),
  ])
    assert.throws(() => nativeTestDatabaseURLs(input));
  for (const url of [
    "postgres://rootset:fixture@example.com:55468/rootset",
    "postgres://postgres:fixture@127.0.0.1:55468/rootset",
    "postgres://rootset:fixture@127.0.0.1:55468/rootset?options=-c%20statement_timeout=0",
  ])
    assert.throws(() =>
      nativeTestDatabaseURLs({
        ...environment("55468"),
        ROOTSET_TEST_DATABASE_URL: url,
      }),
    );
});
