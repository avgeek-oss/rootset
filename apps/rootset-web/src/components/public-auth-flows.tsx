"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import {
  AuthForm,
  ForgotPassword,
  ResetLinkSent,
  PasswordSetup,
  TeamSetup,
  InvitationUnavailable,
  AcceptInvitation,
  InvitationVerification,
} from "@avgeek-oss/design-system";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { ApiError, RootsetClient } from "@rootset/web-client";
import { PreferencesSchema } from "@rootset/contracts";
import { authClient } from "../lib/auth-client";
import { authFailure } from "../lib/auth-failure";
import { setupPreferenceOptions } from "../lib/date-time-options";
import { AuthBrand, AuthFrame, authTextActionClassName } from "./auth-frame";

const publicApi = new RootsetClient({ baseUrl: "/v1" });
const back = () => window.location.assign("/login");
const secretFields = [
  {
    name: "bootstrapSecret",
    label: "Installation setup secret",
    type: "password",
    required: true,
    autoComplete: "off",
  },
];

export function InitialTeamSetup() {
  const [secret, setSecret] = useState("");
  const [editingSecret, setEditingSecret] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [options] = useState(setupPreferenceOptions);
  if (complete)
    return (
      <AuthFrame
        title="Verify your email"
        description="Check your email to verify the admin account, then sign in."
      >
        <Link href="/login" className={authTextActionClassName}>
          Continue to sign in
        </Link>
      </AuthFrame>
    );
  if (!secret)
    return (
      <AuthFrame
        title="Set up Rootset"
        description="Enter the installation setup secret from your environment file."
      >
        <AuthForm
          fields={secretFields}
          submitLabel="Continue"
          onSubmit={async (values) => setSecret(values.bootstrapSecret ?? "")}
        />
      </AuthFrame>
    );
  return (
    <div className="grid w-full gap-4">
      <TeamSetup
        brand={<AuthBrand />}
        preferenceOptions={options}
        onSubmit={async ({
          team,
          name,
          email,
          password,
          timeZone,
          dateFormat,
          timeFormat,
        }) => {
          setBusy(true);
          try {
            await publicApi.request("/setup", {
              method: "POST",
              body: {
                bootstrapSecret: secret,
                organisationName: team.trim(),
                name: name.trim(),
                email: email.trim(),
                password,
                preferences: PreferencesSchema.pick({
                  timezone: true,
                  dateFormat: true,
                  timeFormat: true,
                }).parse({ timezone: timeZone, dateFormat, timeFormat }),
              },
            });
            setSecret("");
            setComplete(true);
          } finally {
            setBusy(false);
          }
        }}
      />
      <div className="mx-auto w-full max-w-sm px-4 sm:px-0">
        <Button
          variant="secondary"
          isDisabled={busy}
          onPress={() => setEditingSecret(true)}
        >
          Change setup secret
        </Button>
      </div>
      <Modal.Backdrop isOpen={editingSecret} onOpenChange={setEditingSecret}>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Installation setup secret</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <AuthForm
                variant="secondary"
                fields={secretFields.map((field) => ({
                  ...field,
                  defaultValue: secret,
                }))}
                submitLabel="Save changes"
                onSubmit={async (values) => {
                  setSecret(values.bootstrapSecret ?? "");
                  setEditingSecret(false);
                }}
              />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  return sent ? (
    <ResetLinkSent brand={<AuthBrand />} onBackToSignIn={back} />
  ) : (
    <ForgotPassword
      brand={<AuthBrand />}
      onBackToSignIn={back}
      onSubmit={async ({ email }) => {
        authFailure(
          await authClient.requestPasswordReset({
            email,
            redirectTo: `${window.location.origin}/reset-password`,
          }),
        );
        setSent(true);
      }}
    />
  );
}

export function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token");
  const [complete, setComplete] = useState(false);
  if (token && !complete)
    return (
      <PasswordSetup
        brand={<AuthBrand />}
        onBackToSignIn={back}
        onSubmit={async ({ password }) => {
          authFailure(
            await authClient.resetPassword({ newPassword: password, token }),
          );
          window.history.replaceState(null, "", "/reset-password");
          setComplete(true);
        }}
      />
    );
  return (
    <AuthFrame
      title={complete ? "Password updated" : "Choose a new password"}
      description={
        complete
          ? "Your previous sessions have been signed out."
          : "This link is missing or has expired. Request a new password reset."
      }
    >
      {!complete && (
        <Link href="/forgot-password" className={authTextActionClassName}>
          Request a new link
        </Link>
      )}
      <Link href="/login" className={authTextActionClassName}>
        Back to Sign In
      </Link>
    </AuthFrame>
  );
}

