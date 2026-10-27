import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SettingsPanel } from "./index";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@avgeek-oss/design-system", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@avgeek-oss/design-system")>()),
  ContentPage: ({
    titleContent,
    children,
  }: {
    titleContent: ReactNode;
    children: ReactNode;
  }) => createElement("main", {}, titleContent, children),
}));
vi.mock("./api", () => ({
  useResource: () => ({ data: null, loading: false, error: null }),
}));
vi.mock("./security", () => ({ IdentityConfirmation: () => null }));
vi.mock("./account/last-synced-time", () => ({
  RelativeTimeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./account/adapter", () => ({
  useApiQuery: () => ({ data: { keys: [] } }),
  useAccess: () => ({ user: { workspaceRole: "admin" } }),
  api: {},
}));

it("renders the workspace key page with the shared API Keys heading and empty state", () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPanel, {
      orgId: "installation",
      section: "workspace-api-keys",
      role: "admin",
      onClose() {},
    }),
  );
  expect(html).toContain("API Keys");
  expect(html).toContain("No API keys yet");
  expect(html).toContain("scripts or apps used in this workspace");
  expect(html).toContain("<svg");
});
