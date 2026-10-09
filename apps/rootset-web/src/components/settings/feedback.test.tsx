import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { showSettingsError, useMutation } from "./api";

vi.mock("@avgeek-oss/design-system/overlays/toast", () => ({
  toast: { success: vi.fn(), danger: vi.fn() },
}));
beforeEach(() => vi.clearAllMocks());

function mutation(onChanged?: () => void) {
  let result: ReturnType<typeof useMutation>;
  function Probe() {
    result = useMutation(onChanged);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result!;
}

describe("settings feedback", () => {
  it("reports saves once through a toast and retains the result", async () => {
    const changed = vi.fn();
    const result = await mutation(changed).run(
      async () => ({ version: 2 }),
      "Saved.",
    );
    expect(result).toEqual({ ok: true, value: { version: 2 } });
    expect(toast.success).toHaveBeenCalledExactlyOnceWith("Saved.");
    expect(changed).toHaveBeenCalledOnce();
  });
  it("keeps schema previews quiet until the user applies a change", async () => {
    await mutation().run(async () => ({ valid: true }));
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("reports failures without triggering a saved callback", async () => {
    const changed = vi.fn();
    const result = await mutation(changed).run(async () => {
      throw new Error("The field already exists.");
    }, "Saved.");
    expect(result.ok).toBe(false);
    expect(toast.danger).toHaveBeenCalledWith(
      "The field already exists.",
      expect.any(Object),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("keeps retry and the request reference available on a persistent toast", () => {
    const retry = vi.fn();
    showSettingsError(
      {
        code: "REQUEST_FAILED",
        message: "Could not load fields.",
        requestId: "request-1",
      },
      retry,
    );
    expect(toast.danger).toHaveBeenCalledWith("Could not load fields.", {
      description: "Reference: request-1",
      timeout: 0,
      actionProps: { children: "Try again", onPress: retry },
    });
  });
});
