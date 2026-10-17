import { describe, expect, it } from "vitest";
import type { FieldDefinition, Row } from "@rootset/contracts";
import { createRecordDraft, recordValues } from "./record-draft";

const fields: FieldDefinition[] = [
  {
    id: "00000000000000000000000001",
    name: "RECORD_ID",
    type: "integer",
    required: true,
    autoIncrement: true,
  },
  {
    id: "00000000000000000000000002",
    name: "NAME",
    type: "text",
    required: true,
  },
  {
    id: "00000000000000000000000003",
    name: "STATUS",
    type: "text",
    default: "active",
    allowedValues: ["active", "retired"],
  },
  { id: "00000000000000000000000004", name: "COUNT", type: "integer" },
  { id: "00000000000000000000000005", name: "DETAILS", type: "json" },
];
const row: Row = {
  id: "00000000000000000000000010",
  version: "3",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  values: {
    RECORD_ID: 42,
    NAME: "Example",
    STATUS: "active",
    COUNT: null,
    DETAILS: { value: 1 },
  },
};

describe("record drafts", () => {
  it("omits generated values and unchanged defaults while preserving optional NULL", () => {
    const draft = createRecordDraft(fields);
    expect(draft[fields[0]!.id]!.mode).toBe("default");
    expect(draft[fields[2]!.id]!.text).toBe("active");
    const result = recordValues(fields, draft);
    expect({ ...result.values }).toEqual({
      NAME: "",
      COUNT: null,
      DETAILS: null,
    });
    expect(Object.keys(result.errors)).toHaveLength(0);
  });
  it("accepts explicit IDs and distinguishes zero, false, empty text and NULL", () => {
    const draft = createRecordDraft(fields);
    draft[fields[0]!.id] = { text: "99", mode: "value", isNull: false };
    draft[fields[3]!.id] = { text: "0", mode: "value", isNull: false };
    draft[fields[4]!.id] = { text: "false", mode: "value", isNull: false };
    expect({ ...recordValues(fields, draft).values }).toEqual({
      RECORD_ID: 99,
      NAME: "",
      COUNT: 0,
      DETAILS: false,
    });
  });
  it("only patches changed values and keeps unchanged temporal precision", () => {
    const temporal: FieldDefinition = {
      id: "00000000000000000000000006",
      name: "INSTANT",
      type: "date-time",
    };
    const original = {
      ...row,
      values: { ...row.values, INSTANT: "2026-10-17T01:23:45.678Z" },
    };
    const schema = [...fields, temporal];
    const draft = createRecordDraft(schema, original, "Asia/Kolkata");
    expect(
      Object.keys(recordValues(schema, draft, original, "Asia/Kolkata").values),
    ).toHaveLength(0);
    draft[fields[1]!.id] = { text: "Updated", mode: "value", isNull: false };
    expect({
      ...recordValues(schema, draft, original, "Asia/Kolkata").values,
    }).toEqual({ NAME: "Updated" });
  });
  it("reports field validation without turning invalid drafts into NULL", () => {
    const draft = createRecordDraft(fields, row);
    draft[fields[0]!.id] = { text: "", mode: "null", isNull: true };
    draft[fields[2]!.id] = { text: "ACTIVE", mode: "value", isNull: false };
    draft[fields[3]!.id] = {
      text: "9007199254740993",
      mode: "value",
      isNull: false,
    };
    draft[fields[4]!.id] = {
      text: '{"x":1,"x":2}',
      mode: "value",
      isNull: false,
    };
    const result = recordValues(fields, draft, row);
    expect(Object.keys(result.errors)).toEqual([
      fields[0]!.id,
      fields[2]!.id,
      fields[3]!.id,
      fields[4]!.id,
    ]);
    expect(Object.keys(result.values)).toHaveLength(0);
  });
});
