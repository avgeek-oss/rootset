"use client";

import { useEffect, useRef } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ApiError } from "@rootset/web-client";
import { RefreshCw } from "./ui/icons";

export function auditErrorDescription(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
        return "Sign in again, then retry.";
      case "FORBIDDEN":
        return "Your access may have changed. Reload the page and try again.";
      case "REQUEST_TIMEOUT":
        return "The request timed out. Try again.";
      case "OFFLINE":
        return "Check your connection and try again.";
      case "VALIDATION_FAILED":
      case "INVALID_RESPONSE":
        return "Reload the page and try again.";
    }
  }
  return "Try again. If the problem continues, reload the page.";
}

export function showAuditError(error: unknown, message: string) {
  const description = auditErrorDescription(error);
  const active = toast
    .getQueue()
    .visibleToasts.find(
      (item) =>
        item.content.variant === "danger" && item.content.title === message,
    );
  return active
    ? toast.update(active.key, message, { description, variant: "danger" })
    : toast.danger(message, { description });
}

export function AuditLogError({
  error,
  message,
  onRetry,
}: {
  error: unknown;
  message: string;
  onRetry: () => void;
}) {
  const notified = useRef<unknown>(null);
  useEffect(() => {
    if (notified.current === error) return;
    notified.current = error;
    showAuditError(error, message);
  }, [error, message]);
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
      <p
        role="alert"
        className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]"
      >
        {message}
      </p>
      <Button slot={null} variant="secondary" onPress={onRetry}>
        <RefreshCw />
        Retry
      </Button>
    </div>
  );
}
