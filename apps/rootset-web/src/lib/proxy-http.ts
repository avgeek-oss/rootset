import { errorEnvelope, limits, newId, RootsetError } from "@rootset/contracts";

const HEADER_BUDGET = 192 * 1024;
const HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "expect",
]);

export function proxyRefusal(status: number, code: string, message: string) {
  const requestId = newId();
  return Response.json(
    errorEnvelope(new RootsetError(code, message, status), requestId),
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    },
  );
}

export function proxyHeaders(source: Headers, response = false): Headers {
  const excluded = new Set(HOP_HEADERS);
  for (const name of source.get("connection")?.split(",") ?? [])
    excluded.add(name.trim().toLowerCase());
  for (const name of source.get("proxy-connection")?.split(",") ?? [])
    excluded.add(name.trim().toLowerCase());
  const result = new Headers();
  for (const [name, value] of source)
    if (
      !excluded.has(name.toLowerCase()) &&
      name.toLowerCase() !== "set-cookie"
    )
      result.set(name, value);
  if (response && !excluded.has("set-cookie"))
    for (const cookie of source.getSetCookie())
      result.append("set-cookie", cookie);
  return result;
}

export function proxyRequestGuard(
  request: Request,
  maximumBytes = limits.requestBytes,
): Response | undefined {
  const encoder = new TextEncoder();
  const url = new URL(request.url);
  let headerBytes =
    encoder.encode(
      `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n`,
    ).byteLength + 2;
  if (headerBytes > HEADER_BUDGET)
    return proxyRefusal(
      431,
      "PAYLOAD_TOO_LARGE",
      "The request line and headers must be 192 KiB or less.",
    );
  for (const [name, value] of request.headers) {
    headerBytes += encoder.encode(`${name}: ${value}\r\n`).byteLength;
    if (headerBytes > HEADER_BUDGET)
      return proxyRefusal(
        431,
        "PAYLOAD_TOO_LARGE",
        "The request line and headers must be 192 KiB or less.",
      );
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,9}$/.test(declared))
      return proxyRefusal(
        400,
        "VALIDATION_FAILED",
        "Content-Length must be a bounded decimal byte count.",
      );
    if (Number(declared) > maximumBytes)
      return proxyRefusal(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request bodies must be ${maximumBytes / 1024 / 1024} MiB or less.`,
      );
  }
}