export function VerificationForm() {
  const [sent, setSent] = useState(false);
  return (
    <AuthFrame
      title="Verify your email"
      description={
        sent
          ? "Check your email. If your account is eligible, the link will arrive shortly."
          : "Request a fresh verification link for your Rootset account."
      }
    >
      {!sent && (
        <AuthForm
          fields={[
            {
              name: "email",
              label: "Email",
              type: "email",
              autoComplete: "email",
              required: true,
            },
          ]}
          submitLabel="Send link"
          busyLabel="Sending…"
          onSubmit={async ({ email }) => {
            authFailure(
              await authClient.sendVerificationEmail({
                email: email ?? "",
                callbackURL: `${window.location.origin}/`,
              }),
            );
            setSent(true);
          }}
        />
      )}
      <Link href="/login" className={authTextActionClassName}>
        Back to Sign In
      </Link>
    </AuthFrame>
  );
}

export function InvitationScreen({ token }: { token: string }) {
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
  const [verifying, setVerifying] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const verifyRequestPending = useRef(false);
  const [existing, setExisting] = useState(false);
  const [setupToken, setSetupToken] = useState<string>();
  if (invitation.isError) {
    if (
      !(invitation.error instanceof ApiError) ||
      ![404, 410].includes(invitation.error.status)
    )
      return (
        <QueryError
          message={invitation.error.message}
          onRetry={() => void invitation.refetch()}
        />
      );
    return (
      <InvitationUnavailable brand={<AuthBrand />} onBackToSignIn={back} />
    );
  }
  if (!invitation.data || session.isPending) return <QueryLoading />;
  if (session.error)
    return (
      <QueryError
        message={session.error.message ?? "Your session could not be loaded."}
        onRetry={() => window.location.reload()}
      />
    );
  const details = invitation.data;
  const self = `/invite/${token}`;
  const signIn = () =>
    window.location.assign(`/login?returnTo=${encodeURIComponent(self)}`);
  if (setupToken)
    return (
      <PasswordSetup
        brand={<AuthBrand />}
        mode="first"
        onBackToSignIn={signIn}
        onSubmit={async ({ password }) => {
          await publicApi.request(`/auth/invitations/${token}/signup`, {
            method: "POST",
            body: { setupToken, password },
          });
          window.location.replace("/");
        }}
      />
    );
  if (!session.data && verifying)
    return (
      <InvitationVerification
        brand={<AuthBrand />}
        teamName={details.organisationName}
        maxNameLength={120}
        onSubmit={async (values) => {
          const result = await publicApi.request<{ setupToken: string }>(
            `/auth/invitations/${token}/code`,
            { method: "POST", body: values },
          );
          setSetupToken(result.setupToken);
        }}
      />
    );
  if (!session.data && !existing)
    return (
      <AcceptInvitation
        brand={<AuthBrand />}
        teamName={details.organisationName}
        role={details.role[0]!.toUpperCase() + details.role.slice(1)}
        isPending={verifyPending}
        onBackToSignIn={signIn}
        onVerifyEmail={() => {
          if (verifyRequestPending.current) return;
          verifyRequestPending.current = true;
          setVerifyPending(true);
          void publicApi
            .request<{ existingAccount: boolean }>(
              `/auth/invitations/${token}/verify`,
              { method: "POST", body: {} },
            )
            .then((result) => {
              setExisting(result.existingAccount);
              setVerifying(!result.existingAccount);
            })
            .catch((error: unknown) =>
              toast.danger(
                error instanceof Error
                  ? error.message
                  : "Unable to verify invitation",
              ),
            )
            .finally(() => {
              verifyRequestPending.current = false;
              setVerifyPending(false);
            });
        }}
      />
    );
  return (
    <AuthFrame
      title={`Join ${details.organisationName}`}
      description={`Invited as ${details.role[0]!.toUpperCase() + details.role.slice(1)}. ${details.role === "admin" ? "Manage the installation, data and team." : details.role === "member" ? "Read data and create, edit or delete rows." : "Read and export data."}`}
    >
      <p className="break-words text-sm">{details.email}</p>
      {session.data && session.data.user.email !== details.email ? (
        <>
          <p>Sign out and use the email address on this invitation.</p>
          <AuthForm
            fields={[]}
            submitLabel="Sign out"
            onSubmit={async () => {
              authFailure(await authClient.signOut());
              window.location.reload();
            }}
          />
        </>
      ) : session.data ? (
        <AuthForm
          fields={[]}
          submitLabel="Join team"
          onSubmit={async () => {
            await publicApi.request(`/auth/invitations/${token}/accept`, {
              method: "POST",
              body: {},
            });
            window.location.replace("/");
          }}
        />
      ) : (
        <>
          <p>
            An account already exists for this email. Sign in to accept your
            invitation.
          </p>
          <Link
            href={`/login?returnTo=${encodeURIComponent(self)}`}
            className={authTextActionClassName}
          >
            Already have an account? Sign in
          </Link>
        </>
      )}
    </AuthFrame>
  );
}
