import { describe, expect, it } from "vitest";
import type { FieldDefinition, ForeignKey, Row } from "@rootset/contracts";
import { createRecordDraft } from "./record-draft";
import {
  foreignKeyDrafts,
  foreignKeyQuery,
  foreignKeyValues,
} from "./foreign-key-picker";
const fields: FieldDefinition[] = [
  {
    id: "01J00000000000000000000001",
    name: "CODE",
    type: "text",
    required: true,
  },
  { id: "01J00000000000000000000002", name: "EDITION", type: "integer" },
];
const targets: FieldDefinition[] = [
  { ...fields[0]!, id: "01J00000000000000000000003", name: "TARGET_CODE" },
  { ...fields[1]!, id: "01J00000000000000000000004", name: "TARGET_EDITION" },
  { id: "01J00000000000000000000005", name: "NAME", type: "text" },
];
const rule: ForeignKey = {
  id: "01J00000000000000000000006",
  tableId: "01J00000000000000000000007",
  referencedTableId: "01J00000000000000000000008",
  referencedTableName: "Manufacturers",
  referencedRuleId: "01J00000000000000000000009",
  fieldIds: fields.map((field) => field.id),
  referencedFieldIds: targets.slice(0, 2).map((field) => field.id),
  referencedFieldNames: targets.slice(0, 2).map((field) => field.name),
  state: "active",
};
describe("foreign-key picker values", () => {
  it("maps a composite selection atomically by stable field IDs and preserves the real stored keys", () => {
    const row: Row = {
      id: "01J00000000000000000000010",
      version: "1",
      createdAt: "2026-10-17T10:00:00.000Z",
      updatedAt: "2026-10-17T10:00:00.000Z",
      values: { TARGET_CODE: "001", TARGET_EDITION: 0, NAME: "Manufacturer" },
    };
    const drafts = foreignKeyDrafts(rule, fields, targets, row, "UTC");
    expect(foreignKeyValues(rule, fields, drafts, "UTC")).toEqual(["001", 0]);
    expect(Object.keys(drafts)).toEqual(fields.map((field) => field.id));
    const optional = createRecordDraft(fields);
    expect(foreignKeyValues(rule, fields, optional, "UTC")).toBeUndefined();
  });
  it("searches labels and exact typed keys, excludes partial NULL keys and projects only required fields", () => {
    const query = foreignKeyQuery(targets.slice(0, 2), targets[2], "0");
    expect(query.limit).toBe(50);
    expect(query.select).toEqual(targets.map((field) => field.id));
    expect(query.where).toEqual({
      and: [
        { field: targets[0]!.id, op: "isNotNull" },
        { field: targets[1]!.id, op: "isNotNull" },
        {
          or: [
            { field: targets[0]!.id, op: "iContains", value: "0" },
            { field: targets[1]!.id, op: "eq", value: 0 },
            { field: targets[2]!.id, op: "iContains", value: "0" },
          ],
        },
      ],
    });
    const unsafe = foreignKeyQuery(
      [targets[1]!],
      undefined,
      "9007199254740991.1",
    );
    expect(JSON.stringify(unsafe.where)).not.toContain('"value"');
    expect(foreignKeyQuery([targets[1]!], undefined, "").select).toEqual([
      targets[1]!.id,
    ]);
  });
});
