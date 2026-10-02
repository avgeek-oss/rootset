"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Label, TextField } from "@heroui/react";
import {
  IdentityAuthFrame,
  IdentityCredentialsForm,
} from "@rootset/identity-web-ui";
import { authClient } from "../lib/auth-client";
import { RootsetClient } from "@rootset/web-client";

const publicApi = new RootsetClient({ baseUrl: "/v1" });

function authFailure(result: { error?: { message?: string } | null }) {
  if (result.error)
    throw new Error(
      result.error.message ?? "Authentication could not be completed",
    );
}

export function AuthScreen({
  path,
  claimed,
  onSignedIn,
}: {
  path: string;
  claimed: boolean;
  onSignedIn: () => void;
}) {
  const [phase, setPhase] = useState<"credentials" | "totp" | "recovery">(
    "credentials",
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSetup = !claimed;
  const isReset = path === "/reset-password";
  const isForgot = path === "/forgot-password";
  const isVerification = path === "/verification" || path === "/verify-email";
  const invitation = path.startsWith("/invite/")
    ? path.slice(8)
    : path.startsWith("/invitations/")
      ? path.slice(13)
      : null;

  async function perform(operation: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The request could not be completed",
      );
    } finally {
      setPending(false);
    }
  }

  async function setup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      await publicApi.request("/setup", {
        method: "POST",
        body: {
          bootstrapSecret: form.get("bootstrapSecret"),
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
          organisationName: form.get("organisationName"),
        },
      });
      setNotice(
        "Check your email to verify the owner account, then sign in. The organisation is awaiting verification.",
      );
    });
  }

  if (isSetup)
    return (
      <IdentityAuthFrame
        title="Set up Rootset"
        description="Create the first owner account and organisation for this installation."
      >
        {notice ? (
          <>
            <p className="notice" role="status">
              {notice}
            </p>
            <a href="/login">Continue to sign in</a>
          </>
        ) : (
          <form className="identity-form" onSubmit={setup}>
            <TextField name="organisationName" isRequired>
              <Label>Organisation name</Label>
              <Input autoComplete="organization" />
            </TextField>
            <TextField name="name" isRequired>
              <Label>Your name</Label>
              <Input autoComplete="name" />
            </TextField>
            <TextField name="email" type="email" isRequired>
              <Label>Email address</Label>
              <Input autoComplete="email" />
            </TextField>
            <TextField name="password" type="password" isRequired>
              <Label>Password</Label>
              <Input minLength={15} autoComplete="new-password" />
            </TextField>
            <TextField name="bootstrapSecret" type="password" isRequired>
              <Label>Installation setup secret</Label>
              <Input autoComplete="off" />
            </TextField>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" isDisabled={pending}>
              {pending ? "Creating account…" : "Create owner account"}
            </Button>
          </form>
        )}
      </IdentityAuthFrame>
    );

  if (isForgot || isVerification)
    return (
      <IdentityAuthFrame
        title={isForgot ? "Reset your password" : "Verify your email"}
        description={
          isForgot
            ? "We’ll send a reset link if your account is eligible."
            : "Request a fresh verification link for your Rootset account."
        }
      >
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            const email = String(
              new FormData(event.currentTarget).get("email") ?? "",
            );
            void perform(async () => {
              const result = isForgot
                ? await authClient.requestPasswordReset({
                    email,
                    redirectTo: `${location.origin}/reset-password`,
                  })
                : await authClient.sendVerificationEmail({
                    email,
                    callbackURL: `${location.origin}/`,
                  });
              authFailure(result);
              setNotice(
                "Check your email. If your account is eligible, the link will arrive shortly.",
              );
            });
          }}
        >
          <TextField name="email" type="email" isRequired>
            <Label>Email address</Label>
            <Input autoComplete="email" />
          </TextField>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" isDisabled={pending}>
            {pending ? "Sending…" : "Send link"}
          </Button>
          <a href="/login">Back to sign in</a>
        </form>
      </IdentityAuthFrame>
    );

  if (isReset)
    return (
      <IdentityAuthFrame
        title="Choose a new password"
        description="Your second factor stays enabled after a password reset."
      >
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            const newPassword = String(
              new FormData(event.currentTarget).get("password") ?? "",
            );
            void perform(async () => {
              const token =
                new URLSearchParams(location.search).get("token") ?? "";
              authFailure(
                await authClient.resetPassword({ newPassword, token }),
              );
              setNotice(
                "Your password was changed. Sign in with your password and any required second factor.",
              );
            });
          }}
        >
          <TextField name="password" type="password" isRequired>
            <Label>New password</Label>
            <Input minLength={15} autoComplete="new-password" />
          </TextField>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {notice ? (
            <>
              <p className="notice" role="status">
                {notice}
              </p>
              <a href="/login">Sign in</a>
            </>
          ) : (
            <Button type="submit" isDisabled={pending}>
              Change password
            </Button>
          )}
        </form>
      </IdentityAuthFrame>
    );

  if (invitation) return <InvitationScreen token={invitation} />;

  if (phase !== "credentials")
    return (
      <IdentityAuthFrame
        title={
          phase === "totp"
            ? "Enter your verification code"
            : "Use a recovery code"
        }
        description={
          phase === "totp"
            ? "Enter the current code from your authenticator app."
            : "Each recovery code can be used once."
        }
      >
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            const code = String(
              new FormData(event.currentTarget).get("code") ?? "",
            );
            void perform(async () => {
              authFailure(
                phase === "totp"
                  ? await authClient.twoFactor.verifyTotp({
                      code,
                      trustDevice: false,
                    })
                  : await authClient.twoFactor.verifyBackupCode({
                      code,
                      trustDevice: false,
                    }),
              );
              onSignedIn();
            });
          }}
        >
          <TextField name="code" isRequired>
            <Label>
              {phase === "totp" ? "Verification code" : "Recovery code"}
            </Label>
            <Input
              autoComplete="one-time-code"
              inputMode={phase === "totp" ? "numeric" : "text"}
              autoFocus
            />
          </TextField>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" isDisabled={pending}>
            {pending ? "Verifying…" : "Verify and sign in"}
          </Button>
          <Button
            variant="secondary"
            onPress={() => setPhase(phase === "totp" ? "recovery" : "totp")}
          >
            {phase === "totp"
              ? "Use a recovery code"
              : "Use an authenticator code"}
          </Button>
        </form>
      </IdentityAuthFrame>
    );

  return (
    <IdentityAuthFrame
      title="Sign in to Rootset"
      description="Continue to your organisation’s structured data."
    >
      <IdentityCredentialsForm
        error={error}
        passwordAction={<a href="/forgot-password">Forgot password?</a>}
        onSubmit={async ({ email, password }) => {
          setError(null);
          const result = await authClient.signIn.email({ email, password });
          authFailure(result);
          if (
            result.data &&
            "twoFactorRedirect" in result.data &&
            result.data.twoFactorRedirect
          )
            setPhase("totp");
          else onSignedIn();
        }}
      />
      <Button
        variant="secondary"
        isDisabled={pending}
        onPress={() =>
          void perform(async () => {
            authFailure(await authClient.signIn.passkey());
            onSignedIn();
          })
        }
      >
        Sign in with a passkey
      </Button>
      <a href="/verification">Need a new verification email?</a>
    </IdentityAuthFrame>
  );
}

