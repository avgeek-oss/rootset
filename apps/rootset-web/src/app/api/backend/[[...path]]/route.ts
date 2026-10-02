import type { NextRequest } from "next/server";
import { limits } from "@rootset/contracts";
import {
  proxyHeaders,
  proxyRefusal as refused,
  proxyRequestGuard,
} from "../../../../lib/proxy-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await context.params;
  if (
    path.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[/\\\u0000]/.test(segment),
    )
  )
    return refused(404, "RESOURCE_NOT_FOUND", "Resource unavailable.");
  const allowed =
    path[0] === "v1" ||
    (path[0] === "api" && path[1] === "internal") ||
    (path[0] === "oauth" &&
      path.length === 2 &&
      ["authorize", "token", "revoke", "register"].includes(path[1]!)) ||
    (path[0] === "mcp" && path.length === 1) ||
    path[0] === ".well-known";
  if (!allowed)
    return refused(404, "RESOURCE_NOT_FOUND", "Resource unavailable.");
  const invalid = proxyRequestGuard(request);
  if (invalid) return invalid;
  const upstream = new URL(
    process.env.ROOTSET_API_INTERNAL_URL ?? "http://127.0.0.1:4310",
  );
  upstream.pathname = `/${path.map((segment) => encodeURIComponent(segment)).join("/")}`;
  upstream.search = request.nextUrl.search;
  const headers = proxyHeaders(request.headers);
  headers.set("accept-encoding", "identity");
  let bytes = 0,
    overflowed = false,
    timedOut = false,
    inputComplete = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body =
    request.body && !["GET", "HEAD"].includes(request.method)
      ? request.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, output) {
              bytes += chunk.byteLength;
              if (bytes > limits.requestBytes) {
                overflowed = true;
                throw new Error("Request body exceeded its byte budget.");
              }
              output.enqueue(chunk);
            },
            flush() {
              inputComplete = true;
              if (timer) clearTimeout(timer);
            },
          }),
          { signal: controller.signal },
        )
      : undefined;
  if (body)
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.requestTimeoutMs);
  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, controller.signal]),
      ...(body ? { duplex: "half" as const } : {}),
    });
    const outgoing = proxyHeaders(response.headers, true);
    if (response.headers.has("content-encoding")) {
      outgoing.delete("content-encoding");
      outgoing.delete("content-length");
    }
    return new Response(response.body, {
      status: response.status,
      headers: outgoing,
    });
  } catch {
    if (overflowed)
      return refused(
        413,
        "PAYLOAD_TOO_LARGE",
        "Ordinary request bodies must be 8 MiB or less.",
      );
    if (timedOut)
      return refused(
        408,
        "REQUEST_TIMEOUT",
        "Request body was not received within 10 seconds.",
      );
    if (request.signal.aborted)
      return refused(499, "DEPENDENCY_UNAVAILABLE", "Request cancelled.");
    return refused(
      502,
      "DEPENDENCY_UNAVAILABLE",
      "The Rootset API is unavailable. Retry after the service recovers.",
    );
  } finally {
    if (
      timer &&
      (!body ||
        inputComplete ||
        overflowed ||
        timedOut ||
        request.signal.aborted)
    )
      clearTimeout(timer);
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
