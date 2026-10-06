import {
  limits,
  type FieldDefinition,
  type Row,
  type QueryResult,
} from "@rootset/contracts";
import { serializeTsv } from "./clipboard";

export async function readSelectedWindow(
  displayed: Row[],
  firstRow: number,
  schemaVersion: number,
  readPage: (
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<QueryResult>,
  signal: AbortSignal,
): Promise<Row[]> {
  const required = firstRow + displayed.length;
  if (firstRow < 0 || !displayed.length || required > limits.uiDefaultRows)
    throw new Error("Copy a selection within the current 200-row window.");
  const selected: Row[] = [];
  let consumed = 0,
    cursor: string | null = null;
  for (let page = 0; page < 4 && consumed < required; page++) {
    signal.throwIfAborted();
    const requested = required - consumed;
    const result = await readPage(cursor, requested, signal);
    signal.throwIfAborted();
    if (result.schemaVersion !== schemaVersion)
      throw new Error(
        "The table schema changed. Reload its schema and rows before copying. Your clipboard has not changed.",
      );
    if (result.data.length > requested)
      throw new Error(
        "Copy exceeded its bounded row window. Your clipboard has not changed.",
      );
    for (const current of result.data) {
      if (consumed >= firstRow) {
        const original = displayed[consumed - firstRow]!;
        if (current.id !== original.id || current.version !== original.version)
          throw new Error(
            "A selected row changed or moved. Refresh the rows, review the selection, and copy again. Your clipboard has not changed.",
          );
        selected.push(current);
      }
      consumed++;
    }
    if (consumed === required) return selected;
    const next = result.page.nextCursor;
    if (!result.data.length || !next || next === cursor) break;
    cursor = next;
  }
  throw new Error(
    "The selected rows are no longer available in this query. Refresh and review the selection before copying. Your clipboard has not changed.",
  );
}

export async function copySelectedRows(
  rows: Row[],
  fields: FieldDefinition[],
  fetchRow: (rowId: string, signal: AbortSignal) => Promise<Row>,
  signal: AbortSignal,
): Promise<string> {
  if (!rows.length || !fields.length || rows.length > limits.uiDefaultRows)
    throw new Error("Copy a selection within the current 200-row window.");
  const encoder = new TextEncoder();
  const lines = new Array<string>(rows.length);
  let next = 0;
  let bytes = 0;
  async function readRows() {
    while (next < rows.length) {
      signal.throwIfAborted();
      const index = next++;
      const displayed = rows[index]!;
      const row = fields.every((field) =>
        Object.hasOwn(displayed.values, field.name),
      )
        ? displayed
        : await fetchRow(displayed.id, signal);
      signal.throwIfAborted();
      if (row.id !== displayed.id || row.version !== displayed.version)
        throw new Error(
          "A selected row changed. Refresh the rows, review the selection, and copy again. Your clipboard has not changed.",
        );
      const cells = fields.map((field) => {
        if (!Object.hasOwn(row.values, field.name))
          throw new Error(
            "A selected column is unavailable. Refresh the schema and rows before copying. Your clipboard has not changed.",
          );
        const value = row.values[field.name]!;
        return value === null
          ? null
          : field.type === "json"
            ? JSON.stringify(value)
            : String(value);
      });
      const line = serializeTsv([cells]);
      // A final null-only row needs its terminator; other rows use the separator.
      lines[index] = line.endsWith("\n") ? line.slice(0, -1) : line;
      bytes += encoder.encode(lines[index]!).byteLength + 1;
      if (bytes > limits.requestBytes)
        throw new Error(
          "Copy exceeds 8 MiB. Select fewer cells or export the table. Your clipboard has not changed.",
        );
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, readRows));
  signal.throwIfAborted();
  return `${lines.join("\n")}\n`;
}
