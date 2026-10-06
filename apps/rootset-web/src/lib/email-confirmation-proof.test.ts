import { describe, expect, it, vi } from "vitest";
import { readEmailChangeProof } from "./email-confirmation-proof";

describe("email-change confirmation URL", () => {
  const token = "a".repeat(43);
  it.each([
    `http://localhost/email-change#${token}`,
    `http://localhost/email-change?token=${token}&unrelated=value`,
    `http://localhost/confirm-email-change?token=${token}`,
  ])(
    "reads proof and clears the URL while preserving router state: %s",
    (href) => {
      const state = { router: "retained" };
      const history = { state, replaceState: vi.fn() };
      expect(readEmailChangeProof({ href }, history)).toBe(token);
      expect(history.replaceState).toHaveBeenCalledOnce();
      expect(history.replaceState).toHaveBeenCalledWith(
        state,
        "",
        new URL(href).pathname,
      );
    },
  );
  it.each(["", "a", "a".repeat(44), "invalid.proof"])(
    "rejects missing or malformed proof without retaining it in the URL: %s",
    (proof) => {
      const history = { state: null, replaceState: vi.fn() };
      expect(
        readEmailChangeProof(
          { href: `http://localhost/email-change#${proof}` },
          history,
        ),
      ).toBeNull();
      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "/email-change",
      );
    },
  );
  it("does not fall back to a query credential when a malformed fragment is present", () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(
      readEmailChangeProof(
        { href: `http://localhost/email-change?token=${token}#wrong` },
        history,
      ),
    ).toBeNull();
  });
});
