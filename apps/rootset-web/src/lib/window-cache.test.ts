import { describe, it, expect } from "vitest";
import { RowWindowCache, visibleColumns, visibleRange } from "./window-cache";
import type { Row } from "@rootset/contracts";

const row: Row = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  version: "1",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  values: { NAME: "one" },
};
describe("bounded viewport storage", () => {
  it("evicts old windows after scrolling and touching preserves recency", () => {
    const cache = new RowWindowCache(5000, 2);
    cache.set({ key: "one", start: 0, rows: [row], nextCursor: null });
    cache.set({ key: "two", start: 1, rows: [row], nextCursor: null });
    cache.get("one");
    cache.set({ key: "three", start: 2, rows: [row], nextCursor: null });
    expect(cache.size).toBe(2);
    expect(cache.get("two")).toBeUndefined();
    expect(cache.get("one")).toBeDefined();
    cache.clear();
    expect(cache.byteSize).toBe(0);
  });
  it("does not accept a single window beyond its byte budget", () => {
    const cache = new RowWindowCache(100, 5);
    cache.set({ key: "huge", start: 0, rows: [row], nextCursor: null });
    expect(cache.size).toBe(0);
  });
  it("bounds DOM rows independently of a five-million logical range", () => {
    expect(visibleRange(10_000_000, 700, 36, 5_000_000)).toEqual({
      start: 277773,
      end: 277802,
    });
    const columns = visibleColumns(
      Array.from({ length: 200 }, () => 180),
      10_000,
      1000,
      1,
    );
    expect(columns.length).toBeLessThan(10);
    expect(columns[0]?.index).toBe(0);
  });
});
