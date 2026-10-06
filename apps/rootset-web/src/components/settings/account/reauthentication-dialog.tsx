"use client";
import { useEffect, useRef, useState } from "react";
import { ConfirmIdentityDialog } from "@avgeek-oss/design-system";
import { verifyPasskeySecondFactor, passkeyError } from "../../../lib/passkeys";
import { identityRequest } from "../../../lib/identity-request";

export function ReauthenticationDialog({
  isOpen,
  onOpenChange,
  hasPasskey,
  onConfirmed,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  hasPasskey: boolean;
  onConfirmed: () => Promise<void>;
}) {
  const request = useRef<AbortController | null>(null);
  const [abortable, setAbortable] = useState(false);
  useEffect(() => () => request.current?.abort(), []);
  const shared = { isOpen, onOpenChange };
  return hasPasskey ? (
    <ConfirmIdentityDialog
      {...shared}
      method="passkey"
      onCancelRequest={abortable ? () => request.current?.abort() : undefined}
      onConfirm={async () => {
        const controller = new AbortController();
        request.current = controller;
        setAbortable(true);
        try {
          await verifyPasskeySecondFactor(controller.signal, () =>
            setAbortable(false),
          );
          if (controller.signal.aborted) return;
          setAbortable(false);
          request.current = null;
          await onConfirmed();
        } catch (error) {
          if (!controller.signal.aborted) throw new Error(passkeyError(error));
        } finally {
          if (request.current === controller) request.current = null;
          setAbortable(false);
        }
      }}
    />
  ) : (
    <ConfirmIdentityDialog
      {...shared}
      onConfirm={async ({ password }) => {
        await identityRequest("/reauthenticate", "POST", { password });
        await onConfirmed();
      }}
    />
  );
}
