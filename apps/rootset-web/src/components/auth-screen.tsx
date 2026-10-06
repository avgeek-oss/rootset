"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AuthForm,
  AuthPage,
  AsyncActionButton,
  IdentityCredentialsForm,
} from "@avgeek-oss/design-system";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Login01Icon } from "@hugeicons/core-free-icons";
import { authClient } from "../lib/auth-client";
import { authFailure } from "../lib/auth-failure";
import { AuthFrame, authTextActionClassName } from "./auth-frame";
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
}: {
  path: string;
  claimed: boolean;
  onSignedIn: () => void;
}) {
  const invitation = path.startsWith("/invite/")
    ? path.slice(8)
    : path.startsWith("/invitations/")
      ? path.slice(13)
      : null;
  return (
    <AuthPage>
      {!claimed ? (
        <InitialTeamSetup />
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
  const [factor, setFactor] = useState<"totp" | "recovery" | null>(null);
  const [busy, setBusy] = useState(false);
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
  if (factor)
    return (
      <AuthFrame
        title={
          factor === "totp"
            ? "Enter your verification code"
            : "Use a recovery code"
        }
        description={
          factor === "totp"
            ? "Enter the current code from your authenticator app."
            : "Each recovery code can be used once."
        }
      >
        <AuthForm
          key={factor}
          fields={[
            {
              name: "code",
              label: factor === "totp" ? "Verification code" : "Recovery code",
              required: true,
              autoComplete: "one-time-code",
              inputMode: factor === "totp" ? "numeric" : "text",
              ...(factor === "totp"
                ? { minLength: 6, maxLength: 6, pattern: "[0-9]{6}" }
                : {}),
            },
          ]}
          submitLabel="Verify and sign in"
          busyLabel="Verifying…"
          onSubmit={async ({ code }) =>
            authenticate(async () => {
              authFailure(
                factor === "totp"
                  ? await authClient.twoFactor.verifyTotp({
                      code: code ?? "",
                      trustDevice: false,
                    })
                  : await authClient.twoFactor.verifyBackupCode({
                      code: code ?? "",
                      trustDevice: false,
                    }),
              );
              onSignedIn();
            })
          }
        >
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => setFactor(factor === "totp" ? "recovery" : "totp")}
          >
            {factor === "totp"
              ? "Use a recovery code"
              : "Use an authenticator code"}
          </Button>
        </AuthForm>
      </AuthFrame>
    );
  return (
    <AuthFrame
      title="Sign in"
      description="Sign in to your team’s Rootset instance."
    >
      <IdentityCredentialsForm
        identifierLabel="Email"
        identifierType="email"
        identifierAutoComplete="email"
        defaultIdentifier={params.get("email") ?? ""}
        disabled={busy}
        submitIcon={<HugeiconsIcon aria-hidden icon={Login01Icon} size={16} />}
        passwordAction={
          <Link href="/forgot-password" className={authTextActionClassName}>
            Forgot password?
          </Link>
        }
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
            )
              setFactor("totp");
            else onSignedIn();
          })
        }
      />
      <AsyncActionButton
        className="w-full"
        variant="secondary"
        isDisabled={busy}
        pendingLabel="Waiting for your passkey…"
        onAction={() =>
          authenticate(async () => {
            authFailure(await authClient.signIn.passkey());
            onSignedIn();
          })
        }
      >
        Sign in with Passkey
      </AsyncActionButton>
      <Link className={authTextActionClassName} href="/verification">
        Need a new verification email?
      </Link>
    </AuthFrame>
  );
}
