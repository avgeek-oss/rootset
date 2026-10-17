import { describe, expect, it } from "vitest";
import { fillGridColumnWidths } from "./grid-column-widths";

describe("grid column sizing", () => {
  it("shares spare space without losing the preferred width differences", () => {
    expect(fillGridColumnWidths([180, 240, 180], 1200)).toEqual([
      380, 440, 380,
    ]);
    expect(fillGridColumnWidths([180], 900)).toEqual([900]);
  });

  it("keeps wider tables scrollable instead of squeezing the columns", () => {
    expect(fillGridColumnWidths([180, 340, 240], 300)).toEqual([180, 340, 240]);
    expect(fillGridColumnWidths([180, 240], 0)).toEqual([180, 240]);
    expect(fillGridColumnWidths([], 900)).toEqual([]);
  });

  it("fills the available width after columns are hidden or the viewport changes", () => {
    for (const available of [701, 1024, 1440]) {
      const widths = fillGridColumnWidths([180, 240], available);
      expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(
        available,
      );
    }
  });
});
