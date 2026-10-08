"use client";

import { useQuery } from "@tanstack/react-query";
import { identityRequest } from "../../../lib/identity-request";
import { registerWebAuthnPasskey } from "../../../lib/passkeys";
import { authClient } from "../../../lib/auth-client";
import { describeError, performAction, read, write } from "../api";
import type {
  ApiKey,
  Connection,
  Profile,
  SecurityStatus,
  Session,
  Preferences,
} from "../types";
import { createDateTimeFormatter } from "@rootset/contracts";
import { browserApiOrigin } from "@rootset/web-client";

export type AccountUser = Profile & {
  name: string;
  twoFactorEnabled: boolean;
  workspaceRole: string;
};
export type AccountSession = Session & {
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string;
};
type Context = {
  organisation: { id: string } | null;
  principal: { role: string };
};
export type InteractiveProof = { actionId: string };

export function refreshApiQueries() {
  window.dispatchEvent(new Event("rootset:account-refresh"));
}

export { identityRequest } from "../../../lib/identity-request";

function check<T extends { error?: { message?: string } | null }>(
  result: T,
): T {
  if (result.error)
    throw new Error(
      result.error.message ?? "The authentication operation failed.",
    );
  return result;
}
export function proofHeaders(actionId: string) {
  return { headers: { "X-Rootset-Action-ID": actionId } };
}

export function keyPermissions(role: string) {
  return {
    access: role === "viewer" ? "read" : "edit",
    includeAdmin: role === "admin",
    permissionMode: role === "admin" ? "full-admin" : "standard",
  };
}

export function oauthPermissions(role: string, scopes: string[]) {
  const adminScopes = [
    "org:manage",
    "members:manage",
    "databases:manage",
    "tables:manage",
    "schema:manage",
    "backups:manage",
    "installation:manage",
  ];
  const administrative =
    role === "admin" && adminScopes.some((scope) => scopes.includes(scope));
  const edit =
    role !== "viewer" &&
    scopes.some((scope) => scope === "rows:write" || scope === "imports:write");
  return {
    access: administrative || edit ? "edit" : "read",
    includeAdmin: administrative,
    permissionMode:
      administrative && !adminScopes.every((scope) => scopes.includes(scope))
        ? "scoped-admin"
        : administrative
          ? "full-admin"
          : "standard",
  };
}

export function accountKeyRows(
  keys: ApiKey[],
  connections: Connection[],
  role: string,
) {
  const permissions = keyPermissions(role);
  return [
    ...keys.map((key) => ({
      ...key,
      ...permissions,
      tokenType: "api-key",
      scope: "personal",
    })),
    ...connections.map((connection) => ({
      ...connection,
      ...oauthPermissions(role, connection.scopes),
      name: connection.clientName,
      tokenType: "mcp-oauth",
      oauthClientName: connection.clientName,
      oauthClientId: connection.clientId,
      oauthClientTrust: "unverified",
      scope: "personal",
      lastUsedAt: null,
    })),
  ];
}

async function loadAccount(path: string): Promise<unknown> {
  switch (path) {
    case "/v1/core/profile": {
      const [user, security] = await Promise.all([
        read<Profile>("/me/profile"),
        read<SecurityStatus>("/me/security"),
      ]);
      return {
        user: {
          ...user,
          name: user.name ?? user.displayName ?? "",
          twoFactorEnabled: Boolean(security.twoFactorEnabled),
        },
      };
    }
    case "/v1/core/profile/email-change":
      return identityRequest("/email-change");
    case "/v1/core/profile/passkeys":
      return read("/me/security");
    case "/v1/core/sessions": {
      const sessions = await read<Session[]>("/me/sessions");
      return {
        currentSessionId: sessions.find((session) => session.current)?.id,
        sessions: sessions.map((session) => ({
          ...session,
          lastSeenAt: session.lastActivityAt,
        })),
      };
    }
    case "/v1/core/settings/api-keys/personal": {
      const [keys, connections, context] = await Promise.all([
        read<ApiKey[]>("/me/keys"),
        read<Connection[]>("/me/connections"),
        read<Context>("/context"),
      ]);
      return {
        keys: accountKeyRows(keys, connections, context.principal.role),
        apiUrl: `${browserApiOrigin()}/v1`,
        mcpUrl: `${browserApiOrigin()}/mcp`,
      };
    }
    default:
      return read(path);
  }
}

