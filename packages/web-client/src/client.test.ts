import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  RootsetClient,
  resourcePath,
  browserArtifactDownloadPath,
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
      /draft is still here/,
    );
  });
  it("rejects foreign origins and invalid table paths", async () => {
    const transport = new RootsetClient({ fetch: vi.fn() });
    await expect(transport.request("//other.test")).rejects.toThrow();
    expect(() => resourcePath("ORG", undefined, "TABLE")).toThrow();
  });
});
