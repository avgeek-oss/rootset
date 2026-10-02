import { IdSchema } from "@rootset/contracts";
import {
  proxyHeaders,
  proxyRefusal,
  proxyRequestGuard,
} from "../../../../../lib/proxy-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const maximumUploadBytes = 128 * 1024 * 1024;

export async function PUT(
  request: Request,
  context: { params: Promise<{ orgId: string; id: string }> },
) {
  const { orgId, id } = await context.params;
  if (!IdSchema.safeParse(orgId).success || !IdSchema.safeParse(id).success)
    return proxyRefusal(400, "VALIDATION_FAILED", "Invalid upload identifier.");
  const invalid = proxyRequestGuard(request, maximumUploadBytes);
  if (invalid) return invalid;
  const headers = new Headers();
  const incoming = proxyHeaders(request.headers);
  for (const name of [
    "cookie",
    "authorization",
    "origin",
    "content-type",
    "content-length",
    "idempotency-key",
    "x-rootset-organisation-id",
  ])
    if (incoming.has(name)) headers.set(name, incoming.get(name)!);
  const destination = new URL(
    `/v1/orgs/${orgId}/artifacts/${id}/upload`,
    process.env.ROOTSET_API_INTERNAL_URL ?? "http://127.0.0.1:4310",
  );
  try {
    const upstream = await fetch(destination, {
      method: "PUT",
      headers,
      body: request.body,
      signal: request.signal,
      redirect: "manual",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const responseHeaders = new Headers();
    const outgoing = proxyHeaders(upstream.headers, true);
    for (const name of [
      "content-type",
      "content-length",
      "cache-control",
      "retry-after",
      "x-request-id",
    ])
      if (outgoing.has(name)) responseHeaders.set(name, outgoing.get(name)!);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return proxyRefusal(
      502,
      "DEPENDENCY_UNAVAILABLE",
      "The import upload service could not be reached. Retry the prepared upload.",
    );
  }
}
