import { describe, expect, it } from "vitest";
import { newId, type FieldDefinition } from "@rootset/contracts";
import {
  parseUniqueRuleCondition,
  uniqueRuleConditionLabel,
} from "./unique-rule-condition";
const fields: FieldDefinition[] = [
  { id: newId(), name: "status", type: "text" },
  { id: newId(), name: "count", type: "integer", min: 10 },
  { id: newId(), name: "enabled", type: "boolean" },
];
describe("conditional unique rule drafts", () => {
  it("preserves exact text and stable field IDs, including empty strings", () => {
    for (const value of ["active", "", "  Active  "])
      expect(
        parseUniqueRuleCondition(fields, fields[0]!.id, "eq", value),
      ).toEqual({ field: fields[0]!.id, op: "eq", value });
  });
  it("uses lossless scalar parsing and filter bounds rather than cell minimums", () => {
    expect(parseUniqueRuleCondition(fields, fields[1]!.id, "ne", "1")).toEqual({
      field: fields[1]!.id,
      op: "ne",
      value: 1,
    });
    expect(() =>
      parseUniqueRuleCondition(
        fields,
        fields[1]!.id,
        "eq",
        "1.00000000000000001",
      ),
    ).toThrow();
    expect(
      parseUniqueRuleCondition(fields, fields[2]!.id, "eq", "false"),
    ).toEqual({ field: fields[2]!.id, op: "eq", value: false });
    expect(
      parseUniqueRuleCondition(fields, fields[2]!.id, "isNull", "ignored"),
    ).toEqual({ field: fields[2]!.id, op: "isNull" });
    expect(() => parseUniqueRuleCondition(fields, "", "eq", "")).toThrow(
      "Choose a condition field",
    );
  });
  it("reviews conditions using current field names and explicit null tests", () => {
    expect(uniqueRuleConditionLabel(undefined, fields)).toBe("All rows");
    expect(
      uniqueRuleConditionLabel(
        { field: fields[0]!.id, op: "eq", value: "active" },
        [{ ...fields[0]!, name: "state" }],
      ),
    ).toBe('state is "active"');
    expect(
      uniqueRuleConditionLabel({ field: fields[0]!.id, op: "isNull" }, fields),
    ).toBe("status is NULL");
  });
});
