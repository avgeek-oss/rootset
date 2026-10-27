import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    server: {
      deps: {
        // Only the package barrel and the layout that imports a CSS module need
        // Vite's transform; Node loads the rest of the design system natively.
        inline: [
          /@avgeek-oss\/design-system\/dist\/(index|navigation\/app-layout)\.js$/,
        ],
      },
    },
  },
});
