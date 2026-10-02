import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { previewSchedule, validateSchedule } from "./schedule.js";
import { importRecords } from "./imports.js";

describe("backup civil-time schedule", () => {
  it("uses UTC output and rejects non-five-field cron", () => {
    expect(
      previewSchedule(
        "0 0 * * *",
        "UTC",
        new Date("2026-10-02T00:00:00.000Z"),
        2,
      ),
    ).toEqual(["2026-10-03T00:00:00.000Z", "2026-10-04T00:00:00.000Z"]);
    expect(() => validateSchedule("0 0 0 * * *", "UTC")).toThrow(
      "five cron fields",
    );
    expect(() => validateSchedule("0 0 * * *", "Not/AZone")).toThrow(
      "timezone",
    );
  });
  it("skips spring-forward nonexistent wall times", () => {
    expect(
      previewSchedule(
        "30 2 * * *",
        "America/New_York",
        new Date("2026-03-07T08:00:00Z"),
        2,
      ),
    ).toEqual(["2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  });
  it("runs a repeated wall time once at the earlier instant, including restart between repeats", () => {
    expect(
      previewSchedule(
        "30 1 * * *",
        "America/New_York",
        new Date("2026-10-31T06:00:00Z"),
        2,
      ),
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
    expect(
      previewSchedule(
        "30 1 * * *",
        "America/New_York",
        new Date("2026-11-01T06:00:00Z"),
        1,
      ),
    ).toEqual(["2026-11-02T06:30:00.000Z"]);
  });
  it("keeps leap-day policies scheduled across a multi-year gap and rejects nonexistent calendar dates", () => {
    expect(
      previewSchedule("0 0 29 2 *", "UTC", new Date("2026-10-02T00:00:00Z"), 2),
    ).toEqual(["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
    expect(() => validateSchedule("0 0 30 2 *", "UTC")).toThrow("invalid");
  });
});

describe("bounded strict import decoder", () => {
  it("preserves leading zeros and CSV quoting", async () => {
    const rows = [];
    for await (const row of importRecords(
      Readable.from(["code,name\n00012,\"quoted, 'name'\"\n"]),
      "csv",
    ))
      rows.push(row);
    expect(rows).toEqual([
      { record: 1, values: { code: "00012", name: "quoted, 'name'" } },
    ]);
  });
  it("rejects duplicate CSV headers and duplicate JSONL object keys", async () => {
    await expect(
      (async () => {
        for await (const row of importRecords(
          Readable.from(["code,code\na,b\n"]),
          "csv",
        ))
          void row;
      })(),
    ).rejects.toThrow("distinct");
    await expect(
      (async () => {
        for await (const row of importRecords(
          Readable.from(['{"code":"1","code":"2"}\n']),
          "jsonl",
        ))
          void row;
      })(),
    ).rejects.toThrow("duplicate");
  });
  it("rejects invalid UTF-8 and unsafe JSON numbers", async () => {
    await expect(
      (async () => {
        for await (const row of importRecords(
          Readable.from([
            Buffer.from([
              0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a,
            ]),
          ]),
          "jsonl",
        ))
          void row;
      })(),
    ).rejects.toThrow("UTF-8");
    await expect(
      (async () => {
        for await (const row of importRecords(
          Readable.from(['{"code":9007199254740993}\n']),
          "jsonl",
        ))
          void row;
      })(),
    ).rejects.toThrow("safe integer");
  });
  it("stops an oversized JSONL line before buffering the remainder of the upload", async () => {
    let chunks = 0;
    async function* bytes() {
      for (let i = 0; i < 2048; i++) {
        chunks++;
        yield Buffer.alloc(65536, 0x61);
      }
    }
    await expect(
      (async () => {
        for await (const row of importRecords(Readable.from(bytes()), "jsonl"))
          void row;
      })(),
    ).rejects.toThrow("one-megabyte");
    expect(chunks).toBeLessThan(32);
  });
});
