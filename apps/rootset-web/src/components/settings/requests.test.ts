import { describe, expect, it } from "vitest";
import { resolveSettingsOperation } from "./requests";

const orgId = "01K6DVWSFS9MR156YW1H5XZ440";
const databaseId = "01K6DVWSFS9MR156YW1H5XZ441";
const tableId = "01K6DVWSFS9MR156YW1H5XZ442";
const memberId = "01K6DVWSFS9MR156YW1H5XZ443";
const table = `/orgs/${orgId}/databases/${databaseId}/tables/${tableId}`;

describe("Settings transport contract", () => {
  it("binds resources from the full path instead of trusting a body target", () => {
    expect(
      resolveSettingsOperation(`${table}/fields`, "POST", {
        orgId: memberId,
        workspaceId: orgId,
        expectedSchemaVersion: 1,
        field: {
          name: "AIRLINE_ID",
          type: "text",
          charLimit: 8,
        },
      }),
    ).toEqual({
      operationId: "createField",
      input: {
        orgId,
        workspaceId: orgId,
        databaseId,
        tableId,
        expectedSchemaVersion: 1,
        field: {
          name: "AIRLINE_ID",
          type: "text",
          charLimit: 8,
        },
      },
    });
  });
  it("requires membership revision on update and removal", () => {
    const path = `/orgs/${orgId}/members/${memberId}`;
    expect(() =>
      resolveSettingsOperation(path, "PATCH", { role: "viewer" }),
    ).toThrow();
    expect(() => resolveSettingsOperation(path, "DELETE")).toThrow();
    expect(
      resolveSettingsOperation(path, "PATCH", {
        role: "viewer",
        expectedVersion: "9007199254740992",
      })?.input.expectedVersion,
    ).toBe("9007199254740992");
  });
  it("rejects field coercion, excess properties and unsupported constraints before sending", () => {
    expect(() =>
      resolveSettingsOperation(`${table}/fields`, "POST", {
        workspaceId: orgId,
        expectedSchemaVersion: 1,
        field: { name: "ACTIVE", type: "boolean", min: 0 },
      }),
    ).toThrow();
    expect(() =>
      resolveSettingsOperation(`${table}/fields`, "POST", {
        workspaceId: orgId,
        expectedSchemaVersion: 1,
        field: { name: "CODE", type: "text", charLimit: "12" },
      }),
    ).toThrow();
    expect(() =>
      resolveSettingsOperation(table, "PATCH", {
        name: "Airlines",
        unexpected: true,
      }),
    ).toThrow();
  });
  it("rejects removed key controls and preserves explicit null expiry", () => {
    expect(() =>
      resolveSettingsOperation("/me/keys", "POST", {
        orgId,
        name: "Integration",
        scopes: ["viewer"],
        targets: [{ databaseId }],
      }),
    ).toThrow();
    expect(
      resolveSettingsOperation("/me/keys", "POST", {
        orgId,
        name: "Integration",
        access: "read",
        includeAdmin: false,
        expiresAt: null,
      })?.input.expiresAt,
    ).toBeNull();
  });
  it("does not expose removed account-action operations", () => {
    expect(resolveSettingsOperation("/me/actions", "POST", {})).toBeUndefined();
    expect(
      resolveSettingsOperation(`/me/actions/${memberId}`, "GET"),
    ).toBeUndefined();
    expect(
      resolveSettingsOperation(`/me/actions/${memberId}/complete`, "POST", {}),
    ).toBeUndefined();
  });
});
