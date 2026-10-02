import { test } from "node:test";
import assert from "node:assert/strict";
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
});