function InvitationScreen({ token }: { token: string }) {
  const invitation = useQuery({
    queryKey: ["invitation", token],
    queryFn: ({ signal }) =>
      publicApi.request<{
        email: string;
        role: string;
        organisationName: string;
        expiresAt: string;
      }>(`/auth/invitations/${encodeURIComponent(token)}`, { signal }),
  });
  const session = authClient.useSession();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <IdentityAuthFrame
      title="Join an organisation"
      description={
        invitation.data
          ? `You’re invited to ${invitation.data.organisationName} as ${invitation.data.role}.`
          : "Loading invitation details…"
      }
    >
      {invitation.isError ? (
        <p role="alert" className="error-message">
          {invitation.error.message}
        </p>
      ) : (
        invitation.data && (
          <>
            <p>
              Invitation for <strong>{invitation.data.email}</strong>. Expires{" "}
              {new Date(invitation.data.expiresAt).toLocaleString()}.
            </p>
            {notice ? (
              <>
                <p role="status" className="notice">
                  {notice}
                </p>
                <a href="/login">Continue to sign in</a>
              </>
            ) : session.data ? (
              <>
                <p>Signed in as {session.data.user.email}.</p>
                <Button
                  isDisabled={pending}
                  onPress={async () => {
                    setPending(true);
                    setError(null);
                    try {
                      await publicApi.request("/auth/invitations/accept", {
                        method: "POST",
                        body: { token },
                      });
                      location.assign("/");
                    } catch (failure) {
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : "Invitation acceptance failed",
                      );
                    } finally {
                      setPending(false);
                    }
                  }}
                >
                  Accept invitation
                </Button>
              </>
            ) : (
              <>
                <IdentityCredentialsForm
                  nameRequired
                  emailReadOnly
                  defaultEmail={invitation.data.email}
                  submitLabel="Create account and accept"
                  onSubmit={async ({ password, name }) => {
                    await publicApi.request("/auth/invitations/accept", {
                      method: "POST",
                      body: { token, password, name },
                    });
                    setNotice(
                      "Verify your email, then sign in and reopen this invitation to complete membership acceptance.",
                    );
                  }}
                />
                <a
                  href={`/login?returnTo=${encodeURIComponent(`/invite/${token}`)}`}
                >
                  Already have an account? Sign in
                </a>
              </>
            )}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </>
        )
      )}
    </IdentityAuthFrame>
  );
}
