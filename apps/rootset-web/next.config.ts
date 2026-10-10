import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  turbopack: { root: resolve(import.meta.dirname, "../..") },
  transpilePackages: [
    "@rootset/contracts",
    "@rootset/web-client",
    "@rootset/observability",
  ],
  async redirects() {
    return [
      {
        source: "/settings",
        destination: "/settings/profile",
        permanent: false,
      },
      {
        source: "/settings/organisation",
        destination: "/team-settings/general",
        permanent: false,
      },
      {
        source: "/settings/members",
        destination: "/team-settings/members",
        permanent: false,
      },
      {
        source: "/team-settings",
        destination: "/team-settings/general",
        permanent: false,
      },
    ];
  },
};

export default config;
