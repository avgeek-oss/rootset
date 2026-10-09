import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  RootsetClient,
  resourcePath,
  browserArtifactDownloadPath,
  BACKEND_UNAVAILABLE_EVENT,
  fetchWithBackendRecovery,
} from "./index";

describe("browser transport", () => {
  it("builds API-hosted browser artifact downloads and rejects path substitution", () => {
    const orgId = "01K6DVWSFS9MR156YW1H5XZ440";
    const artifactId = "01K6DVWSFS9MR156YW1H5XZ441";
    expect(browserArtifactDownloadPath(orgId, artifactId)).toBe(
      `/api/internal/v1/orgs/${orgId}/artifacts/${artifactId}/download`,
    );
    expect(() =>
      browserArtifactDownloadPath("//other.test", artifactId),
    ).toThrow();
    expect(() => browserArtifactDownloadPath(orgId, "../another")).toThrow();
    vi.stubGlobal("window", {
      __ROOTSET_API_ORIGIN: "https://rootset-api.avgeek.ltd",
    });
    try {
      expect(browserArtifactDownloadPath(orgId, artifactId)).toBe(
        `https://rootset-api.avgeek.ltd/api/internal/v1/orgs/${orgId}/artifacts/${artifactId}/download`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("sends cookie requests and preserves query read classification", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    const transport = new RootsetClient({ fetch: fetcher });
    await transport.request("/orgs/ORG/databases/DB/tables/TABLE/query", {
      method: "POST",
      body: { limit: 200 },
    });
    const [, options] = fetcher.mock.calls[0]!;
    expect(options.credentials).toBe("include");
    expect(options.headers.has("Idempotency-Key")).toBe(false);
  });
  it("preserves typed conflict details", async () => {
    const transport = new RootsetClient({
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "ROW_VERSION_CONFLICT",
              message: "Row changed",
              details: { version: "2" },
            },
          }),
          { status: 409 },
        ),
      ),
    });
    await expect(
      transport.request("/rows/ROW", {
        method: "PATCH",
        body: { expectedVersion: "1" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "ROW_VERSION_CONFLICT",
      details: { version: "2" },
    });
  });
  it("does not swallow cancellation or leak fetch diagnostics", async () => {
    const transport = new RootsetClient({
      fetch: vi.fn().mockRejectedValue(new Error("Authorization: secret")),
    });
    await expect(transport.request("/me")).rejects.toBeInstanceOf(ApiError);
    await expect(transport.request("/me")).rejects.toThrow(
      /temporarily unavailable/,
    );
  });
  it.each([502, 503, 504, 521, 522, 523, 524])(
    "reports a %s gateway outage even when it returns HTML, without retrying a write",
    async (status) => {
      const events = new EventTarget();
      const unavailable = vi.fn();
      events.addEventListener(BACKEND_UNAVAILABLE_EVENT, unavailable);
      vi.stubGlobal("window", events);
      try {
        const fetcher = vi
          .fn()
          .mockResolvedValue(
            new Response("<html>Unavailable</html>", { status }),
          );
        const transport = new RootsetClient({ baseUrl: "/v1", fetch: fetcher });
        await expect(
          transport.request("/rows/ROW", {
            method: "PATCH",
            body: { value: "draft" },
          }),
        ).rejects.toMatchObject({ status });
        expect(unavailable).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it.each([400, 401, 403, 409, 429, 500])(
    "keeps a %s application error out of the outage interstitial",
    async (status) => {
      const events = new EventTarget();
      const unavailable = vi.fn();
      events.addEventListener(BACKEND_UNAVAILABLE_EVENT, unavailable);
      vi.stubGlobal("window", events);
      try {
        const fetcher = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code: "EXPECTED", message: "Expected error" },
            }),
            { status },
          ),
        );
        const transport = new RootsetClient({ baseUrl: "/v1", fetch: fetcher });
        await expect(transport.request("/me")).rejects.toMatchObject({
          status,
        });
        expect(unavailable).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it("reports network failure for direct authentication fetches and ignores cancellation", async () => {
    const events = new EventTarget();
    const unavailable = vi.fn();
    events.addEventListener(BACKEND_UNAVAILABLE_EVENT, unavailable);
    vi.stubGlobal("window", events);
    try {
      const failure = new TypeError("Failed to fetch");
      const fetcher = vi.fn().mockRejectedValue(failure);
      await expect(
        fetchWithBackendRecovery("/v1/auth/get-session", {}, fetcher),
      ).rejects.toBe(failure);
      expect(unavailable).toHaveBeenCalledOnce();
      unavailable.mockClear();
      fetcher.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
      await expect(
        fetchWithBackendRecovery("/v1/auth/get-session", {}, fetcher),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(unavailable).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rejects foreign origins and invalid table paths", async () => {
    const transport = new RootsetClient({ fetch: vi.fn() });
    await expect(transport.request("//other.test")).rejects.toThrow();
    expect(() => resourcePath("ORG", undefined, "TABLE")).toThrow();
  });
});
