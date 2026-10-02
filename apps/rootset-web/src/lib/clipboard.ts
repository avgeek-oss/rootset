export interface TsvCell {
  value: string;
  quoted: boolean;
}

export function serializeTsv(rows: (string | null)[][]): string {
  const text = rows
    .map((row) =>
      row
        .map((value) =>
          value === null
            ? ""
            : value === "" || /[\t\r\n"]/.test(value)
              ? `"${value.replaceAll('"', '""')}"`
              : value,
        )
        .join("\t"),
    )
    .join("\n");
  return rows.at(-1)?.every((value) => value === null) ? `${text}\n` : text;
}

export function parseTsvCells(
  text: string,
  limits = { rows: 25_000, columns: 200, bytes: 8 * 1024 * 1024 },
): TsvCell[][] {
  if (new TextEncoder().encode(text).length > limits.bytes)
    throw new Error("Paste exceeds 8 MiB. Upload a file through Imports.");
  const rows: TsvCell[][] = [];
  let row: TsvCell[] = [],
    cell = "",
    quoted = false,
    closed = false,
    wasQuoted = false;
  function endCell() {
    if (row.length >= limits.columns)
      throw new Error(
        `Paste exceeds ${limits.columns} columns. Upload a file through Imports.`,
      );
    row.push({ value: cell, quoted: wasQuoted });
    cell = "";
    closed = false;
    wasQuoted = false;
  }
  function endRow() {
    if (rows.length >= limits.rows)
      throw new Error(
        `Paste exceeds ${limits.rows.toLocaleString()} rows. Upload a file through Imports.`,
      );
    endCell();
    rows.push(row);
    row = [];
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += character;
    } else if (character === '"' && cell.length === 0 && !closed) {
      quoted = true;
      wasQuoted = true;
    } else if (character === "\t") endCell();
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      endRow();
    } else {
      if (closed)
        throw new Error("Text follows a closing quote in the pasted data.");
      cell += character;
    }
  }
  if (quoted) throw new Error("The pasted data contains an unclosed quote.");
  if (cell.length || row.length || closed || !rows.length) endRow();
  return rows;
}

export function parseTsv(
  text: string,
  limits = { rows: 25_000, columns: 200, bytes: 8 * 1024 * 1024 },
): string[][] {
  return parseTsvCells(text, limits).map((row) =>
    row.map((cell) => cell.value),
  );
}
