import { describe, expect, it } from "vitest";
import {
  normalizeSavedViewDefinition,
  type FieldDefinition,
} from "@rootset/contracts";
import { buildTableFilter } from "./table-filters";
import {
  linkedViewQuery,
  orderedViewFields,
  savedViewDirty,
  savedViewFilterState,
  savedViewPath,
  visibleViewFields,
} from "./saved-view-state";
const fields: FieldDefinition[] = [
  { id: "01J00000000000000000000001", name: "NAME", type: "text" },
  { id: "01J00000000000000000000002", name: "COUNT", type: "integer" },
  { id: "01J00000000000000000000003", name: "ENABLED", type: "boolean" },
  { id: "01J00000000000000000000004", name: "PAYLOAD", type: "json" },
];
const layout = {
  columnOrder: [fields[1]!.id, fields[0]!.id],
  hiddenColumns: [fields[1]!.id],
  columnWidths: {},
  frozenColumns: 0,
};
describe("saved view state", () => {
  it("orders visible columns without losing hidden fields or newly added fields", () => {
    expect(
      orderedViewFields(fields, layout).map((field) => field.name),
    ).toEqual(["COUNT", "NAME", "ENABLED", "PAYLOAD"]);
    expect(
      visibleViewFields(fields, layout).map((field) => field.name),
    ).toEqual(["NAME", "ENABLED", "PAYLOAD"]);
    expect(
      visibleViewFields(fields, {
        ...layout,
        hiddenColumns: fields.map((field) => field.id),
      }),
    ).toEqual([]);
  });
  it("round-trips simple saved predicates through typed filter controls", () => {
    const where = {
      and: [
        { field: "COUNT", op: "eq" as const, value: 0 },
        { field: "ENABLED", op: "eq" as const, value: false },
        { field: "NAME", op: "eq" as const, value: "" },
        {
          field: "PAYLOAD",
          op: "pathEq" as const,
          path: ["note"],
          value: "NULL",
        },
      ],
    };
    const state = savedViewFilterState(where, fields);
    expect(state.advanced).toBeUndefined();
    expect(
      buildTableFilter(state.conditions, state.combination, fields),
    ).toEqual(where);
    const nested = { and: [where, { field: "NAME", op: "isNull" as const }] };
    expect(savedViewFilterState(nested, fields).advanced).toEqual(nested);
  });
  it("keeps a linked-record restriction when a saved view is also selected", () => {
    const saved = {
      where: { field: fields[0]!.id, op: "iContains" as const, value: "Acme" },
    };
    const linked = { field: fields[1]!.id, op: "eq" as const, value: 0 };
    expect(linkedViewQuery(saved, linked).where).toEqual({
      and: [saved.where, linked],
    });
    expect(savedViewPath("database", "table", "view")).toBe(
      "/databases/database/tables/table?view=view",
    );
    expect(savedViewPath("database", "table", null)).toBe(
      "/databases/database/tables/table",
    );
  });
  it("compares layouts and filters by stable field IDs", () => {
    const definition = normalizeSavedViewDefinition(
      { ...layout, query: { where: { field: "COUNT", op: "eq", value: 0 } } },
      fields,
    );
    expect(
      savedViewDirty(
        {
          ...definition,
          query: { where: { field: "COUNT", op: "eq", value: 0 } },
        },
        definition,
        fields,
      ),
    ).toBe(false);
    expect(
      savedViewDirty({ ...definition, hiddenColumns: [] }, definition, fields),
    ).toBe(true);
  });
});
