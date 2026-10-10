"use client";
import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { identityRequest } from "./identity-request";
const endpoint = "/passkey";
export function passkeySupported() {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    browserSupportsWebAuthn()
  );
}
function requireSupport() {
  if (!passkeySupported())
    throw new Error(
      "Passkeys require a supported browser on HTTPS or localhost.",
    );
}
export async function registerWebAuthnPasskey(name: string) {
  requireSupport();
  const options = await identityRequest<
    Parameters<typeof startRegistration>[0]["optionsJSON"]
  >(`${endpoint}/generate-register-options`, "GET");
  const response = await startRegistration({
    optionsJSON: options,
  });
  return await identityRequest<{ recoveryCodes?: string[] }>(
    `${endpoint}/verify-registration`,
    "POST",
    { name, response },
  );
}
export async function verifyPasskeySecondFactor(
  signal: AbortSignal,
  onVerifying?: () => void,
) {
  requireSupport();
  const options = await identityRequest<
    Parameters<typeof startAuthentication>[0]["optionsJSON"]
  >(`${endpoint}/generate-authenticate-options`, "GET", undefined, signal);
  signal.throwIfAborted();
  const cancel = () => WebAuthnAbortService.cancelCeremony();
  signal.addEventListener("abort", cancel, { once: true });
  let response;
  try {
    response = await startAuthentication({
      optionsJSON: { ...options, userVerification: "required" },
    });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  signal.throwIfAborted();
  onVerifying?.();
  await identityRequest(`${endpoint}/verify-authentication`, "POST", {
    response,
  });
}
export function passkeyError(error: unknown) {
  if (
    error instanceof Error &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  )
    return "The passkey request was cancelled or timed out. You can try again.";
  return error instanceof Error
    ? error.message
    : "Could not use this passkey. Try again.";
}
