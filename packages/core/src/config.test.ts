import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadConfig } from "./config.js";

const env = {
  ROOTSET_API_URL: "http://localhost:4310",
  ROOTSET_WEB_URL: "http://localhost:4300",
  ROOTSET_DATABASE_URL: "postgres://app:test@localhost/rootset",
  ROOTSET_SECRET: "a".repeat(32),
  ROOTSET_ENCRYPTION_KEY: "d".repeat(64),
  ROOTSET_S3_ENDPOINT: "http://localhost:9000",
  ROOTSET_S3_BUCKET: "rootset-artifacts",
  ROOTSET_S3_ACCESS_KEY: "fixture-access",
  ROOTSET_S3_SECRET_KEY: "fixture-secret-only",
  ROOTSET_SMTP_HOST: "localhost",
  ROOTSET_EMAIL_FROM: "rootset@example.test",
};
test("configuration uses one database URL, one application secret and one encryption key", () => {
  const config = loadConfig(env);
  assert.equal(config.databaseURL, env.ROOTSET_DATABASE_URL);
  assert.equal(config.bootstrapSecret, env.ROOTSET_SECRET);
  assert.equal(Buffer.from(config.encryptionKey, "base64").length, 32);
  assert.equal(
    new Set([config.secret, config.cursorSecret, config.keyHashSecret]).size,
    3,
  );
  assert.deepEqual(loadConfig(env), config);
  assert.notEqual(
    loadConfig({ ...env, ROOTSET_SECRET: "b".repeat(32) }).cursorSecret,
    config.cursorSecret,
  );
  for (const key of [
    "ROOTSET_SECRET",
    "ROOTSET_ENCRYPTION_KEY",
    "ROOTSET_DATABASE_URL",
  ])
    assert.throws(() => loadConfig({ ...env, [key]: undefined }));
  assert.throws(() =>
    loadConfig({ ...env, ROOTSET_ENCRYPTION_KEY: "invalid" }),
  );
  for (const origin of [
    "http://rootset.example",
    "https://rootset.example/path",
    "https://user@rootset.example",
  ])
    assert.throws(() => loadConfig({ ...env, ROOTSET_API_URL: origin }));
  assert.equal(
    loadConfig({ ...env, ROOTSET_WEB_URL: "https://rootset.avgeek.ltd" })
      .webURL,
    "https://rootset.avgeek.ltd",
  );
});

test("invalid base URLs report validation without the URL parser input", () => {
  const sentinel = "PRIVATE_BASE_URL_SENTINEL";
  assert.throws(
    () => loadConfig({ ...env, ROOTSET_API_URL: sentinel }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ROOTSET_API_URL/);
      assert.equal(inspect(error).includes(sentinel), false);
      assert.equal(String(error).includes(sentinel), false);
      assert.equal(Object.hasOwn(error, "input"), false);
      return true;
    },
  );
});

test("database and S3 URLs reject mismatched protocols before dependency access", () => {
  for (const name of ["ROOTSET_DATABASE_URL"]) {
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
