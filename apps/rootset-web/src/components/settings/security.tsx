"use client";

import { useEffect, useRef, useState } from "react";
import { ReauthenticationDialog } from "./account/reauthentication-dialog";
import { read, registerIdentityHandler } from "./api";

export function IdentityConfirmation() {
  const [hasPasskey, setHasPasskey] = useState(false);
  const [open, setOpen] = useState(false);
  const pending = useRef<
    { resolve: () => void; reject: (error: Error) => void } | undefined
  >(undefined);
  useEffect(() => {
    const unregister = registerIdentityHandler(async () => {
      const security = await read<{ twoFactorEnabled: boolean }>(
        "/me/security",
      );
      setHasPasskey(Boolean(security.twoFactorEnabled));
      return new Promise<void>((resolve, reject) => {
        pending.current?.reject(
          Object.assign(new Error("Identity confirmation cancelled."), {
            code: "ACTION_CANCELLED",
          }),
        );
        pending.current = { resolve, reject };
        setOpen(true);
      });
    });
    return () => {
      unregister();
      pending.current?.reject(
        Object.assign(new Error("Identity confirmation cancelled."), {
          code: "ACTION_CANCELLED",
        }),
      );
      pending.current = undefined;
    };
  }, []);
  return (
    <ReauthenticationDialog
      isOpen={open}
      hasPasskey={hasPasskey}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          pending.current?.reject(
            Object.assign(new Error("Identity confirmation cancelled."), {
              code: "ACTION_CANCELLED",
            }),
          );
          pending.current = undefined;
        }
      }}
      onConfirmed={async () => {
        const current = pending.current;
        pending.current = undefined;
        setOpen(false);
        current?.resolve();
      }}
    />
  );
}
