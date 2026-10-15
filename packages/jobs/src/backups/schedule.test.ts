import { describe, it, expect } from "vitest";
import { latestBackupRun, nextBackupRuns } from "./schedule.js";

describe("database backup schedules", () => {
  it("uses an explicit timezone, with five fields and UTC occurrences", () => {
    const timing = { cron: "0 2 * * *", timezone: "Asia/Kolkata" };
    expect(nextBackupRuns(timing, new Date("2026-10-15T00:00:00Z"))).toEqual([
      "2026-10-15T20:30:00.000Z",
      "2026-10-16T20:30:00.000Z",
      "2026-10-17T20:30:00.000Z",
    ]);
    expect(
      latestBackupRun(
        timing,
        new Date("2026-10-15T20:30:00.000Z"),
      ).toISOString(),
    ).toBe("2026-10-15T20:30:00.000Z");
  });
  it("rejects seconds, aliases, out-of-range fields, impossible dates and invalid zones", () => {
    for (const cron of [
      "* * * * * *",
      "@daily",
      "H * * * *",
      "61 * * * *",
      "0 0 31 2 *",
    ])
      expect(() => nextBackupRuns({ cron, timezone: "UTC" })).toThrow();
    expect(() =>
      nextBackupRuns({ cron: "* * * * *", timezone: "Invalid/Zone" }),
    ).toThrow();
  });
  it("advances through daylight saving changes without repeating the fall-back occurrence", () => {
    expect(
      nextBackupRuns(
        { cron: "30 1 * * *", timezone: "America/New_York" },
        new Date("2026-11-01T00:00:00Z"),
      ),
    ).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ]);
    expect(
      nextBackupRuns(
        { cron: "30 2 * * *", timezone: "America/New_York" },
        new Date("2026-03-08T00:00:00Z"),
        1,
      ),
    ).toEqual(["2026-03-08T07:30:00.000Z"]);
  });
  it("uses the first occurrence of a repeated wall-clock minute for previews and outage catch-up", () => {
    const timing = { cron: "30 1 * * *", timezone: "America/New_York" };
    expect(nextBackupRuns(timing, new Date("2026-11-01T06:15:00Z"), 1)).toEqual(
      ["2026-11-02T06:30:00.000Z"],
    );
    expect(
      latestBackupRun(timing, new Date("2026-11-01T06:45:00Z")).toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
  });
  it("finds the latest nonduplicate occurrence when frequent jobs catch up inside a repeated hour", () => {
    const timing = { cron: "* * * * *", timezone: "America/New_York" };
    expect(
      latestBackupRun(timing, new Date("2026-11-01T06:45:00Z")).toISOString(),
    ).toBe("2026-11-01T05:59:00.000Z");
    expect(nextBackupRuns(timing, new Date("2026-11-01T06:45:00Z"), 1)).toEqual(
      ["2026-11-01T07:00:00.000Z"],
    );
  });
});
