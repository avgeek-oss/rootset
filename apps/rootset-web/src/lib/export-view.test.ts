import { describe, expect, it } from "vitest";
import { exportViewQuery } from "./export-view";
import type { FieldDefinition } from "@rootset/contracts";
const fields: FieldDefinition[] = [
  { id: "01J00000000000000000000001", name: "NAME", type: "text" },
  { id: "01J00000000000000000000002", name: "COUNT", type: "integer" },
  { id: "01J00000000000000000000003", name: "ACTIVE", type: "boolean" },
];
describe("current-view export", () => {
  it("captures all matching rows with only chosen columns and stable references", () => {
    const query = {
      limit: 50,
      cursor: "page-token",
      where: { field: "ACTIVE", op: "eq" as const, value: false },
      orderBy: [{ field: "COUNT", direction: "desc" as const }],
    };
    expect(
      exportViewQuery(query, fields, [fields[1]!.id, fields[0]!.id]),
    ).toEqual({
      select: [fields[1]!.id, fields[0]!.id],
      where: { field: fields[2]!.id, op: "eq", value: false },
      orderBy: [{ field: fields[1]!.id, direction: "desc" }],
    });
    expect(query.cursor).toBe("page-token");
  });
  it("rejects empty or obsolete column selections instead of exporting hidden data", () => {
    expect(() => exportViewQuery({}, fields, [])).toThrow();
    expect(() => exportViewQuery({}, fields, ["DELETED"])).toThrow();
  });
});
