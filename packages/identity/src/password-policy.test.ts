import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  isPasswordCompromised,
  PasswordPolicy,
  PasswordVerificationGate,
} from "./password-policy";

const password = "Fixture password policy 2026!";
const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
test("password range requests disclose only a hash prefix and reject positive counts, including padded zero-count entries", async () => {
  let calls = 0;
  const request: typeof fetch = async (input, options) => {
    calls++;
    assert.equal(
      String(input),
      `https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`,
    );
    assert.ok(!String(input).includes(password));
    assert.equal(new Headers(options?.headers).get("Add-Padding"), "true");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    return new Response(
      `${digest.slice(5)}:${calls === 1 ? 2 : 0}\r\n${"A".repeat(35)}:0\r\n`,
    );
  };
  assert.equal(await isPasswordCompromised(password, request), true);
  assert.equal(await isPasswordCompromised(password, request), false);
});
test("unavailable, malformed and oversized password corpora fail closed", async () => {
  for (const response of [
    new Response("", { status: 503 }),
    new Response("not a range response"),
    new Response(`${"A".repeat(35)}:0\n`.repeat(60_000)),
  ]) {
    await assert.rejects(
      isPasswordCompromised(password, async () => response),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "Password safety check is temporarily unavailable. Try again shortly.",
    );
  }
  await assert.rejects(
    isPasswordCompromised(password, async () => {
      throw new Error("network unavailable");
    }),
  );
});
test("a bounded password queue preserves FIFO and releases capacity after success and failure", async () => {
  const gate = new PasswordVerificationGate(1, 1);
  const order: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = gate.run(async () => {
    order.push("first");
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error("hash failed");
  });
  const firstFailure = assert.rejects(first, /hash failed/);
  await active;
  const second = gate.run(async () => {
    order.push("second");
    return 2;
  });
  await assert.rejects(
    gate.run(async () => 3),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Sign-in is busy. Try again shortly",
  );
  release();
  await firstFailure;
  assert.equal(await second, 2);
  assert.equal(await gate.run(async () => 4), 4);
  assert.deepEqual(order, ["first", "second"]);
});
test("offline fixture policy still stores a salted password hash and verifies credentials", async () => {
  const policy = new PasswordPolicy({ breachCheck: false });
  const hash = await policy.hash(password);
  assert.notEqual(hash, password);
  assert.equal(await policy.verify({ hash, password }), true);
  assert.equal(
    await policy.verify({ hash, password: "wrong password" }),
    false,
  );
});
