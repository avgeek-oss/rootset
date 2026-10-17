import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
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
        source: "/databases/:databaseId/settings/backup-history",
        destination: "/databases/:databaseId/settings/backup-attempts",
        permanent: false,
      },
      {
        source: "/databases/:databaseId/settings/restore-requests",
        destination: "/databases/:databaseId/settings/restore-attempts",
        permanent: false,
      },
      {
        source: "/activity",
        destination: "/audit-logs",
        permanent: false,
      },
      {
        source: "/databases/:databaseId/settings/activity",
        destination: "/audit-logs",
        permanent: false,
      },
      {
        source: "/databases/:databaseId/tables/:tableId/settings/activity",
        destination: "/audit-logs",
        permanent: false,
      },
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
