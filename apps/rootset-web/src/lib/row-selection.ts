import {
  bulkRowsLimits,
  type BulkRowsInput,
  type Row,
} from "@rootset/contracts";
export type SelectedRecord = BulkRowsInput["rows"][number];
export function selectRecords(
  previous: ReadonlyMap<string, SelectedRecord>,
  keys: ReadonlySet<string>,
  loaded: readonly Pick<Row, "id" | "version">[],
): Map<string, SelectedRecord> {
  if (keys.size > bulkRowsLimits.rows)
    throw new Error(
      `Select at most ${bulkRowsLimits.rows} records. Narrow the view or choose a smaller group.`,
    );
  const rows = new Map(loaded.map((row) => [row.id, row]));
  const selected = new Map<string, SelectedRecord>();
  for (const key of keys) {
    const existing = previous.get(key);
    const row = rows.get(key);
    if (existing) selected.set(key, existing);
    else if (row)
      selected.set(key, { rowId: row.id, expectedVersion: row.version });
  }
  return selected;
}

export async function loadRecordSelection(
  ids: readonly string[],
  loaded: readonly Pick<Row, "id" | "version">[],
  readRow: (id: string) => Promise<Pick<Row, "id" | "version">>,
  signal: AbortSignal,
): Promise<Map<string, SelectedRecord>> {
  const rows = new Map(loaded.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !rows.has(id));
  for (let offset = 0; offset < missing.length; offset += 4) {
    signal.throwIfAborted();
    const next = await Promise.all(
      missing.slice(offset, offset + 4).map(readRow),
    );
    for (const row of next) rows.set(row.id, row);
  }
  signal.throwIfAborted();
  return selectRecords(new Map(), new Set(ids), [...rows.values()]);
}
