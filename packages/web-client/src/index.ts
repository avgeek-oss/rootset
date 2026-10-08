import { getOperation, IdSchema } from "@rootset/contracts";

declare global {
  interface Window {
    __ROOTSET_API_ORIGIN?: string;
  }
}

export function browserApiOrigin(): string {
  if (typeof window === "undefined") return "";
  const origin = window.__ROOTSET_API_ORIGIN;
  if (!origin) throw new Error("The public API origin is not configured.");
  return origin;
}

export function browserArtifactDownloadPath(
  orgId: string,
  artifactId: string,
): string {
  return `${browserApiOrigin()}/api/internal/v1/orgs/${IdSchema.parse(orgId)}/artifacts/${IdSchema.parse(artifactId)}/download`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export interface ApiErrorDetails {
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiErrorDetails,
  ) {
    super(error.message);
    this.name = "ApiError";
  }
  get code() {
    return this.error.code;
  }
  get details() {
    return this.error.details;
  }
  get requestId() {
    return this.error.requestId;
  }
}

export class RootsetClient {
  private readonly baseUrl: string | (() => string);
  private readonly fetcher: typeof fetch;

  constructor(
    options: { baseUrl?: string | (() => string); fetch?: typeof fetch } = {},
  ) {
    this.baseUrl =
      options.baseUrl ?? (() => `${browserApiOrigin()}/api/internal/v1`);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async operation<T>(
    operationId: string,
    input: Record<string, unknown>,
    options: Omit<RequestOptions, "method" | "body"> = {},
  ): Promise<T> {
    const operation = getOperation(operationId);
    const parsed = operation.inputSchema.parse(input) as Record<
      string,
      unknown
    >;
    const body = { ...parsed };
    const path = operation.path
      .replace(/^\/v1/, "")
      .replace(/\{([^}]+)\}/g, (_, name: string) => {
        const value = parsed[name];
        if (typeof value !== "string")
          throw new Error(`Missing ${name} for ${operationId}`);
        delete body[name];
        return encodeURIComponent(value);
      });
    let target = path;
    const headers = new Headers(options.headers);
    if (operationId === "deleteRow") {
      headers.set(
        "If-Match",
        `"${String(parsed.rowId)}:${String(parsed.expectedVersion)}"`,
      );
      delete body.expectedVersion;
    }
    if (operation.httpMethod === "GET") {
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(body)) {
        if (value !== undefined && value !== null)
          search.set(
            name,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
      }
      if (search.size) target += `?${search}`;
    }
    const result = await this.request<unknown>(target, {
      ...options,
      method: operation.httpMethod,
      headers,
      ...(operation.httpMethod !== "GET" ? { body } : {}),
    });
    return operation.outputSchema.parse(result) as T;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Rootset API paths must begin with a single slash");
    }
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    const method = options.method ?? "GET";
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (options.idempotencyKey)
      headers.set("Idempotency-Key", options.idempotencyKey);
    else if (
      method !== "GET" &&
      !path.endsWith("/query") &&
      !path.endsWith("/preview")
    ) {
      headers.set("Idempotency-Key", crypto.randomUUID());
    }
    let response: Response;
    try {
      const baseUrl =
        typeof this.baseUrl === "function" ? this.baseUrl() : this.baseUrl;
      response = await this.fetcher(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        credentials: "include",
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(0, {
        code: "OFFLINE",
        message:
          "Rootset could not be reached. Check your connection and retry; your draft is still here.",
      });
    }
    if (response.status === 204) return undefined as T;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, {
        code: "INVALID_RESPONSE",
        message:
          "Rootset returned an unreadable response. Retry or contact your administrator.",
        requestId: response.headers.get("X-Request-ID") ?? undefined,
      });
    }
    if (!response.ok) {
      const envelope = payload as {
        error?: ApiErrorDetails | string;
        error_description?: string;
      };
      throw new ApiError(
        response.status,
        typeof envelope.error === "string"
          ? {
              code: envelope.error,
              message:
                envelope.error_description ??
                "The authorization request could not be completed",
            }
          : (envelope.error ?? {
              code: "REQUEST_FAILED",
              message: `The request failed (${response.status})`,
            }),
      );
    }
    return payload as T;
  }
}

export const client = new RootsetClient();

export function resourcePath(
  orgId: string,
  databaseId?: string,
  tableId?: string,
): string {
  let path = `/orgs/${encodeURIComponent(orgId)}`;
  if (databaseId) path += `/databases/${encodeURIComponent(databaseId)}`;
  if (tableId) {
    if (!databaseId) throw new Error("Table paths require a database");
    path += `/tables/${encodeURIComponent(tableId)}`;
  }
  return path;
}

export function unwrapData<T>(response: T | { data: T }): T {
  return response && typeof response === "object" && "data" in response
    ? (response as { data: T }).data
    : (response as T);
}
