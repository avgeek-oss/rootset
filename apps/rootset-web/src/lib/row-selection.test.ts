import { describe, expect, it } from "vitest";
import { selectRecords } from "./row-selection";
describe("explicit record selection", () => {
  it("retains the selected version across loaded windows and concurrent row refreshes", () => {
    const initial = selectRecords(new Map(), new Set(["one"]), [
      { id: "one", version: "1" },
    ]);
    const next = selectRecords(initial, new Set(["one", "two"]), [
      { id: "one", version: "2" },
      { id: "two", version: "3" },
    ]);
    expect([...next.values()]).toEqual([
      { rowId: "one", expectedVersion: "1" },
      { rowId: "two", expectedVersion: "3" },
    ]);
    expect([
      ...selectRecords(next, new Set(["one", "three"]), [
        { id: "three", version: "1" },
      ]).values(),
    ]).toEqual([
      { rowId: "one", expectedVersion: "1" },
      { rowId: "three", expectedVersion: "1" },
    ]);
    expect([...selectRecords(next, new Set(["two"]), []).keys()]).toEqual([
      "two",
    ]);
  });
  it("never fabricates unloaded records or silently truncates a large selection", () => {
    expect(selectRecords(new Map(), new Set(["unknown"]), []).size).toBe(0);
    expect(() =>
      selectRecords(
        new Map(),
        new Set(Array.from({ length: 201 }, (_, i) => String(i))),
        [],
      ),
    ).toThrow("at most 200");
  });
});
