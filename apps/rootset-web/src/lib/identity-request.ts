"use client";
import { describeError } from "../components/settings/api";
import {
  browserApiOrigin,
  fetchWithBackendRecovery,
} from "@rootset/web-client";
export async function identityRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchWithBackendRecovery(
    `${browserApiOrigin()}/v1/auth${path}`,
    {
      method,
      signal,
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = describeError(result);
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  return result as T;
}
