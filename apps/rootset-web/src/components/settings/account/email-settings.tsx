"use client";

import { useState } from "react";
import { EmailChangeSettings } from "@avgeek-oss/design-system";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { api, useAccess, useApiQuery, useDateDisplay } from "./adapter";

export function EmailSettings() {
  const { user } = useAccess();
  const [resendAt, setResendAt] = useState(0);
  const displayDate = useDateDisplay();
  const query = useApiQuery<{
    pending: { email: string; expiresAt: string } | null;
  }>("/v1/core/profile/email-change");
  if (!user) return null;
  return (
    <EmailChangeSettings
      email={user.email}
      isVerified={Boolean(user.emailVerified)}
      pendingChange={query.data?.pending}
      error={query.error}
      formatDate={displayDate}
      resendAvailableAt={resendAt}
      onRequestChange={async (email) => {
        await api.post("/v1/core/profile/email-change", { email });
        query.refresh();
        toast.success("Confirmation email queued");
      }}
      onCancelChange={async () => {
        await api.delete("/v1/core/profile/email-change");
        query.refresh();
        toast.success("Email change cancelled");
      }}
      onResendVerification={async () => {
        await api.post("/v1/public/auth/identity/send-verification-email", {
          email: user.email,
        });
        setResendAt(Date.now() + 60_000);
        toast.success("Confirmation email queued");
      }}
    />
  );
}
