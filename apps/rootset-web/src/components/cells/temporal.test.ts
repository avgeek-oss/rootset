import { describe, expect, it } from "vitest";
import {
  getLocalDateTimeCandidates,
  localDateTimeToUtc,
  timeInputToUtc,
  utcDateTimeToLocal,
  utcTimeToInput,
} from "./temporal";

describe("UTC time-only editing", () => {
  it("never applies a date or timezone to a time-only cell", () => {
    expect(utcTimeToInput("07:04:03.1Z")).toBe("07:04:03.100");
    expect(timeInputToUtc("07:04")).toBe("07:04:00.000Z");
    expect(timeInputToUtc("07:04:03.12")).toBe("07:04:03.120Z");
  });

  it.each([
    "24:00",
    "23:59:60",
    "07:04:03.1234",
    "07:04:03+05:30",
    "07:04:03Z",
    "",
  ])("rejects invalid clock input %s", (value) => {
    expect(() => timeInputToUtc(value)).toThrow();
  });
});

describe("date-time calendar conversion", () => {
  it("converts in the selected IANA zone rather than the browser zone", () => {
    expect(utcDateTimeToLocal("2026-10-02T12:30:01.123Z", "Asia/Kolkata")).toBe(
      "2026-10-02T18:00:01.123",
    );
    expect(localDateTimeToUtc("2026-10-02T18:00:01.123", "Asia/Kolkata")).toBe(
      "2026-10-02T12:30:01.123Z",
    );
    expect(localDateTimeToUtc("2026-10-02T12:30", "UTC")).toBe(
      "2026-10-02T12:30:00.000Z",
    );
  });

  it("preserves the supported early and late year boundaries", () => {
    expect(utcDateTimeToLocal("0001-01-01T00:00:00.000Z", "UTC")).toBe(
      "0001-01-01T00:00:00.000",
    );
    expect(localDateTimeToUtc("0099-12-31T23:59:59.999", "UTC")).toBe(
      "0099-12-31T23:59:59.999Z",
    );
    expect(localDateTimeToUtc("9999-12-31T23:59:59.999", "UTC")).toBe(
      "9999-12-31T23:59:59.999Z",
    );
  });

  it("rejects invalid calendar dates rather than normalising them", () => {
    expect(() => localDateTimeToUtc("2025-02-29T10:00", "UTC")).toThrow();
    expect(() => localDateTimeToUtc("2024-02-30T10:00", "UTC")).toThrow();
    expect(() => localDateTimeToUtc("2024-02-29T24:00", "UTC")).toThrow();
    expect(() =>
      localDateTimeToUtc("2024-02-29T10:00:00.1234", "UTC"),
    ).toThrow();
    expect(() => localDateTimeToUtc("2024-02-29T10:00Z", "UTC")).toThrow();
    expect(localDateTimeToUtc("2024-02-29T10:00", "UTC")).toBe(
      "2024-02-29T10:00:00.000Z",
    );
  });

  it("rejects nonexistent daylight-saving and political offset times", () => {
    expect(
      getLocalDateTimeCandidates("2026-03-08T02:30", "America/New_York"),
    ).toEqual([]);
    expect(() =>
      localDateTimeToUtc("2026-03-08T02:30", "America/New_York"),
    ).toThrow(/does not exist/);
    expect(
      getLocalDateTimeCandidates("2011-12-30T12:00", "Pacific/Apia"),
    ).toEqual([]);
  });

  it("requires an explicit choice for a repeated local time", () => {
    const candidates = getLocalDateTimeCandidates(
      "2026-11-01T01:30:00.125",
      "America/New_York",
    );
    expect(candidates.map((candidate) => candidate.instant)).toEqual([
      "2026-11-01T05:30:00.125Z",
      "2026-11-01T06:30:00.125Z",
    ]);
    expect(candidates.map((candidate) => candidate.offsetSeconds)).toEqual([
      -14400, -18000,
    ]);
    expect(() =>
      localDateTimeToUtc("2026-11-01T01:30:00.125", "America/New_York"),
    ).toThrow(/occurs twice/);
    expect(
      localDateTimeToUtc(
        "2026-11-01T01:30:00.125",
        "America/New_York",
        candidates[1]!.instant,
      ),
    ).toBe("2026-11-01T06:30:00.125Z");
    expect(() =>
      localDateTimeToUtc(
        "2026-11-01T01:30:00.125",
        "America/New_York",
        "2026-11-01T07:30:00.125Z",
      ),
    ).toThrow(/occurs twice/);
  });

  it("handles half-hour daylight-saving shifts explicitly", () => {
    const candidates = getLocalDateTimeCandidates(
      "2026-04-05T01:45",
      "Australia/Lord_Howe",
    );
    expect(candidates.map((candidate) => candidate.offsetSeconds)).toEqual([
      39600, 37800,
    ]);
    expect(
      getLocalDateTimeCandidates("2026-10-04T02:15", "Australia/Lord_Howe"),
    ).toEqual([]);
  });

  it("rejects invalid timezones and permits boundary local dates only for supported UTC instants", () => {
    expect(() =>
      getLocalDateTimeCandidates("2026-10-02T18:00", "Wrong/Zone"),
    ).toThrow();
    const early = utcDateTimeToLocal(
      "0001-01-01T00:00:00.000Z",
      "America/New_York",
    );
    expect(early).toBe("0000-12-31T19:03:58.000");
    expect(localDateTimeToUtc(early, "America/New_York")).toBe(
      "0001-01-01T00:00:00.000Z",
    );
    const late = utcDateTimeToLocal("9999-12-31T23:59:59.999Z", "Asia/Kolkata");
    expect(late).toBe("10000-01-01T05:29:59.999");
    expect(localDateTimeToUtc(late, "Asia/Kolkata")).toBe(
      "9999-12-31T23:59:59.999Z",
    );
    expect(() => localDateTimeToUtc("0000-12-31T19:03:58.000", "UTC")).toThrow(
      /UTC years/,
    );
    expect(() => localDateTimeToUtc("10000-01-01T05:29:59.999", "UTC")).toThrow(
      /UTC years/,
    );
  });
});
