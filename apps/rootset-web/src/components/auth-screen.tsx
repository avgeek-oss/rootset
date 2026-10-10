"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AuthPage,
  SignIn,
  PasskeyRecoveryVerification,
  PasskeyVerification,
} from "@avgeek-oss/design-system";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { verifyPasskeySecondFactor, passkeyError } from "../lib/passkeys";
import { identityRequest } from "../lib/identity-request";
import { authClient } from "../lib/auth-client";
import { authFailure } from "../lib/auth-failure";
import { AuthBrand } from "./auth-frame";
import {
  InitialTeamSetup,
  ForgotPasswordForm,
  ResetPasswordForm,
  VerificationForm,
  InvitationScreen,
} from "./public-auth-flows";

export function AuthScreen({
  path,
  claimed,
  onSignedIn,
  onSetupComplete,
}: {
  path: string;
  claimed: boolean;
  onSignedIn: () => void;
  onSetupComplete: () => void;
}) {
  const invitation = path.startsWith("/invite/")
    ? path.slice(8)
    : path.startsWith("/invitations/")
      ? path.slice(13)
      : null;
  return (
    <AuthPage>
      {!claimed ? (
        <InitialTeamSetup onContinue={onSetupComplete} />
      ) : path === "/forgot-password" ? (
        <ForgotPasswordForm />
      ) : path === "/reset-password" ? (
        <ResetPasswordForm />
      ) : path === "/verification" || path === "/verify-email" ? (
        <VerificationForm />
      ) : invitation ? (
        <InvitationScreen token={invitation} />
      ) : (
        <LoginForm onSignedIn={onSignedIn} />
      )}
    </AuthPage>
  );
}

function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const params = useSearchParams();
  const [factor, setFactor] = useState<"passkey" | "recovery" | null>(null);
  const [busy, setBusy] = useState(false);
  const [abortable, setAbortable] = useState(false);
  const pending = useRef(false);
  async function authenticate(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const passkeyRequest = useRef<AbortController | null>(null);
  useEffect(() => () => passkeyRequest.current?.abort(), []);
  const verify = useCallback(async () => {
    const controller = new AbortController();
    passkeyRequest.current?.abort();
    passkeyRequest.current = controller;
    setBusy(true);
    try {
      await verifyPasskeySecondFactor(controller.signal);
      if (!controller.signal.aborted) onSignedIn();
    } catch (error) {
      if (!controller.signal.aborted) toast.danger(passkeyError(error));
    } finally {
      if (passkeyRequest.current === controller) {
        passkeyRequest.current = null;
        setBusy(false);
      }
    }
  }, [onSignedIn]);
  const back = () => {
    passkeyRequest.current?.abort();
    setFactor(null);
    setBusy(false);
  };
  if (factor === "recovery")
    return (
      <PasskeyRecoveryVerification
        brand={<AuthBrand />}
        onSubmit={async ({ code }) => {
          await identityRequest("/passkey/verify-recovery-code", "POST", {
            code,
          });
          onSignedIn();
        }}
        onPasskeyVerification={() => setFactor("passkey")}
        onBackToSignIn={back}
      />
    );
  if (factor === "passkey")
    return (
      <PasskeyVerification
        brand={<AuthBrand />}
        isPending={busy}
        onRetry={() => void verify()}
        onCancelRequest={
          abortable
            ? () => {
                passkeyRequest.current?.abort();
                setBusy(false);
                setAbortable(false);
              }
            : undefined
        }
        onRecoverySignIn={() => setFactor("recovery")}
        onBackToSignIn={back}
      />
    );
  return (
    <SignIn
      brand={<AuthBrand />}
      defaultEmail={params.get("email") ?? ""}
      isPending={busy}
      onForgotPassword={() => window.location.assign("/forgot-password")}
      onResendVerification={() => window.location.assign("/verification")}
      onSubmit={async ({ identifier, password }) =>
        authenticate(async () => {
          const result = await authClient.signIn.email({
            email: identifier,
            password,
          });
          authFailure(result);
          if (
            result.data &&
            "twoFactorRedirect" in result.data &&
            result.data.twoFactorRedirect
          ) {
            setFactor("passkey");
            await verify();
          } else onSignedIn();
        })
      }
      onPasskeySignIn={() => {
        setFactor("passkey");
        void verify();
      }}
    />
  );
}
