import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  turbopack: { root: resolve(import.meta.dirname, "../..") },
  experimental: { proxyClientMaxBodySize: 8 * 1024 * 1024 },
  transpilePackages: [
    "@rootset/contracts",
    "@rootset/web-client",
    "@rootset/observability",
  ],
  async rewrites() {
    const api = [
      "/v1/:path*",
      "/api/internal/:path*",
      "/oauth/authorize",
      "/oauth/token",
      "/oauth/revoke",
      "/oauth/register",
      "/mcp",
      "/.well-known/:path*",
    ].map((source) => ({ source, destination: `/api/backend${source}` }));
    return {
      beforeFiles: [
        {
          source: "/v1/orgs/:orgId/artifacts/:id/upload",
          destination: "/api/artifact-upload/:orgId/:id",
        },
        {
          source: "/api/internal/v1/orgs/:orgId/artifacts/:id/upload",
          destination: "/api/artifact-upload/:orgId/:id",
        },
        ...api,
      ],
    };
  },
};

export default config;
