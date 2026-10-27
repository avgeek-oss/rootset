import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, accountKeyRows, oauthPermissions, useApiQuery } from "./adapter";
import { performAction, read, write } from "../api";
import { usePageQuery } from "../../page-navigation";
vi.mock("../../page-navigation", () => ({
  usePageQuery: vi.fn(() => ({ data: null, error: null, refetch: vi.fn() })),
}));

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
  it("creates a personal key in the singleton installation with explicit permissions", async () => {
    vi.mocked(read).mockResolvedValue({
      organisation: { id: "installation" },
      principal: { role: "member" },
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
  it("creates and revokes workspace-owned keys through workspace operations", async () => {
    vi.mocked(read).mockResolvedValue({
      organisation: { id: "installation" },
      principal: { role: "admin" },
    });
    vi.mocked(performAction).mockResolvedValue({ secret: "team-token" });
    const input = {
      name: "Automation",
      access: "read",
      includeAdmin: false,
      expiresAt: null,
    };
    expect(
      await api.post("/v1/core/settings/api-keys/workspace", input, {
        "Idempotency-Key": "team-request",
      }),
    ).toEqual({ token: "team-token" });
    expect(performAction).toHaveBeenCalledWith(
      "createWorkspaceKey",
      { ...input, orgId: "installation" },
      { idempotencyKey: "team-request" },
    );
    await api.delete("/v1/core/settings/api-keys/workspace/key");
    expect(write).toHaveBeenCalledWith(
      "/orgs/installation/workspace-keys/key",
      "DELETE",
    );
  });
  it("revokes a connection through its connection endpoint", async () => {
    vi.mocked(read).mockResolvedValue([{ id: "grant" }]);
    await api.delete("/v1/core/settings/api-keys/personal/grant");
    expect(write).toHaveBeenCalledWith("/me/connections/grant", "DELETE");
    vi.mocked(read).mockResolvedValue([]);
    await api.delete("/v1/core/settings/api-keys/personal/key");
    expect(write).toHaveBeenLastCalledWith("/me/keys/key", "DELETE");
  });
  it("removes authenticator enrollment and code verification bindings", async () => {
    await expect(
      api.post("/v1/core/profile/two-factor/setup", {}),
    ).rejects.toThrow("Unsupported account request");
    expect(performAction).not.toHaveBeenCalled();
  });
  it("shows stored personal-key permissions and intersects OAuth consent with the live role", () => {
    const personal = [
      {
        id: "key",
        name: "Script",
        access: "read" as const,
        includeAdmin: false,
      },
    ];
    expect(accountKeyRows(personal, [], "viewer")[0]).toMatchObject({
      access: "read",
      includeAdmin: false,
    });
    expect(accountKeyRows(personal, [], "admin")[0]).toMatchObject({
      access: "read",
      includeAdmin: false,
    });
    expect(oauthPermissions("admin", ["rows:read"])).toMatchObject({
      access: "read",
      includeAdmin: false,
    });
    expect(oauthPermissions("admin", ["rows:write"])).toMatchObject({
      access: "edit",
      includeAdmin: false,
    });
    expect(oauthPermissions("member", ["schema:manage"])).toMatchObject({
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

it("separates workspace API-key caches and pins the read to the requested workspace", async () => {
  let active = "workspace-a";
  vi.stubGlobal("window", {
    sessionStorage: { getItem: () => active },
    __ROOTSET_API_ORIGIN: "http://rootset.test",
  });
  try {
    vi.mocked(read)
      .mockResolvedValueOnce({ organisation: { id: "org" } })
      .mockResolvedValueOnce([]);
    useApiQuery("/v1/core/settings/api-keys/workspace");
    const first = vi.mocked(usePageQuery).mock.calls.at(-1)![0];
    expect(first.queryKey).toEqual([
      "account-settings",
      "/v1/core/settings/api-keys/workspace",
      "workspace-a",
    ]);
    active = "workspace-b";
    useApiQuery("/v1/core/settings/api-keys/workspace");
    const second = vi.mocked(usePageQuery).mock.calls.at(-1)![0];
    expect(second.queryKey).toEqual([
      "account-settings",
      "/v1/core/settings/api-keys/workspace",
      "workspace-b",
    ]);
    await (first.queryFn as () => Promise<unknown>)();
    expect(read).toHaveBeenCalledWith(
      "/orgs/org/workspace-keys?workspaceId=workspace-a",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
