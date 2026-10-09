import { afterEach, describe, expect, it, vi } from "vitest";
import { RootsetClient } from "@rootset/web-client";
import { confirmIdentity, performAction, registerIdentityHandler } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("direct settings actions", () => {
  it("executes authorised actions without creating or approving a ticket", async () => {
    const operation = vi
      .spyOn(RootsetClient.prototype, "operation")
      .mockResolvedValue({ secret: "fixture" });
    const request = vi.spyOn(RootsetClient.prototype, "request");
    expect(
      await performAction(
        "createPersonalKey",
        { name: "Script" },
        { idempotencyKey: "stable-key" },
      ),
    ).toEqual({ secret: "fixture" });
    expect(operation).toHaveBeenCalledExactlyOnceWith(
      "createPersonalKey",
      { name: "Script" },
      { headers: { "Idempotency-Key": "stable-key" } },
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("retries only after successful identity confirmation and preserves the idempotency key", async () => {
    const operation = vi
      .spyOn(RootsetClient.prototype, "operation")
      .mockRejectedValueOnce({
        code: "STEP_UP_REQUIRED",
        message: "Confirm identity",
      })
      .mockResolvedValueOnce({ deleted: true });
    const proof = vi.fn(async () => undefined),
      unregister = registerIdentityHandler(proof);
    try {
      expect(
        await performAction("deleteDatabase", { databaseId: "fixture" }),
      ).toEqual({ deleted: true });
      expect(proof).toHaveBeenCalledOnce();
      expect(operation).toHaveBeenCalledTimes(2);
      expect(operation.mock.calls[0]![2]).toEqual(operation.mock.calls[1]![2]);
    } finally {
      unregister();
    }
  });
  it("does not resend a rejected action when confirmation is cancelled", async () => {
    const operation = vi
      .spyOn(RootsetClient.prototype, "operation")
      .mockRejectedValue({ code: "STEP_UP_REQUIRED" });
    const unregister = registerIdentityHandler(async () => {
      throw Object.assign(new Error("Cancelled"), { code: "ACTION_CANCELLED" });
    });
    try {
      await expect(performAction("deleteDatabase", {})).rejects.toMatchObject({
        code: "ACTION_CANCELLED",
      });
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
  it("lets database deletion request identity confirmation even for a recent session", async () => {
    const proof = vi.fn(async () => undefined),
      unregister = registerIdentityHandler(proof);
    try {
      await confirmIdentity();
      expect(proof).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
});
