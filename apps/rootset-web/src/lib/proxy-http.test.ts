import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ErrorEnvelopeSchema, limits } from "@rootset/contracts";
import { POST } from "../app/api/backend/[[...path]]/route";
import { proxyHeaders, proxyRefusal, proxyRequestGuard } from "./proxy-http";

describe("streaming backend proxy boundaries", () => {
  it("removes Connection-nominated headers in both directions without discarding session authority", () => {
    const source = new Headers({
      Connection: "X-Private-Hop",
      "Proxy-Connection": "X-Proxy-Hop",
      "X-Private-Hop": "private",
      "X-Proxy-Hop": "private",
      Expect: "100-continue",
      Cookie: "session=fixture",
      Origin: "https://rootset.test",
      Authorization: "Bearer fixture",
      "X-Forwarded-Host": "evil.test",
    });
    for (const response of [false, true]) {
      const cleaned = proxyHeaders(source, response);
      for (const key of [
        "Connection",
        "Proxy-Connection",
        "X-Private-Hop",
        "X-Proxy-Hop",
        "Expect",
        "X-Forwarded-Host",
      ])
        expect(cleaned.has(key)).toBe(false);
      expect(cleaned.get("Cookie")).toBe("session=fixture");
      expect(cleaned.get("Origin")).toBe("https://rootset.test");
      expect(cleaned.get("Authorization")).toBe("Bearer fixture");
    }
    const cookies = new Headers();
    cookies.append("Set-Cookie", "one=fixture; Path=/");
    cookies.append("Set-Cookie", "two=fixture; Path=/");
    expect(proxyHeaders(cookies, true).getSetCookie()).toHaveLength(2);
    cookies.set("Connection", "Set-Cookie");
    expect(proxyHeaders(cookies, true).getSetCookie()).toHaveLength(0);
  });
  it("emits strict error envelopes and bounds forwarded headers and decimal content lengths", async () => {
    const refusal = proxyRefusal(413, "PAYLOAD_TOO_LARGE", "Too large.");
    const body = ErrorEnvelopeSchema.parse(await refusal.json());
    expect(body.error.requestId).toBe(refusal.headers.get("X-Request-Id"));
    expect(
      proxyRequestGuard(
        new Request("http://localhost/v1/me", {
          headers: { "X-Big": "x".repeat(192 * 1024) },
        }),
      )?.status,
    ).toBe(431);
    expect(
      proxyRequestGuard(
        new Request("http://localhost/v1/me", {
          headers: { "Content-Length": "9".repeat(10000) },
        }),
      )?.status,
    ).toBe(400);
    expect(
      proxyRequestGuard(
        new Request("http://localhost/v1/me", {
          headers: { "Content-Length": String(9 * 1024 * 1024) },
        }),
      )?.status,
    ).toBe(413);
  });
  it("retains the input deadline after early upstream rejection while a request body is stalled", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_, options) => {
        void (options!.body as ReadableStream).getReader().read();
        return new Response("unauthorized", { status: 401 });
      });
    try {
      const request = new NextRequest("http://localhost/api/backend/v1/me", {
        method: "POST",
        body: input,
      });
      const response = await POST(request, {
        params: Promise.resolve({ path: ["v1", "me"] }),
      });
      expect(response.status).toBe(401);
      await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs + 1);
      expect(cancelled).toBe(true);
    } finally {
      fetcher.mockRestore();
      vi.useRealTimers();
    }
  });
  it("keeps an SSE response readable beyond the input deadline after input is complete", async () => {
    vi.useFakeTimers();
    let responseController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        responseController = controller;
      },
    });
    let upstreamSignal: AbortSignal;
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_, options) => {
        upstreamSignal = options!.signal!;
        expect(await new Response(options!.body).text()).toBe(
          '{"method":"initialize"}',
        );
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      });
    try {
      const response = await POST(
        new NextRequest("http://localhost/api/backend/mcp", {
          method: "POST",
          body: '{"method":"initialize"}',
        }),
        { params: Promise.resolve({ path: ["mcp"] }) },
      );
      await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs + 1000);
      expect(upstreamSignal!.aborted).toBe(false);
      responseController!.enqueue(new TextEncoder().encode("data: alive\n\n"));
      responseController!.close();
      expect(await response.text()).toBe("data: alive\n\n");
    } finally {
      fetcher.mockRestore();
      vi.useRealTimers();
    }
  });
});
