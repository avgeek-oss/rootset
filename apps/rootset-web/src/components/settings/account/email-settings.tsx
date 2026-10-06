"use client";
import { FieldDescription } from "@avgeek-oss/design-system/forms/field";
import { useEffect, useId, useState } from "react";

import { StatusBadge } from "./account-status";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { FormCard, SimpleForm, ActionButton } from "./page-parts";
import { useAccess } from "./adapter";
import { useApiQuery } from "./adapter";
import { api } from "./adapter";

export function EmailSettings() {
  const { user } = useAccess();
  const emailId = useId();
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [secondsUntilResend, setSecondsUntilResend] = useState(0);
  useEffect(() => {
    if (!resendAt) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      setSecondsUntilResend(remaining);
      if (!remaining) setResendAt(0);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);
  const query = useApiQuery<{
    pending: { email: string; expiresAt: string } | null;
  }>("/v1/core/profile/email-change");
  if (!user) return null;
  return (
    <>
      <FormCard
        title="Email address"
        headerEnd={
          user.emailVerified ? (
            <StatusBadge
              status="verified"
              label="Verified"
              tooltip="Your current email address is verified."
            />
          ) : (
            <button
              type="button"
              className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label="Unverified email. Resend confirmation email"
              onClick={() => setVerificationOpen(true)}
            >
              <StatusBadge
                status="pending"
                label="Unverified"
                tooltip="Confirm your email address. Click to resend the confirmation email."
              />
            </button>
          )
        }
      >
        <div className="content-grid">
          <div className="grid gap-2">
            <Label htmlFor={emailId}>Current email</Label>
            <Input
              id={emailId}
              value={user.email}
              type="email"
              disabled
              variant="secondary"
            />
          </div>
          <SimpleForm
            fields={[
              {
                name: "email",
                label: "New email address",
                required: true,
                type: "email",
                maxLength: 320,
                variant: "secondary",
                autoComplete: "email",
              },
            ]}
            submitLabel="Send confirmation"
            successMessage="Confirmation email queued"
            onSubmit={async (values) => {
              await api.post("/v1/core/profile/email-change", values);
              query.refresh();
            }}
          />
          <FieldDescription>
            We’ll send a confirmation link to your new address. Your sign-in
            email changes only after you confirm it.
          </FieldDescription>
          {query.error ? (
            <p role="alert" className="text-sm text-danger">
              {query.error}
            </p>
          ) : null}
          {query.data?.pending ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted break-words">
                Waiting for confirmation at {query.data.pending.email}. The
                confirmation link is valid for one hour.
              </p>
              <div>
                <ActionButton
                  success="Email change cancelled"
                  action={async () => {
                    await api.delete("/v1/core/profile/email-change");
                    query.refresh();
                  }}
                >
                  Cancel email change
                </ActionButton>
              </div>
            </div>
          ) : null}
        </div>
      </FormCard>
      <Modal.Backdrop
        isOpen={verificationOpen}
        onOpenChange={setVerificationOpen}
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Verify your email</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="content-grid">
              <p>
                We’ll send a confirmation link to{" "}
                <span className="break-words font-medium">{user.email}</span>.
              </p>
              <div className="flex flex-wrap justify-end gap-3">
                <Button
                  variant="secondary"
                  onPress={() => setVerificationOpen(false)}
                >
                  Cancel
                </Button>
                <ActionButton
                  isDisabled={secondsUntilResend > 0}
                  pendingLabel="Sending…"
                  success="Confirmation email queued"
                  action={async () => {
                    await api.post(
                      "/v1/public/auth/identity/send-verification-email",
                      {
                        email: user.email,
                        callbackURL: `${window.location.origin}/settings/email-password`,
                      },
                    );
                    setSecondsUntilResend(60);
                    setResendAt(Date.now() + 60_000);
                  }}
                >
                  {secondsUntilResend > 0
                    ? `Resend in ${secondsUntilResend}s`
                    : "Resend confirmation"}
                </ActionButton>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
