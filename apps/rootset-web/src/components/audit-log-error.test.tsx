import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ApiError } from "@rootset/web-client";
import {
  AuditLogError,
  auditErrorDescription,
  showAuditError,
} from "./audit-log-error";

const queue = vi.hoisted(() => ({
  visibleToasts: [] as {
    key: string;
    content: { title: string; variant: string };
  }[],
}));
vi.mock("@avgeek-oss/design-system/overlays/toast", () => ({
  toast: {
    getQueue: () => queue,
    danger: vi.fn((title: string) => {
      queue.visibleToasts.push({
        key: "audit-error",
        content: { title, variant: "danger" },
      });
      return "audit-error";
    }),
    update: vi.fn(),
  },
}));
beforeEach(() => {
  queue.visibleToasts = [];
  vi.clearAllMocks();
});

describe("audit error feedback", () => {
  it("updates the existing toast when the same read fails again", () => {
    const message = "Audit logs could not be loaded.";
    showAuditError(new Error("first failure"), message);
    showAuditError(new Error("second failure"), message);
    expect(toast.danger).toHaveBeenCalledOnce();
    expect(toast.update).toHaveBeenCalledWith("audit-error", message, {
      description: "Try again. If the problem continues, reload the page.",
      variant: "danger",
    });
  });
  it("keeps arbitrarily long diagnostics out of the inline error and toast description", () => {
    const error = new Error(
      JSON.stringify({
        code: "invalid_value",
        values: ["private-diagnostic".repeat(1000)],
      }),
    );
    const html = renderToStaticMarkup(
      createElement(AuditLogError, {
        error,
        message: "Audit logs could not be loaded.",
        onRetry() {},
      }),
    );
    expect(html).toContain("Audit logs could not be loaded.");
    expect(html).toContain("Retry");
    expect(html).toContain("min-w-0 max-w-full");
    expect(html).not.toContain("invalid_value");
    expect(html).not.toContain("private-diagnostic");
    expect(auditErrorDescription(error)).toBe(
      "Try again. If the problem continues, reload the page.",
    );
  });
  it.each([
    ["UNAUTHENTICATED", "Sign in again, then retry."],
    [
      "FORBIDDEN",
      "Your access may have changed. Reload the page and try again.",
    ],
    ["REQUEST_TIMEOUT", "The request timed out. Try again."],
    ["OFFLINE", "Check your connection and try again."],
    ["INVALID_RESPONSE", "Reload the page and try again."],
    ["VALIDATION_FAILED", "Reload the page and try again."],
  ])("gives concise recovery advice for %s", (code, description) => {
    expect(
      auditErrorDescription(
        new ApiError(400, { code, message: "raw-diagnostic" }),
      ),
    ).toBe(description);
  });
});
