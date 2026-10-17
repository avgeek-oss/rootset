import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "react-aria-components";
import { describe, expect, it } from "vitest";
import {
  defaultDateTimePreferences,
  type FieldDefinition,
  type ForeignKey,
  type Preferences,
} from "@rootset/contracts";
import { createRecordDraft } from "../lib/record-draft";
import { RecordForeignKey } from "./record-foreign-key";
const target = {
  orgId: "01J00000000000000000000001",
  databaseId: "01J00000000000000000000002",
  tableId: "01J00000000000000000000003",
};
const field: FieldDefinition = {
  id: "01J00000000000000000000004",
  name: "MANUFACTURER_ID",
  type: "integer",
};
const rule: ForeignKey = {
  id: "01J00000000000000000000005",
  tableId: target.tableId,
  fieldIds: [field.id],
  referencedTableId: "01J00000000000000000000006",
  referencedTableName: "Manufacturers",
  referencedRuleId: "01J00000000000000000000007",
  referencedFieldIds: ["01J00000000000000000000008"],
  referencedFieldNames: ["RECORD_ID"],
  state: "active",
};
const preferences: Preferences = {
  ...defaultDateTimePreferences,
  timezone: "UTC",
  locale: "en",
  theme: "light",
};
function render(readOnly: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    ["foreign-key-schema", target.orgId, rule.referencedTableId],
    {
      table: { schemaVersion: 1 },
      fields: [
        { ...field, id: rule.referencedFieldIds[0]!, name: "RECORD_ID" },
      ],
    },
  );
  queryClient.setQueryData(["view-preferences", target.tableId], {
    preferences: {
      columnOrder: [],
      columnWidths: {},
      frozenColumns: 0,
      hiddenColumns: [],
    },
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(I18nProvider, {
        locale: "en-GB",
        children: createElement(RecordForeignKey, {
          target,
          rule,
          fields: [field],
          drafts: createRecordDraft([field]),
          preferences,
          errors: {},
          disabled: false,
          readOnly,
          creating: true,
          onChange() {},
        }),
      }),
    }),
  );
}
describe("foreign-key picker controls", () => {
  it("keeps the field label associated and gives the control and action menu distinct IDs", () => {
    const html = render(false);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toEqual(ids.length);
    const labelId = html.match(/<label\b[^>]*id="([^"]+)"/)?.[1];
    expect(labelId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="`);
    expect(html).toContain(labelId!);
    expect(html).toContain("Manufacturers");
    expect(html).toContain("MANUFACTURER_ID");
    expect(html).toContain("null-value");
  });
  it("uses a disabled native picker for a read-only record", () => {
    const html = render(true);
    const trigger = html.match(
      /<button\b[^>]*data-slot="select-trigger"[^>]*>/,
    )?.[0];
    expect(trigger).toContain('disabled=""');
  });
});
