import { describe, expect, it } from "vitest";
import type { JsonValue, Row } from "@rootset/contracts";
import { CellUndoStack } from "./cell-undo";

function row(
  id: string,
  version: string,
  values: Record<string, JsonValue>,
): Row {
  return {
    id,
    version,
    values,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  };
}

describe("saved cell undo", () => {
  it("undoes consecutive edits in reverse order using the new server revisions", () => {
    const stack = new CellUndoStack();
    const first = row("one", "1", { COUNT: 1 });
    const second = row("one", "2", { COUNT: 2 });
    const third = row("one", "3", { COUNT: 3 });
    stack.record(4, [{ before: first, after: second, fields: ["COUNT"] }]);
    stack.record(4, [{ before: second, after: third, fields: ["COUNT"] }]);
    expect(stack.latest?.rows[0]).toMatchObject({
      values: { COUNT: 2 },
      expectedVersion: "3",
    });
    stack.complete(stack.latest!, [row("one", "4", { COUNT: 2 })]);
    expect(stack.latest?.rows[0]).toMatchObject({
      values: { COUNT: 1 },
      expectedVersion: "4",
    });
    stack.complete(stack.latest!, [row("one", "5", { COUNT: 1 })]);
    expect(stack.latest).toBeUndefined();
  });

  it("does not rebase an older edit across another writer's revision", () => {
    const stack = new CellUndoStack();
    stack.record(1, [
      {
        before: row("one", "1", { COUNT: 1 }),
        after: row("one", "2", { COUNT: 2 }),
        fields: ["COUNT"],
      },
    ]);
    stack.record(1, [
      {
        before: row("one", "3", { COUNT: 7 }),
        after: row("one", "4", { COUNT: 8 }),
        fields: ["COUNT"],
      },
    ]);
    stack.complete(stack.latest!, [row("one", "5", { COUNT: 7 })]);
    expect(stack.latest?.rows[0]?.expectedVersion).toBe("2");
  });

  it("keeps a multi-row paste as one action and restores only changed fields", () => {
    const stack = new CellUndoStack();
    stack.record(3, [
      {
        before: row("one", "1", { NAME: "First", COUNT: 1 }),
        after: row("one", "2", { NAME: "First", COUNT: 10 }),
        fields: ["NAME", "COUNT"],
      },
      {
        before: row("two", "9", { COUNT: null }),
        after: row("two", "10", { COUNT: 20 }),
        fields: ["COUNT"],
      },
    ]);
    expect(stack.latest).toEqual({
      schemaVersion: 3,
      rows: [
        {
          rowId: "one",
          beforeVersion: "1",
          expectedVersion: "2",
          values: { COUNT: 1 },
        },
        {
          rowId: "two",
          beforeVersion: "9",
          expectedVersion: "10",
          values: { COUNT: null },
        },
      ],
    });
    stack.complete(stack.latest!, [
      row("one", "3", { COUNT: 1 }),
      row("two", "11", { COUNT: null }),
    ]);
    expect(stack.latest).toBeUndefined();
  });

  it("ignores unchanged saves and preserves immutable JSON values", () => {
    const stack = new CellUndoStack();
    const value = { nested: [1, 2] };
    const before = row("one", "1", { DETAILS: value });
    stack.record(1, [{ before, after: before, fields: ["DETAILS"] }]);
    expect(stack.latest).toBeUndefined();
    stack.record(1, [
      {
        before,
        after: row("one", "2", { DETAILS: null }),
        fields: ["DETAILS"],
      },
    ]);
    value.nested.push(3);
    expect(stack.latest?.rows[0]?.values).toEqual({
      DETAILS: { nested: [1, 2] },
    });
  });

  it("removes actions involving deleted or conflicting rows without removing unrelated edits", () => {
    const stack = new CellUndoStack();
    for (const id of ["one", "two"])
      stack.record(1, [
        {
          before: row(id, "1", { ACTIVE: true }),
          after: row(id, "2", { ACTIVE: false }),
          fields: ["ACTIVE"],
        },
      ]);
    stack.forgetRows(["two"]);
    expect(stack.latest?.rows[0]?.rowId).toBe("one");
    stack.clear();
    expect(stack.latest).toBeUndefined();
  });

  it("retains only the latest 200 actions", () => {
    const stack = new CellUndoStack();
    for (let index = 0; index < 201; index++)
      stack.record(1, [
        {
          before: row(String(index), "1", { COUNT: 1 }),
          after: row(String(index), "2", { COUNT: 2 }),
          fields: ["COUNT"],
        },
      ]);
    for (let index = 200; index > 0; index--) {
      expect(stack.latest?.rows[0]?.rowId).toBe(String(index));
      stack.complete(stack.latest!, [row(String(index), "3", { COUNT: 1 })]);
    }
    expect(stack.latest).toBeUndefined();
  });
});
