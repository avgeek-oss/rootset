"use client";
import { describeError } from "../components/settings/api";
export async function identityRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  actionId?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/v1/auth${path}`, {
    method,
    signal,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(actionId ? { "X-Rootset-Action-ID": actionId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(describeError(result).message);
  return result as T;
}