export function useApiQuery<T>(path: string | null) {
  const query = useQuery<T>({
    queryKey: ["account-settings", path],
    queryFn: async () => {
      try {
        return (await loadAccount(path!)) as T;
      } catch (error) {
        throw new Error(describeError(error).message);
      }
    },
    enabled: Boolean(path),
  });
  return {
    data: query.data,
    error: query.error?.message,
    refresh: () => void query.refetch(),
  };
}

export function useAccess() {
  const profile = useApiQuery<{ user: AccountUser }>("/v1/core/profile");
  const context = useApiQuery<Context>("/context");
  return {
    user: profile.data
      ? {
          ...profile.data.user,
          workspaceRole: context.data?.principal.role ?? "viewer",
        }
      : null,
  };
}

async function mutate(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  values: Record<string, unknown> = {},
  headers?: Record<string, string>,
): Promise<unknown> {
  try {
    if (path === "/v1/core/profile")
      return write("/me/profile", "PATCH", { name: values.displayName });
    if (path === "/v1/core/profile/password")
      return performAction("changePassword", {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
    if (path === "/v1/core/profile/email-change")
      return method === "DELETE"
        ? identityRequest("/email-change", "DELETE")
        : performAction("changeEmail", { newEmail: values.email });
    if (path === "/v1/core/profile/passkeys/recovery-codes") {
      const proof = await performAction<InteractiveProof>(
        "rotateRecoveryCodes",
        {},
      );
      return identityRequest(
        "/passkey/replace-recovery-codes",
        "POST",
        {},
        proof.actionId,
      );
    }
    if (path === "/v1/public/auth/identity/passkey/delete-passkey") {
      const proof = await performAction<InteractiveProof>("removePasskey", {
        id: values.id,
      });
      return check(
        await authClient.passkey.deletePasskey({
          id: String(values.id),
          fetchOptions: proofHeaders(proof.actionId),
        }),
      );
    }
    if (path === "/v1/public/auth/identity/passkey/update-passkey")
      return check(
        await authClient.passkey.updatePasskey({
          id: String(values.id),
          name: String(values.name),
        }),
      );
    if (path === "/v1/public/auth/identity/send-verification-email")
      return identityRequest("/send-verification-email", "POST", {
        email: values.email,
      });
    if (path.startsWith("/v1/core/sessions/"))
      return write(`/me/sessions/${path.split("/").at(-1)}`, "DELETE");
    if (path === "/v1/core/settings/api-keys/personal") {
      const context = await read<Context>("/context");
      const result = await performAction<{ secret?: string }>(
        "createPersonalKey",
        { ...values, orgId: context.organisation?.id },
        { idempotencyKey: headers?.["Idempotency-Key"] },
      );
      return { token: result.secret ?? null };
    }
    if (path.startsWith("/v1/core/settings/api-keys/personal/")) {
      const id = path.split("/").at(-1)!;
      const connections = await read<Connection[]>("/me/connections");
      return write(
        `/me/${connections.some((connection) => connection.id === id) ? "connections" : "keys"}/${id}`,
        "DELETE",
      );
    }
    throw new Error(`Unsupported account request: ${method} ${path}`);
  } catch (error) {
    throw new Error(describeError(error).message);
  }
}

export const api = {
  post: <T = unknown>(
    path: string,
    values: Record<string, unknown>,
    headers?: Record<string, string>,
  ) => mutate(path, "POST", values, headers) as Promise<T>,
  patch: <T = unknown>(path: string, values: Record<string, unknown>) =>
    mutate(path, "PATCH", values) as Promise<T>,
  put: <T = unknown>(path: string, values: Record<string, unknown>) =>
    mutate(path, "PUT", values) as Promise<T>,
  delete: <T = unknown>(path: string) => mutate(path, "DELETE") as Promise<T>,
};

export async function registerPasskey(name: string) {
  const proof = await performAction<InteractiveProof>("registerPasskey", {});
  return registerWebAuthnPasskey(name, proof.actionId);
}
export function passkeyError(error: unknown) {
  return describeError(error).message;
}

export function useDateDisplay() {
  const preferences = useApiQuery<Preferences>("/me/preferences").data;
  return (value?: string) => {
    if (!value) return "—";
    if (!preferences) return "—";
    return createDateTimeFormatter({
      ...preferences,
      timeZone: preferences.timezone,
    })(value).date;
  };
}
export function displayTimestamp(value: string, preferences: Preferences) {
  return createDateTimeFormatter({
    ...preferences,
    timeZone: preferences.timezone,
  })(value).dateTime!;
}
