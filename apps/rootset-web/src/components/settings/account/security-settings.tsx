"use client";
import Image from "next/image";
import QRCode from "qrcode";
import { useState } from "react";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { CodeBlock } from "@avgeek-oss/design-system/typography/code-block";
import { StatusBadge } from "./account-status";
import { PasskeySettings } from "./passkey-settings";
import { FormCard, ActionButton } from "./page-parts";
import { AuthForm } from "./auth-form";
import { useAccess } from "./adapter";
import { api } from "./adapter";
export function SecuritySettings() {
  const { user } = useAccess();
  const [setup, setSetup] = useState<{
    uri: string;
    qr: string;
    actionId: string;
  } | null>(null);
  const [mode, setMode] = useState<"idle" | "disable">("idle");
  const changed = () => {
    window.dispatchEvent(new Event("rootset:identity-changed"));
    setMode("idle");
  };
  if (!user) return null;
  return (
    <div className="content-grid lg:grid-cols-2 lg:items-start">
      <FormCard
        title="Authenticator app"
        headerEnd={
          <StatusBadge
            status={user.twoFactorEnabled ? "healthy" : "disabled"}
            label={user.twoFactorEnabled ? "MFA enabled" : "Not enabled"}
            tooltip={
              user.twoFactorEnabled
                ? "Your authenticator app is enabled for sign-in."
                : "Set up an authenticator app to enable two-factor authentication."
            }
          />
        }
      >
        <div className="content-grid">
          <p className="text-sm text-muted">
            An authenticator app adds a one-time code to your password when you
            sign in. Recommended for admins.
          </p>
          {setup ? (
            <>
              <p className="text-sm text-muted">
                Scan this QR code with your authenticator app.
              </p>
              <Image
                src={setup.qr}
                alt="Authenticator setup QR code"
                width={192}
                height={192}
                unoptimized
              />
              <div className="content-grid gap-2">
                <CodeBlock>
                  <CodeBlock.Header>
                    <CodeBlock.Filename>Setup key</CodeBlock.Filename>
                    <CodeBlock.CopyButton
                      code={new URL(setup.uri).searchParams.get("secret") ?? ""}
                    />
                  </CodeBlock.Header>
                  <CodeBlock.Code
                    code={new URL(setup.uri).searchParams.get("secret") ?? ""}
                  />
                </CodeBlock>
              </div>
              <AuthForm
                variant="secondary"
                fields={[
                  {
                    name: "code",
                    label: "Authenticator code",
                    autoComplete: "one-time-code",
                    required: true,
                    maxLength: 6,
                  },
                ]}
                submitLabel="Enable MFA"
                cancelLabel="Cancel setup"
                onCancel={() => {
                  setSetup(null);
                  setMode("idle");
                }}
                onSubmit={async (values) => {
                  await api.post(
                    "/v1/public/auth/identity/two-factor/verify-totp",
                    { ...values, actionId: setup.actionId },
                  );
                  setSetup(null);
                  changed();
                }}
              />
            </>
          ) : mode !== "idle" ? (
            <AuthForm
              variant="secondary"
              key={mode}
              fields={[
                {
                  name: "code",
                  label: "Authenticator code",
                  autoComplete: "one-time-code",
                  required: true,
                  maxLength: 6,
                },
              ]}
              submitLabel="Disable MFA"
              onCancel={() => setMode("idle")}
              onSubmit={async (values) => {
                await api.post("/v1/core/profile/two-factor/manage", {
                  code: values.code,
                  action: mode,
                });
                changed();
              }}
            >
              <p className="text-sm text-muted">
                Future sign-ins will use only your password.
              </p>
            </AuthForm>
          ) : (
            <div className="flex flex-wrap gap-3">
              {user.twoFactorEnabled ? (
                <>
                  <Button variant="danger" onPress={() => setMode("disable")}>
                    Disable MFA
                  </Button>
                </>
              ) : (
                <ActionButton
                  variant="primary"
                  success="Scan the QR code to continue"
                  action={async () => {
                    const result = await api.post<{
                      totpURI: string;
                      actionId: string;
                    }>("/v1/core/profile/two-factor/setup", {});
                    setSetup({
                      uri: result.totpURI,
                      qr: await QRCode.toDataURL(result.totpURI, {
                        width: 192,
                        margin: 2,
                      }),
                      actionId: result.actionId,
                    });
                  }}
                >
                  Set up authenticator
                </ActionButton>
              )}
            </div>
          )}
        </div>
      </FormCard>
      <PasskeySettings />
    </div>
  );
}
