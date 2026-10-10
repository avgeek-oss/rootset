import { describe, expect, it } from "vitest";
import { parseTsv, parseTsvCells, serializeTsv } from "./clipboard";

describe("spreadsheet clipboard", () => {
  it("preserves tabs, multiline text, quotes, JSON, Unicode and explicit empty cells", () => {
    const rows = [
      ["Air\nline", "A\tB", 'a "quote"', ""],
      ["✈️", '{"nested":null}', "false", ""],
    ];
    expect(parseTsv(serializeTsv(rows))).toEqual(rows);
  });
  it("accepts Excel CRLF and does not add a record for a final line terminator", () => {
    expect(parseTsv("one\ttwo\r\nthree\tfour\r\n")).toEqual([
      ["one", "two"],
      ["three", "four"],
    ]);
  });
  it("distinguishes quoted empty text from null including final null-only rows", () => {
    const rows = [["", null, '"quoted"', "a\tb\nnext"], [null]];
    const parsed = parseTsvCells(serializeTsv(rows));
    expect(parsed[0]).toEqual([
      { value: "", quoted: true },
      { value: "", quoted: false },
      { value: '"quoted"', quoted: true },
      { value: "a\tb\nnext", quoted: true },
    ]);
    expect(parsed[1]).toEqual([{ value: "", quoted: false }]);
    expect(parseTsvCells(serializeTsv([[null], [null]]))).toHaveLength(2);
    expect(parseTsvCells('""\t\r\n')).toEqual([
      [
        { value: "", quoted: true },
        { value: "", quoted: false },
      ],
    ]);
  });
  it("fails before mutation on malformed quotes", () => {
    expect(() => parseTsv('"unclosed')).toThrow("unclosed quote");
    expect(() => parseTsv('"closed"extra')).toThrow("closing quote");
  });
  it("enforces clipboard byte and shape budgets before retaining unbounded cells", () => {
    expect(() =>
      parseTsv("one\ntwo\nthree", { rows: 2, columns: 2, bytes: 100 }),
    ).toThrow("2 rows");
    expect(() =>
      parseTsv("one\ttwo\tthree", { rows: 2, columns: 2, bytes: 100 }),
    ).toThrow("2 columns");
    expect(() => parseTsv("✈️", { rows: 2, columns: 2, bytes: 2 })).toThrow(
      "8 MiB",
    );
  });
});
