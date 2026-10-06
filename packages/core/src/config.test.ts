import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadConfig } from "./config.js";

const env = {
  ROOTSET_BASE_URL: "http://localhost:4300",
  ROOTSET_DATABASE_URL: "postgres://app:test@localhost/rootset",
  ROOTSET_DDL_DATABASE_URL: "postgres://ddl:test@localhost/rootset",
  ROOTSET_IDENTITY_DATABASE_URL: "postgres://identity:test@localhost/rootset",
  ROOTSET_AUTH_SECRET: "a".repeat(32),
  ROOTSET_KEY_HASH_SECRET: "b".repeat(32),
  ROOTSET_CURSOR_SECRET: "c".repeat(32),
  ROOTSET_ENCRYPTION_KEY: "d".repeat(64),
  ROOTSET_BOOTSTRAP_SECRET: "e".repeat(32),
  ROOTSET_S3_ENDPOINT: "http://localhost:9000",
  ROOTSET_S3_BUCKET: "rootset-artifacts",
  ROOTSET_S3_ACCESS_KEY: "fixture-access",
  ROOTSET_S3_SECRET_KEY: "fixture-secret-only",
  ROOTSET_SMTP_HOST: "localhost",
  ROOTSET_EMAIL_FROM: "rootset@example.test",
};
test("configuration requires distinct explicit connections and persistent keys", () => {
  const v = loadConfig(env);
  assert.equal(Buffer.from(v.encryptionKeys.primary!, "base64").length, 32);
  assert.notEqual(v.databaseURL, v.identityDatabaseURL);
  assert.throws(() =>
    loadConfig({ ...env, ROOTSET_ENCRYPTION_KEY: undefined }),
  );
  assert.throws(() =>
    loadConfig({ ...env, ROOTSET_IDENTITY_DATABASE_URL: undefined }),
  );
  assert.throws(() =>
    loadConfig({ ...env, ROOTSET_BASE_URL: "http://rootset.example" }),
  );
  assert.equal(
    loadConfig({ ...env, ROOTSET_BASE_URL: "https://rootset.example" }).baseURL,
    "https://rootset.example",
  );
});
test("key rotation supports a JSON-only retained keyring and rejects a missing active key", () => {
  const ring = JSON.stringify({
    primary: "a".repeat(64),
    next: "b".repeat(64),
  });
  const rotated = loadConfig({
    ...env,
    ROOTSET_ENCRYPTION_KEY: "",
    ROOTSET_ENCRYPTION_KEYS: ring,
    ROOTSET_ENCRYPTION_KEY_ID: "next",
  });
  assert.equal(rotated.activeEncryptionKeyId, "next");
  assert.equal(
    Buffer.from(rotated.encryptionKeys.primary!, "base64").length,
    32,
  );
  assert.equal(Buffer.from(rotated.encryptionKeys.next!, "base64").length, 32);
  assert.throws(() =>
    loadConfig({
      ...env,
      ROOTSET_ENCRYPTION_KEY: "",
      ROOTSET_ENCRYPTION_KEYS: ring,
      ROOTSET_ENCRYPTION_KEY_ID: "missing",
    }),
  );
  for (const id of ["toString", "__proto__", "constructor"])
    assert.throws(
      () =>
        loadConfig({
          ...env,
          ROOTSET_ENCRYPTION_KEY: "",
          ROOTSET_ENCRYPTION_KEYS: ring,
          ROOTSET_ENCRYPTION_KEY_ID: id,
        }),
      /The active encryption key must be present/,
    );
});

test("invalid encryption key maps fail without exposing input or parser causes", () => {
  const sentinel = "PRIVATE_KEY_SENTINEL";
  for (const keyring of [
    `{"primary":"${sentinel}",}`,
    JSON.stringify({ primary: sentinel }),
    JSON.stringify({ [`${sentinel}!`]: "a".repeat(64) }),
    JSON.stringify([sentinel]),
    JSON.stringify(sentinel),
    "null",
  ]) {
    assert.throws(
      () => loadConfig({ ...env, ROOTSET_ENCRYPTION_KEYS: keyring }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^ROOTSET_ENCRYPTION_KEYS must be a JSON object/,
        );
        assert.equal(Object.hasOwn(error, "cause"), false);
        for (const rendered of [
          String(error),
          inspect(error),
          JSON.stringify(error),
        ])
          assert.equal(rendered.includes(sentinel), false);
        return true;
      },
    );
  }
});

test("invalid base URLs report validation without the URL parser input", () => {
  const sentinel = "PRIVATE_BASE_URL_SENTINEL";
  assert.throws(
    () => loadConfig({ ...env, ROOTSET_BASE_URL: sentinel }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ROOTSET_BASE_URL/);
      assert.equal(inspect(error).includes(sentinel), false);
      assert.equal(String(error).includes(sentinel), false);
      assert.equal(Object.hasOwn(error, "input"), false);
      return true;
    },
  );
});

test("database and S3 URLs reject mismatched protocols before dependency access", () => {
  for (const name of [
    "ROOTSET_DATABASE_URL",
    "ROOTSET_DDL_DATABASE_URL",
    "ROOTSET_IDENTITY_DATABASE_URL",
  ]) {
    assert.throws(
      () => loadConfig({ ...env, [name]: "https://localhost/rootset" }),
      /Use postgres:\/\/ or postgresql:\/\//,
    );
    for (const protocol of ["postgres", "postgresql"])
      assert.doesNotThrow(() =>
        loadConfig({ ...env, [name]: `${protocol}://localhost/rootset` }),
      );
  }
  assert.throws(
    () =>
      loadConfig({ ...env, ROOTSET_S3_ENDPOINT: "ftp://localhost/rootset" }),
    /Use http:\/\/ or https:\/\/ for the S3 endpoint/,
  );
  for (const protocol of ["http", "https"])
    assert.doesNotThrow(() =>
      loadConfig({
        ...env,
        ROOTSET_S3_ENDPOINT: `${protocol}://localhost/rootset`,
      }),
    );
});

test("password safety and bounded work use the common deployment defaults", () => {
  assert.deepEqual(loadConfig(env).passwordPolicy, {
    breachCheck: true,
    maximumActive: 2,
    maximumWaiting: 16,
  });
  assert.equal(
    loadConfig({ ...env, ROOTSET_PASSWORD_BREACH_CHECK: "false" })
      .passwordPolicy.breachCheck,
    false,
  );
  for (const [key, value] of [
    ["ROOTSET_PASSWORD_BREACH_CHECK", "yes"],
    ["ROOTSET_PASSWORD_VERIFY_CONCURRENCY", "0"],
    ["ROOTSET_PASSWORD_VERIFY_CONCURRENCY", "9"],
    ["ROOTSET_PASSWORD_VERIFY_QUEUE_LIMIT", "101"],
  ]) {
    assert.throws(() => loadConfig({ ...env, [key!]: value }));
  }
});
