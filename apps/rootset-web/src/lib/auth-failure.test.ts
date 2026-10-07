import { describe, expect, it } from "vitest";
import { createAuthClient } from "better-auth/react";
import { authFailure } from "./auth-failure";

async function installedClientResult(body: unknown, status: number) {
  const client = createAuthClient({
    baseURL: "https://consumer-fixture.invalid",
    basePath: "/v1/auth",
    fetchOptions: {
      customFetchImpl: async () => Response.json(body, { status }),
    },
  });
  return client.signIn.email({
    email: "synthetic@example.test",
    password: "Intentionally synthetic diagnostic input",
  });
}

describe("installed authentication client error consumer", () => {
  it("preserves the generic flat BetterAuth credential error", async () => {
    const result = await installedClientResult(
      {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      },
      401,
    );
    expect(() => authFailure(result)).toThrow("Invalid email or password");
  });

  it("keeps the nested Rootset rate recovery message from BetterFetch", async () => {
    const result = await installedClientResult(
      {
        error: { code: "RATE_LIMITED", message: "Try again in one minute" },
      },
      429,
    );
    expect(result.error).toMatchObject({
      error: { code: "RATE_LIMITED", message: "Try again in one minute" },
    });
    expect(() => authFailure(result)).toThrow("Try again in one minute");
  });

  it("prefers an existing flat message over a nested message", async () => {
    const result = await installedClientResult(
      { message: "Flat error", error: { message: "Nested error" } },
      400,
    );
    expect(() => authFailure(result)).toThrow("Flat error");
  });

  it("uses a nested safe string when the flat message is empty", async () => {
    const result = await installedClientResult(
      { message: " ", error: { message: "Nested error" } },
      400,
    );
    expect(() => authFailure(result)).toThrow("Nested error");
  });

  it("keeps the generic fallback for malformed error messages", async () => {
    for (const body of [
      { message: 123 },
      { message: { privateDetail: "unexpected" } },
      { message: "", error: { message: null } },
      { error: [{ message: "unexpected" }] },
      { error: "unexpected" },
    ]) {
      const result = await installedClientResult(body, 400);
      expect(() => authFailure(result)).toThrow(
        "Authentication could not be completed",
      );
    }
  });

  it("preserves typed email verification failures through the installed client", async () => {
    for (const body of [
      { code: "EMAIL_NOT_VERIFIED", message: "Verify your email" },
      { error: { code: "EMAIL_NOT_VERIFIED", message: "Verify your email" } },
    ]) {
      const result = await installedClientResult(body, 403);
      let failure: unknown;
      try {
        authFailure(result);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        code: "EMAIL_NOT_VERIFIED",
        message: "Verify your email",
      });
    }
  });

  it("leaves successful client results unchanged", async () => {
    const result = await installedClientResult({ success: true }, 200);
    expect(() => authFailure(result)).not.toThrow();
    expect(() => authFailure({})).not.toThrow();
  });
});
