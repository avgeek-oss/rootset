import { describe, expect, it } from "vitest";
import { loadRecordSelection, selectRecords } from "./row-selection";
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

describe("selection after duplication", () => {
  it("selects only the returned new IDs with their current versions", async () => {
    const requested: string[] = [];
    const selected = await loadRecordSelection(
      ["new-one", "new-two"],
      [
        { id: "original", version: "10" },
        { id: "new-one", version: "1" },
      ],
      async (id) => {
        requested.push(id);
        return { id, version: "3" };
      },
      new AbortController().signal,
    );
    expect([...selected.values()]).toEqual([
      { rowId: "new-one", expectedVersion: "1" },
      { rowId: "new-two", expectedVersion: "3" },
    ]);
    expect(requested).toEqual(["new-two"]);
  });

  it("loads offscreen copies in bounded batches", async () => {
    let active = 0,
      maximum = 0;
    const ids = Array.from({ length: 9 }, (_, i) => `new-${i}`);
    const selected = await loadRecordSelection(
      ids,
      [],
      async (id) => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return { id, version: "1" };
      },
      new AbortController().signal,
    );
    expect(maximum).toBe(4);
    expect([...selected.keys()]).toEqual(ids);
  });

  it("stops after cancellation without loading the next batch", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    await expect(
      loadRecordSelection(
        ["one", "two", "three", "four", "five"],
        [],
        async (id) => {
          requested.push(id);
          if (id === "four") controller.abort();
          return { id, version: "1" };
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requested).not.toContain("five");
  });

  it("reports a failed row read instead of returning a partial selection", async () => {
    await expect(
      loadRecordSelection(
        ["new-one", "new-two"],
        [{ id: "new-one", version: "1" }],
        async () => {
          throw new Error("Row no longer exists");
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Row no longer exists");
  });
});
