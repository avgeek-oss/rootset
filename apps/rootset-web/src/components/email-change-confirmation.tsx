"use client";

import { useEffect, useRef, useState } from "react";
import { EmailConfirmation } from "@avgeek-oss/design-system";
import { ApiError, RootsetClient, browserApiOrigin } from "@rootset/web-client";
import { AuthBrand } from "./auth-frame";
import { readEmailChangeProof } from "../lib/email-confirmation-proof";

const publicApi = new RootsetClient({
  baseUrl: () => `${browserApiOrigin()}/v1`,
});
type Status = "checking" | "ready" | "confirmed" | "unavailable";

export function EmailChangeConfirmation() {
  const proof = useRef<string | null | undefined>(undefined);
  const [status, setStatus] = useState<Status>("checking");
  const [retryable, setRetryable] = useState(false);

  async function inspect(token: string, signal?: AbortSignal) {
    const result = await publicApi.request<{ status: string }>(
      "/auth/email-change/inspect",
      { method: "POST", body: { token }, signal },
    );
    if (result.status !== "ready")
      throw new Error("Email confirmation could not be checked. Try again.");
    if (!signal?.aborted) {
      setRetryable(false);
      setStatus("ready");
    }
  }

  function unavailable(error: unknown) {
    const permanent =
      error instanceof ApiError && [410, 422].includes(error.status);
    if (permanent) proof.current = null;
    setRetryable(!permanent);
    setStatus("unavailable");
  }

  useEffect(() => {
    if (proof.current === undefined)
      proof.current = readEmailChangeProof(window.location, window.history);
    if (!proof.current) {
      setStatus("unavailable");
      return;
    }
    const controller = new AbortController();
    void inspect(proof.current, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) unavailable(error);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const reloadForNewProof = () => {
      if (window.location.hash) window.location.reload();
    };
    window.addEventListener("hashchange", reloadForNewProof);
    return () => window.removeEventListener("hashchange", reloadForNewProof);
  }, []);

  const shared = {
    brand: <AuthBrand />,
    purpose: "email-change" as const,
    onBackToSignIn: () => window.location.assign("/login"),
  };
  if (status === "ready")
    return (
      <EmailConfirmation
        {...shared}
        status="ready"
        onConfirm={async () => {
          try {
            const result = await publicApi.request<{ changed: boolean }>(
              "/auth/email-change/confirm",
              { method: "POST", body: { token: proof.current } },
            );
            if (result.changed !== true)
              throw new Error(
                "Email confirmation was not completed. Try again.",
              );
            proof.current = null;
            setStatus("confirmed");
            window.dispatchEvent(new Event("rootset:identity-changed"));
          } catch (error) {
            if (error instanceof ApiError && [410, 422].includes(error.status))
              unavailable(error);
            throw error;
          }
        }}
      />
    );
  if (status === "unavailable")
    return (
      <EmailConfirmation
        {...shared}
        status="unavailable"
        onRetry={
          retryable && proof.current
            ? async () => {
                try {
                  await inspect(proof.current!);
                } catch (error) {
                  unavailable(error);
                  throw error;
                }
              }
            : undefined
        }
      />
    );
  return <EmailConfirmation {...shared} status={status} />;
}
