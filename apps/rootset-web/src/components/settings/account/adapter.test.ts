import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, accountKeyRows, oauthPermissions } from "./adapter";
import { performAction, read, write } from "../api";
import { authClient } from "../../../lib/auth-client";

vi.mock("../api", () => ({
  performAction: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  describeError: (error: unknown) => ({
    message: error instanceof Error ? error.message : "Failed",
  }),
}));
vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    twoFactor: { enable: vi.fn(), disable: vi.fn(), verifyTotp: vi.fn() },
    passkey: {
      addPasskey: vi.fn(),
      deletePasskey: vi.fn(),
      updatePasskey: vi.fn(),
    },
  },
}));
beforeEach(() => vi.resetAllMocks());

describe("account component bindings", () => {
  it("maps Towbar profile fields to the existing Rootset profile operation", async () => {
    await api.patch("/v1/core/profile", { displayName: "Example Person" });
    expect(write).toHaveBeenCalledWith("/me/profile", "PATCH", {
      name: "Example Person",
    });
  });
  it("creates a personal key in the singleton installation without permission selectors", async () => {
    vi.mocked(read).mockResolvedValue({
      organisation: { id: "installation" },
      principal: { role: "editor" },
    });
    vi.mocked(performAction).mockResolvedValue({ secret: "one-time-key" });
    const input = { name: "Script", expiresAt: "2027-01-01T00:00:00.000Z" };
    const result = await api.post(
      "/v1/core/settings/api-keys/personal",
      input,
      { "Idempotency-Key": "stable-request" },
    );
    expect(performAction).toHaveBeenCalledWith(
      "createPersonalKey",
      { ...input, orgId: "installation" },
      { idempotencyKey: "stable-request" },
    );
    expect(result).toEqual({ token: "one-time-key" });
    vi.mocked(performAction).mockResolvedValue({
      replayed: true,
      key: { id: "existing" },
    });
    expect(
      await api.post("/v1/core/settings/api-keys/personal", input),
    ).toEqual({ token: null });
  });
  it("revokes a connection through its connection endpoint", async () => {
    vi.mocked(read).mockResolvedValue([{ id: "grant" }]);
    await api.delete("/v1/core/settings/api-keys/personal/grant");
    expect(write).toHaveBeenCalledWith("/me/connections/grant", "DELETE");
    vi.mocked(read).mockResolvedValue([]);
    await api.delete("/v1/core/settings/api-keys/personal/key");
    expect(write).toHaveBeenLastCalledWith("/me/keys/key", "DELETE");
  });
  it("keeps authenticator enrollment bound to its approval without exposing password or recovery codes", async () => {
    vi.mocked(performAction).mockResolvedValue({
      actionId: "bound-action",
      password: "ephemeral-password",
    });
    vi.mocked(authClient.twoFactor.enable).mockResolvedValue({
      data: {
        method: "totp",
        totpURI: "otpauth://totp/Rootset?secret=SECRET",
        backupCodes: ["hidden-recovery-code"],
      },
      error: null,
    });
    const result = await api.post("/v1/core/profile/two-factor/setup", {});
    expect(performAction).toHaveBeenCalledWith(
      "enableTwoFactor",
      {},
      { requirePassword: true },
    );
    expect(authClient.twoFactor.enable).toHaveBeenCalledWith({
      password: "ephemeral-password",
      fetchOptions: { headers: { "X-Rootset-Action-ID": "bound-action" } },
    });
    expect(result).toEqual({
      totpURI: "otpauth://totp/Rootset?secret=SECRET",
      actionId: "bound-action",
    });
    vi.mocked(authClient.twoFactor.verifyTotp).mockResolvedValue({
      data: { token: "session", user: {} } as never,
      error: null,
    });
    await api.post("/v1/public/auth/identity/two-factor/verify-totp", {
      code: "123456",
      actionId: "bound-action",
    });
    expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({
      code: "123456",
      fetchOptions: { headers: { "X-Rootset-Action-ID": "bound-action" } },
    });
  });
  it("shows inherited personal-key roles and intersects OAuth consent with the live role", () => {
    const personal = [{ id: "key", name: "Script" }];
    expect(accountKeyRows(personal, [], "viewer")[0]).toMatchObject({
      access: "read",
      includeAdmin: false,
    });
    expect(accountKeyRows(personal, [], "admin")[0]).toMatchObject({
      access: "edit",
      includeAdmin: true,
    });
    expect(oauthPermissions("admin", ["rows:read"])).toMatchObject({
      access: "read",
      includeAdmin: false,
    });
    expect(oauthPermissions("admin", ["rows:write"])).toMatchObject({
      access: "edit",
      includeAdmin: false,
    });
    expect(
      oauthPermissions("viewer", ["rows:write", "schema:manage"]),
    ).toMatchObject({ access: "read", includeAdmin: false });
    expect(oauthPermissions("admin", ["schema:manage"])).toMatchObject({
      access: "edit",
      includeAdmin: true,
      permissionMode: "scoped-admin",
    });
  });
});
