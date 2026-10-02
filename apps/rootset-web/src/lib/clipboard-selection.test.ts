import { describe, expect, it } from "vitest";
import {
  type FieldDefinition,
  type Row,
  type QueryResult,
} from "@rootset/contracts";
import { copySelectedRows, readSelectedWindow } from "./clipboard-selection";
import { parseTsvCells } from "./clipboard";

const fields: FieldDefinition[] = [
  { id: "TEXT", apiKey: "TEXT", label: "Text", type: "text" },
  { id: "JSON", apiKey: "JSON", label: "JSON", type: "json" },
];
function row(
  index: number,
  values: Row["values"] = { TEXT: "", JSON: "abc" },
): Row {
  return {
    id: String(index),
    version: "1",
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    values,
  };
}
describe("bounded clipboard selection reads", () => {
  function page(
    data: Row[],
    cursor: string | null,
    schemaVersion = 1,
  ): QueryResult {
    return {
      data,
      schemaVersion,
      page: {
        returned: data.length,
        requestedLimit: 200,
        hasMore: !!cursor,
        nextCursor: cursor,
        stopReason: cursor ? "byte_limit" : "end",
        consistency: "live",
      },
    };
  }
  it("continues a projected byte-truncated window with bounded rows and verifies selected order/revisions", async () => {
    const displayed = [row(1, {}), row(2, {}), row(3, {})];
    const requests: { cursor: string | null; limit: number }[] = [];
    const selected = await readSelectedWindow(
      displayed,
      1,
      1,
      async (cursor, limit) => {
        requests.push({ cursor, limit });
        return cursor
          ? page([row(2), row(3)], null)
          : page([row(0), row(1)], "signed-tail");
      },
      new AbortController().signal,
    );
    expect(requests).toEqual([
      { cursor: null, limit: 4 },
      { cursor: "signed-tail", limit: 2 },
    ]);
    expect(selected.map((current) => current.id)).toEqual(["1", "2", "3"]);
  });
  it("refuses insertion/deletion/order drift and schema changes before clipboard serialization", async () => {
    for (const data of [
      [row(9), row(1)],
      [row(1)],
      [{ ...row(0), version: "2" }, row(1)],
    ])
      await expect(
        readSelectedWindow(
          [row(0, {}), row(1, {})],
          0,
          1,
          async () => page(data, null),
          new AbortController().signal,
        ),
      ).rejects.toThrow("selected row changed");
    await expect(
      readSelectedWindow(
        [row(0, {})],
        0,
        1,
        async () => page([row(0)], null, 2),
        new AbortController().signal,
      ),
    ).rejects.toThrow("table schema changed");
  });
  it("bounds continuation pages and rejects a repeated cursor or missing selected tail", async () => {
    let reads = 0;
    await expect(
      readSelectedWindow(
        Array.from({ length: 5 }, (_, i) => row(i, {})),
        0,
        1,
        async () => page([row(reads++)], `cursor-${reads}`),
        new AbortController().signal,
      ),
    ).rejects.toThrow("no longer available");
    expect(reads).toBe(4);
    await expect(
      readSelectedWindow(
        [row(0, {}), row(1, {}), row(2, {})],
        0,
        1,
        async (cursor) => page([row(cursor ? 1 : 0)], "same-cursor"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("no longer available");
  });
  it("fetches unloaded selected fields with at most four reads and preserves row order", async () => {
    let active = 0,
      maximum = 0,
      requests = 0;
    const result = await copySelectedRows(
      Array.from({ length: 12 }, (_, index) => row(index, {})),
      fields,
      async (id) => {
        requests++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, Number(id) % 3));
        active--;
        return row(Number(id), { TEXT: `value-${id}`, JSON: "abc" });
      },
      new AbortController().signal,
    );
    expect(maximum).toBe(4);
    expect(requests).toBe(12);
    expect(
      parseTsvCells(result).map((cells) => cells.map((cell) => cell.value)),
    ).toEqual(Array.from({ length: 12 }, (_, i) => [`value-${i}`, '"abc"']));
  });
  it("preserves null, empty text and JSON scalar strings without fetching loaded cells", async () => {
    const result = await copySelectedRows(
      [row(0), row(1, { TEXT: null, JSON: ["a\tb", { value: '"' }] })],
      fields,
      () => {
        throw new Error("Unneeded read");
      },
      new AbortController().signal,
    );
    const parsed = parseTsvCells(result);
    expect(parsed[0]![0]).toEqual({ value: "", quoted: true });
    expect(parsed[1]![0]).toEqual({ value: "", quoted: false });
    expect(JSON.parse(parsed[0]![1]!.value)).toBe("abc");
    expect(JSON.parse(parsed[1]![1]!.value)).toEqual(["a\tb", { value: '"' }]);
  });
  it("refuses stale revisions and absent selected fields rather than emitting blanks", async () => {
    await expect(
      copySelectedRows(
        [row(0, {})],
        fields,
        async () => ({ ...row(0), version: "2" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("selected row changed");
    await expect(
      copySelectedRows(
        [row(0, {})],
        fields,
        async () => row(0, { TEXT: "loaded" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("selected column is unavailable");
  });
  it("cancels in-flight reads before serializing a replacement selection", async () => {
    const controller = new AbortController();
    let requests = 0;
    const pending = copySelectedRows(
      Array.from({ length: 20 }, (_, i) => row(i, {})),
      fields,
      (_id, signal) =>
        new Promise((_, reject) => {
          requests++;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(4);
  });
  it("enforces the current-window row bound and 8 MiB serialized byte budget", async () => {
    await expect(
      copySelectedRows(
        Array.from({ length: 201 }, (_, i) => row(i)),
        fields,
        async () => row(0),
        new AbortController().signal,
      ),
    ).rejects.toThrow("200-row window");
    await expect(
      copySelectedRows(
        Array.from({ length: 200 }, (_, i) =>
          row(i, { TEXT: '"'.repeat(24_000), JSON: null }),
        ),
        fields,
        async () => row(0),
        new AbortController().signal,
      ),
    ).rejects.toThrow("8 MiB");
  });
});
