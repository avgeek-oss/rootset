import { describe, expect, it } from "vitest";
import { rowResultCount } from "./row-result-count";

describe("filtered row counts", () => {
  it("uses exact totals and complete first pages, including zero results", () => {
    expect(
      rowResultCount(
        { start: 0, length: 200, hasMore: true, total: 1244 },
        null,
      ),
    ).toEqual({ count: 1244, approximate: false });
    for (const length of [0, 1, 120])
      expect(
        rowResultCount({ start: 0, length, hasMore: false }, null),
      ).toEqual({ count: length, approximate: false });
  });
  it("keeps an estimate while scrolling, then uses the observed final total", () => {
    const initial = rowResultCount(
      { start: 0, length: 200, hasMore: true, estimate: 1244 },
      null,
    );
    expect(initial).toEqual({ count: 1244, approximate: true });
    expect(
      rowResultCount({ start: 200, length: 200, hasMore: true }, initial),
    ).toEqual(initial);
    const final = rowResultCount(
      { start: 1200, length: 60, hasMore: false },
      initial,
    );
    expect(final).toEqual({ count: 1260, approximate: false });
    expect(
      rowResultCount(
        { start: 0, length: 200, hasMore: true, estimate: 1244 },
        final,
      ),
    ).toEqual(final);
  });
  it("does not present an underestimate below rows already returned or a partial page as the total", () => {
    expect(
      rowResultCount(
        { start: 200, length: 200, hasMore: true },
        { count: 220, approximate: true },
      ),
    ).toEqual({ count: 401, approximate: true });
    expect(
      rowResultCount({ start: 0, length: 10, hasMore: true }, null),
    ).toBeNull();
    expect(
      rowResultCount(
        { start: 1200, length: 0, hasMore: false },
        { count: 1244, approximate: true },
      ),
    ).toEqual({ count: 1244, approximate: true });
  });
});
