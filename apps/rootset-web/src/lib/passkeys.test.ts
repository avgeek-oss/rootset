import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPasskeySecondFactor } from "./passkeys";
import { identityRequest } from "./identity-request";
import {
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";

vi.mock("./identity-request", () => ({ identityRequest: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { isSecureContext: true });
});
afterEach(() => vi.unstubAllGlobals());
describe("abortable passkey proof boundary", () => {
  it("does not start WebAuthn or verify after options-fetch cancellation", async () => {
    const controller = new AbortController();
    vi.mocked(identityRequest).mockImplementationOnce(async () => {
      controller.abort();
      return { challenge: "options" };
    });
    await expect(
      verifyPasskeySecondFactor(controller.signal),
    ).rejects.toThrow();
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(identityRequest).toHaveBeenCalledTimes(1);
    expect(identityRequest).toHaveBeenCalledWith(
      "/passkey/generate-authenticate-options",
      "GET",
      undefined,
      undefined,
      controller.signal,
    );
  });
  it("cancels the authenticator and cannot post a late assertion", async () => {
    const controller = new AbortController();
    vi.mocked(identityRequest).mockResolvedValueOnce({ challenge: "options" });
    vi.mocked(startAuthentication).mockImplementationOnce(async () => {
      controller.abort();
      return { id: "late assertion" } as never;
    });
    await expect(
      verifyPasskeySecondFactor(controller.signal),
    ).rejects.toThrow();
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce();
    expect(identityRequest).toHaveBeenCalledTimes(1);
  });
  it("ends cancellation before submitting the server proof", async () => {
    const controller = new AbortController();
    const onVerifying = vi.fn();
    vi.mocked(identityRequest)
      .mockResolvedValueOnce({ challenge: "options" })
      .mockImplementationOnce(async () => {
        expect(onVerifying).toHaveBeenCalledOnce();
        return { reauthenticated: true };
      });
    vi.mocked(startAuthentication).mockResolvedValue({
      id: "assertion",
    } as never);
    await verifyPasskeySecondFactor(controller.signal, onVerifying);
    expect(identityRequest).toHaveBeenLastCalledWith(
      "/passkey/verify-authentication",
      "POST",
      { response: { id: "assertion" } },
    );
  });
});
