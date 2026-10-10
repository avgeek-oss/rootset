import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "@rootset/contracts";
import { buildTableFilter, type FilterCondition } from "./table-filters";

const text: FieldDefinition = {
  id: "01M3YTS99KPQXTMVWRN1V91562",
  name: "NAME",
  type: "text",
  charLimit: 64,
};
const integer: FieldDefinition = {
  id: "01M3YTS99KPQXTMVWRN1V91563",
  name: "COUNT",
  type: "integer",
  min: 10,
  max: 20,
};
const json: FieldDefinition = {
  id: "01M3YTS99KPQXTMVWRN1V91564",
  name: "DETAILS",
  type: "json",
};
const condition: FilterCondition = {
  id: "condition",
  fieldId: text.id,
  operator: "eq",
  value: "",
  path: "",
};
const fields = [text, integer, json];

describe("table filter drafts", () => {
  it("keeps empty text distinct from a value-free null test", () => {
    expect(buildTableFilter([condition], "and", fields)).toEqual({
      field: "NAME",
      op: "eq",
      value: "",
    });
    expect(
      buildTableFilter(
        [{ ...condition, operator: "isNull", value: "ignored" }],
        "and",
        fields,
      ),
    ).toEqual({ field: "NAME", op: "isNull" });
  });
  it("validates query values without imposing row admission bounds", () => {
    expect(
      buildTableFilter(
        [{ ...condition, fieldId: integer.id, operator: "gt", value: "100" }],
        "and",
        fields,
      ),
    ).toEqual({ field: "COUNT", op: "gt", value: 100 });
    expect(() =>
      buildTableFilter(
        [{ ...condition, fieldId: integer.id, value: "9007199254740990.5" }],
        "and",
        fields,
      ),
    ).toThrow("whole number");
  });
  it("checks list types and range order before changing the query", () => {
    expect(
      buildTableFilter(
        [
          {
            ...condition,
            fieldId: integer.id,
            operator: "between",
            value: "[5,25]",
          },
        ],
        "and",
        fields,
      ),
    ).toEqual({ field: "COUNT", op: "between", value: [5, 25] });
    for (const value of ["[25,5]", "[1]", '[1,"2"]', "[null,2]"]) {
      expect(() =>
        buildTableFilter(
          [{ ...condition, fieldId: integer.id, operator: "between", value }],
          "and",
          fields,
        ),
      ).toThrow();
    }
  });
  it("validates JSON paths while retaining explicit JSON null equality", () => {
    expect(
      buildTableFilter(
        [
          {
            ...condition,
            fieldId: json.id,
            operator: "pathEq",
            path: '["nested","active"]',
            value: "null",
          },
        ],
        "and",
        fields,
      ),
    ).toEqual({
      field: "DETAILS",
      op: "pathEq",
      path: ["nested", "active"],
      value: null,
    });
    expect(
      buildTableFilter(
        [
          {
            ...condition,
            fieldId: json.id,
            operator: "pathExists",
            path: '["nested",0]',
          },
        ],
        "and",
        fields,
      ),
    ).toEqual({ field: "DETAILS", op: "pathExists", path: ["nested", 0] });
    for (const path of ["[]", '["nested",-1]', '"nested"']) {
      expect(() =>
        buildTableFilter(
          [{ ...condition, fieldId: json.id, operator: "pathExists", path }],
          "and",
          fields,
        ),
      ).toThrow();
    }
  });
  it("supports all/any conditions and removing all conditions", () => {
    const other = { ...condition, id: "other", value: "Airline" };
    const predicates = [
      { field: "NAME", op: "eq", value: "" },
      { field: "NAME", op: "eq", value: "Airline" },
    ];
    expect(buildTableFilter([condition, other], "and", fields)).toEqual({
      and: predicates,
    });
    expect(buildTableFilter([condition, other], "or", fields)).toEqual({
      or: predicates,
    });
    expect(buildTableFilter([], "and", fields)).toBeUndefined();
    expect(
      buildTableFilter(
        [condition, { ...condition, id: "duplicate" }],
        "and",
        fields,
      ),
    ).toEqual(predicates[0]);
  });
  it("requires review when a field was removed or its operator became invalid", () => {
    expect(() =>
      buildTableFilter([{ ...condition, fieldId: "removed" }], "and", fields),
    ).toThrow("still exists");
    expect(() =>
      buildTableFilter(
        [{ ...condition, fieldId: integer.id, operator: "contains" }],
        "and",
        fields,
      ),
    ).toThrow("supported");
  });
  it("requires explicit UTC values for time and date-time filters", () => {
    const dateTime: FieldDefinition = { ...text, type: "date-time" };
    expect(() =>
      buildTableFilter(
        [{ ...condition, value: "2026-10-05T12:30:00+05:30" }],
        "and",
        [dateTime],
      ),
    ).toThrow();
    expect(
      buildTableFilter(
        [{ ...condition, value: "2026-10-05T12:30:00Z" }],
        "and",
        [dateTime],
      ),
    ).toMatchObject({ value: "2026-10-05T12:30:00.000Z" });
    expect(() =>
      buildTableFilter([{ ...condition, value: "12:30:00" }], "and", [
        { ...text, type: "time" },
      ]),
    ).toThrow();
  });
});
