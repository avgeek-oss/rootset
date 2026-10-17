import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  defaultDateTimePreferences,
  type Table,
  type TableSchemaResult,
} from "@rootset/contracts";
import { describe, expect, it, vi } from "vitest";
import { Spreadsheet } from "./spreadsheet";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("./saved-views", () => ({
  SavedViewsToolbar: ({ definition }: { definition: unknown }) =>
    createElement("div", { "data-layout": JSON.stringify(definition) }),
}));

const table: Table = {
  id: "01J00000000000000000000003",
  databaseId: "01J00000000000000000000002",
  orgId: "01J00000000000000000000001",
  name: "Import records",
  schemaVersion: 1,
  rowCount: 4,
  state: "active",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};
const field = {
  id: "01J00000000000000000000004",
  name: "NAME",
  type: "text" as const,
};
const schema: TableSchemaResult = {
  table,
  fields: [field],
  uniqueRules: [],
  foreignKeys: [],
  operators: {},
  limits: {},
};
const preferences = {
  columnOrder: [field.id],
  hiddenColumns: [],
  columnWidths: { [field.id]: 280 },
  frozenColumns: 0,
};

function render({
  schemaReady = true,
  preferencesReady = true,
  savedViewId = null,
  windowReady = false,
}: {
  schemaReady?: boolean;
  preferencesReady?: boolean;
  savedViewId?: string | null;
  windowReady?: boolean;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  if (schemaReady) queryClient.setQueryData(["schema", table.id], schema);
  if (preferencesReady)
    queryClient.setQueryData(["view-preferences", table.id], { preferences });
  if (windowReady)
    queryClient.setQueryData(
      [
        "initial-row-window",
        table.orgId,
        table.databaseId,
        table.id,
        1,
        { limit: 200 },
      ],
      {
        schemaVersion: 1,
        data: [
          {
            id: "01J00000000000000000000006",
            version: "1",
            values: { NAME: "Ready before navigation commits" },
            createdAt: table.createdAt,
            updatedAt: table.updatedAt,
          },
        ],
        page: { hasMore: false, nextCursor: null },
        window: { start: 0, sessionId: "ready-session" },
      },
    );
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(Spreadsheet, {
        orgId: table.orgId,
        databaseId: table.databaseId,
        table,
        preferences: {
          ...defaultDateTimePreferences,
          timezone: "UTC",
          locale: "en",
          theme: "light",
        },
        savedViewId,
        canEdit: false,
        canManage: false,
        onSettings() {},
        onChanged() {},
      }),
    }),
  );
  queryClient.clear();
  return html;
}

describe("spreadsheet initial loading", () => {
  it.each([
    ["schema", { schemaReady: false }],
    ["column preferences", { preferencesReady: false }],
    ["the first record window", {}],
    ["a saved view", { savedViewId: "01J00000000000000000000005" }],
  ])(
    "shows a loading indicator without an empty grid while waiting for %s",
    (_phase, options) => {
      const html = render(options);
      expect(html).toContain("Loading records…");
      expect(html).toContain('role="status"');
      expect(html).not.toContain('role="grid"');
      expect(html).not.toContain("grid-skeleton");
      expect(html).not.toContain("Define this table’s fields");
    },
  );

  it("renders prepared records immediately, without an effect to populate an empty grid", () => {
    const html = render({ windowReady: true });
    expect(html).toContain('role="grid"');
    expect(html).toContain('aria-rowcount="2"');
    expect(html).not.toContain("Loading records…");
  });

  it("uses cached column preferences on the first render", () => {
    const html = render();
    expect(html).toContain(`&quot;${field.id}&quot;:280`);
  });
});
