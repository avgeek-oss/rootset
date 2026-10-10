import { describe, expect, it } from "vitest";
import type { Row } from "@rootset/contracts";
import { mergeScrollWindow } from "./scroll-window";
const rows = (start: number, count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String(start + i),
    version: "1",
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    values: { name: String(start + i) },
  }));
describe("scroll window bounds", () => {
  it("retains contiguous rows and correct ranks when scrolling beyond the client cap", () => {
    const next = mergeScrollWindow(
      rows(0, 1000),
      0,
      rows(1000, 200),
      1000,
      "next",
    );
    expect(next.rows).toHaveLength(1000);
    expect(next.start).toBe(200);
    expect(next.offset).toBe(-200);
    expect(next.rows[0]!.id).toBe("200");
    expect(next.rows.at(-1)!.id).toBe("1199");
    const previous = mergeScrollWindow(
      next.rows,
      next.start,
      rows(0, 200),
      0,
      "previous",
    );
    expect(previous.rows.map((row) => row.id)).toEqual(
      rows(0, 1000).map((row) => row.id),
    );
    expect(previous.start).toBe(0);
    expect(previous.offset).toBe(200);
    expect(previous.trimmed).toBe(200);
  });
  it("appends a short final page without shifting the viewport", () => {
    const next = mergeScrollWindow(rows(0, 200), 0, rows(200, 3), 200, "next");
    expect(next.rows).toHaveLength(203);
    expect(next.start).toBe(0);
    expect(next.offset).toBe(0);
  });
  it("does not duplicate overlapping rows when scrolling back from an unaligned final batch", () => {
    const previous = mergeScrollWindow(
      rows(100, 1000),
      100,
      rows(0, 200),
      0,
      "previous",
    );
    expect(previous.rows.map((row) => row.id)).toEqual(
      rows(0, 1000).map((row) => row.id),
    );
    expect(previous.offset).toBe(100);
    expect(previous.trimmed).toBe(100);
  });
  it("evicts large old rows before reaching the row cap", () => {
    const current = rows(0, 40).map((row) => ({
      ...row,
      values: { json: "x".repeat(1024 * 1024) },
    }));
    const next = mergeScrollWindow(current, 0, rows(40, 1), 40, "next");
    expect(next.rows.length).toBeLessThan(33);
    expect(next.rows.at(-1)!.id).toBe("40");
    expect(next.start).toBe(next.trimmed);
  });
});
