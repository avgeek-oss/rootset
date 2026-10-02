export function serializeTsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) =>
          /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value,
        )
        .join("\t"),
    )
    .join("\n");
}

export function parseTsv(
  text: string,
  limits = { rows: 25_000, columns: 200, bytes: 8 * 1024 * 1024 },
): string[][] {
  if (new TextEncoder().encode(text).length > limits.bytes)
    throw new Error("Paste exceeds 8 MiB. Upload a file through Imports.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  function endCell() {
    if (row.length >= limits.columns)
      throw new Error(
        `Paste exceeds ${limits.columns} columns. Upload a file through Imports.`,
      );
    row.push(cell);
    cell = "";
    closed = false;
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
    } else if (character === '"' && cell.length === 0 && !closed) quoted = true;
    else if (character === "\t") endCell();
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
