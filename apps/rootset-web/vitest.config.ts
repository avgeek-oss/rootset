import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    server: { deps: { inline: [/@avgeek-oss\/design-system/] } },
  },
});
