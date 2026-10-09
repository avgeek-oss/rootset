import type { JsonValue, Row } from "@rootset/contracts";

interface UndoRow {
  rowId: string;
  beforeVersion: string;
  expectedVersion: string;
  values: Record<string, JsonValue>;
}

export interface CellUndoChange {
  schemaVersion: number;
  rows: UndoRow[];
}

export class CellUndoStack {
  private changes: CellUndoChange[] = [];

  get latest() {
    return this.changes.at(-1);
  }

  record(
    schemaVersion: number,
    updates: { before: Row; after: Row; fields: string[] }[],
  ) {
    const rows: UndoRow[] = [];
    for (const { before, after, fields } of updates) {
      const changed = fields.filter(
        (field) =>
          JSON.stringify(before.values[field] ?? null) !==
          JSON.stringify(after.values[field] ?? null),
      );
      if (!changed.length) {
        this.advanceVersion(before.id, before.version, after.version);
        continue;
      }
      rows.push({
        rowId: before.id,
        beforeVersion: before.version,
        expectedVersion: after.version,
        values: structuredClone(
          Object.fromEntries(
            changed.map((field) => [field, before.values[field] ?? null]),
          ),
        ),
      });
    }
    if (rows.length) {
      this.changes.push({ schemaVersion, rows });
      if (this.changes.length > 200) this.changes.shift();
    }
  }

  complete(change: CellUndoChange, restored: Row[]) {
    if (this.latest !== change) return;
    this.changes.pop();
    for (const previous of change.rows) {
      const row = restored.find((row) => row.id === previous.rowId);
      if (row) this.advanceVersion(row.id, previous.beforeVersion, row.version);
    }
  }

  forgetRows(rowIds: string[]) {
    this.changes = this.changes.filter(
      (change) => !change.rows.some((row) => rowIds.includes(row.rowId)),
    );
  }

  clear() {
    this.changes = [];
  }

  private advanceVersion(rowId: string, before: string, after: string) {
    for (const change of this.changes)
      for (const row of change.rows)
        if (row.rowId === rowId && row.expectedVersion === before)
          row.expectedVersion = after;
  }
}
