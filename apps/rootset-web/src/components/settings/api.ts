"use client";

import { RootsetClient } from "@rootset/web-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveSettingsOperation } from "./requests";

const client = new RootsetClient({ baseUrl: "/api/internal/v1" });

export interface AccountActionTicket {
  id: string;
  operationId?: string;
  status?: string;
  state?: string;
  expiresAt: string;
  approvalUrl: string;
}
type ApprovalHandler = (ticket: AccountActionTicket) => Promise<unknown>;
let approvalHandler: ApprovalHandler | undefined;
let approvalOrganisation: string | undefined;
export function registerApprovalHandler(
  handler: ApprovalHandler,
  orgId: string,
) {
  approvalHandler = handler;
  approvalOrganisation = orgId;
  return () => {
    if (approvalHandler === handler) {
      approvalHandler = undefined;
      approvalOrganisation = undefined;
    }
  };
}

export async function performAction<T = unknown>(
  operationId: string,
  input: Record<string, unknown>,
): Promise<T> {
  const actionTypes: Record<string, string> = {
    changePassword: "change_password",
    changeEmail: "change_email",
    registerPasskey: "register_passkey",
    removePasskey: "remove_passkey",
    enableTwoFactor: "enable_totp",
    disableTwoFactor: "disable_totp",
    rotateRecoveryCodes: "rotate_recovery_codes",
    deleteAccount: "delete_account",
    signOutEverywhere: "sign_out_everywhere",
    transferOwnership: "transfer_ownership",
    createPersonalKey: "create_key",
    createTeamKey: "create_key",
    rotatePersonalKey: "rotate_key",
    rotateTeamKey: "rotate_key",
    setBackupPolicy: "set_backup_policy",
    restoreBackup: "restore_backup",
    deleteOrganisation: "delete_organisation",
    deleteDatabase: "delete_database",
    deleteTable: "delete_table",
    updateInstallationConfiguration: "update_installation_configuration",
    testEmail: "test_email",
    setHistoryRetentionPolicy: "set_history_retention_policy",
    archiveHistory: "archive_history",
  };
  const ticket = await write<AccountActionTicket>("/me/actions", "POST", {
    type: actionTypes[operationId],
    operationId,
    input,
    orgId: typeof input.orgId === "string" ? input.orgId : approvalOrganisation,
  });
  if (!approvalHandler)
    throw new Error("Open settings to approve this account action.");
  return (await approvalHandler(ticket)) as T;
}

export interface SettingsError {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export function describeError(error: unknown): SettingsError {
  if (typeof error === "object" && error !== null) {
    const source = error as Record<string, unknown>;
    const detail =
      typeof source.error === "object" && source.error !== null
        ? (source.error as Record<string, unknown>)
        : source;
    return {
      code: typeof detail.code === "string" ? detail.code : "REQUEST_FAILED",
      message:
        typeof detail.message === "string"
          ? detail.message
          : "The request failed. Try again.",
      requestId:
        typeof detail.requestId === "string" ? detail.requestId : undefined,
      details:
        typeof detail.details === "object" && detail.details !== null
          ? (detail.details as Record<string, unknown>)
          : undefined,
    };
  }
  return {
    code: "REQUEST_FAILED",
    message:
      error instanceof Error ? error.message : "The request failed. Try again.",
  };
}

export function unwrapData<T>(value: T | { data: T }): T {
  return typeof value === "object" && value !== null && "data" in value
    ? (value as { data: T }).data
    : (value as T);
}

export async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const operation = resolveSettingsOperation(path, "GET");
  return unwrapData(
    operation
      ? await client.operation<T | { data: T }>(
          operation.operationId,
          operation.input,
          { signal },
        )
      : await client.request<T | { data: T }>(path, { signal }),
  );
}

export async function write<T = unknown>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  return unwrapData(
    await writeRaw<T | { data: T }>(path, method, body, extraHeaders),
  );
}

export function writeRaw<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const operation = resolveSettingsOperation(path, method, body);
  const options = {
    method,
    body,
    headers: { "Idempotency-Key": crypto.randomUUID(), ...extraHeaders },
  };
  return operation
    ? client.operation<T>(operation.operationId, operation.input, {
        headers: options.headers,
      })
    : client.request<T>(path, options);
}

export function useResource<T>(path: string | undefined, initial: T) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<SettingsError>();
  const [revision, setRevision] = useState(0);
  const previousPath = useRef(path);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (previousPath.current !== path) {
      setData(initial);
      previousPath.current = path;
    }
    if (!path) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(undefined);
    read<T>(path, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setData(value);
        setLoading(false);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) {
          setError(describeError(reason));
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [path, revision]);
  return { data, loading, error, reload };
}

export type MutationResult<T> =
  { ok: true; value: T } | { ok: false; error: SettingsError };
export function useMutation(onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SettingsError>();
  const [message, setMessage] = useState<string>();
  const run = async <T>(
    action: () => Promise<T>,
    success: string,
  ): Promise<MutationResult<T>> => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const value = await action();
      setMessage(success);
      onChanged?.();
      return { ok: true, value };
    } catch (reason) {
      const detail = describeError(reason);
      setError(detail);
      return { ok: false, error: detail };
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    message,
    run,
    clear: () => {
      setError(undefined);
      setMessage(undefined);
    },
  };
}

export function organisationPath(orgId: string) {
  return `/orgs/${encodeURIComponent(orgId)}`;
}
export function databasePath(orgId: string, databaseId: string) {
  return `${organisationPath(orgId)}/databases/${encodeURIComponent(databaseId)}`;
}
export function tablePath(orgId: string, databaseId: string, tableId: string) {
  return `${databasePath(orgId, databaseId)}/tables/${encodeURIComponent(tableId)}`;
}
