import assert from "node:assert/strict";
import test from "node:test";
import { PasswordPolicy, PasswordVerificationGate } from "./password-policy";
const password = "Fixture password policy 2026!";
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
  const policy = new PasswordPolicy();
  const hash = await policy.hash(password);
  assert.notEqual(hash, password);
  assert.equal(await policy.verify({ hash, password }), true);
  assert.equal(
    await policy.verify({ hash, password: "wrong password" }),
    false,
  );
});
