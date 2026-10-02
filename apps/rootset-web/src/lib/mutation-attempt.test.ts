import { describe, expect, it } from "vitest";
import { MutationAttempt } from "./mutation-attempt";

describe("lost mutation responses", () => {
  it("retries the same draft with the same key but isolates changed payloads and later mutations", () => {
    const attempt = new MutationAttempt();
    const original = attempt.forInput({
      values: { NAME: "Air" },
      expectedVersion: "1",
    });
    expect(
      attempt.forInput({ values: { NAME: "Air" }, expectedVersion: "1" }),
    ).toBe(original);
    expect(
      attempt.forInput({ values: { NAME: "Changed" }, expectedVersion: "1" }),
    ).not.toBe(original);
    attempt.clear();
    expect(
      attempt.forInput({ values: { NAME: "Air" }, expectedVersion: "1" }),
    ).not.toBe(original);
  });
});
