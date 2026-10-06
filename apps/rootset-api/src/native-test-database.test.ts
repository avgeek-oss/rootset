import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTestDatabaseURLs } from "./native-test-database.js";

const environment = (port: string, CI?: string) => ({
  CI,
  ROOTSET_TEST_DATABASE_URL: `postgres://rootset_owner:fixture@127.0.0.1:${port}/rootset`,
  ROOTSET_TEST_APP_DATABASE_URL: `postgres://rootset_app:fixture@127.0.0.1:${port}/rootset`,
  ROOTSET_TEST_DDL_DATABASE_URL: `postgres://rootset_ddl:fixture@127.0.0.1:${port}/rootset`,
  ROOTSET_TEST_IDENTITY_DATABASE_URL: `postgres://rootset_identity:fixture@127.0.0.1:${port}/rootset`,
});

test("native fixture port and role boundaries permit explicit CI and isolated local execution", () => {
  assert.equal(nativeTestDatabaseURLs(environment("55468")).length, 4);
  assert.equal(nativeTestDatabaseURLs(environment("5432", "true")).length, 4);
  for (const inputs of [
    environment("5432"),
    environment("5432", "1"),
    environment("55468", "true"),
    environment("5433", "true"),
  ]) {
    assert.throws(() => nativeTestDatabaseURLs(inputs));
  }
  for (const bad of [
    {
      ...environment("55468"),
      ROOTSET_TEST_APP_DATABASE_URL:
        "postgres://rootset_app:fixture@example.com:55468/rootset",
    },
    {
      ...environment("55468"),
      ROOTSET_TEST_APP_DATABASE_URL:
        "postgres://rootset_owner:fixture@127.0.0.1:55468/rootset",
    },
    {
      ...environment("55468"),
      ROOTSET_TEST_DDL_DATABASE_URL:
        "postgres://rootset_ddl:fixture@127.0.0.1:55468/another",
    },
    {
      ...environment("55468"),
      ROOTSET_TEST_IDENTITY_DATABASE_URL:
        "postgres://rootset_identity:fixture@127.0.0.1:55468/rootset?options=-c%20statement_timeout=0",
    },
  ])
    assert.throws(() => nativeTestDatabaseURLs(bad));
});
