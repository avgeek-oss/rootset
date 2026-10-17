import { z } from "zod";
import {
  analyseNumberLexeme,
  parseStrictJson,
  type NumberLexeme,
} from "./decoder";
import {
  IdSchema,
  JsonValueSchema,
  RootsetError,
  limits,
  type FieldDefinition,
  type JsonValue,
} from "./models";
import {
  assertRowBytes,
  assertValueLexemes,
  validateCell,
  validateValues,
} from "./values";

export const importLimits = Object.freeze({
  sourceBytes: 4 * 1024 * 1024,
  rows: 50_000,
  expandedBytes: 32 * 1024 * 1024,
  batch: 250,
});
export const ImportMappingSchema = z
  .array(
    z.strictObject({ source: z.string().min(1).max(255), fieldId: IdSchema }),
  )
  .max(limits.maxFields);
export const ImportSourceSchema = z.strictObject({
  format: z.enum(["csv", "jsonl"]),
  content: z
    .string()
    .max(importLimits.sourceBytes)
    .refine(
      (value) =>
        new TextEncoder().encode(value).byteLength <= importLimits.sourceBytes,
      "Import files support up to 4 MiB",
    ),
  fileName: z.string().min(1).max(255),
  mapping: ImportMappingSchema,
});
export type ImportSource = z.infer<typeof ImportSourceSchema>;
export type ImportIssue = {
  line: number;
  field?: string;
  code: string;
  message: string;
};
export const ImportIssueSchema = z.strictObject({
  line: z.number().int().positive(),
  field: z.string().optional(),
  code: z.string(),
  message: z.string(),
});
export const ImportPreviewResultSchema = z.strictObject({
  total: z.number().int().nonnegative().max(importLimits.rows),
  valid: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  fileName: z.string(),
  preview: z
    .array(
      z.strictObject({
        line: z.number().int().positive(),
        values: z.record(z.string(), JsonValueSchema),
      }),
    )
    .max(10),
  issues: z.array(ImportIssueSchema).max(100),
  reportArtifactId: IdSchema.optional(),
});
export type ImportPreviewResult = z.infer<typeof ImportPreviewResultSchema>;
interface CsvCell {
  text: string;
  quoted: boolean;
}
export interface ImportSourceRow {
  line: number;
  cells?: CsvCell[];
  values?: Record<string, JsonValue>;
  lexemes?: NumberLexeme[];
  issue?: ImportIssue;
}
export interface ParsedImport {
  columns: string[];
  rows: ImportSourceRow[];
}
export interface ImportRow {
  line: number;
  values: Record<string, JsonValue>;
  issue?: ImportIssue;
}

function invalid(message: string, line?: number): never {
  throw new RootsetError(
    "VALIDATION_FAILED",
    message,
    422,
    line === undefined ? undefined : { line },
  );
}
function csvRecords(content: string) {
  const records: { line: number; cells: CsvCell[] }[] = [];
  let cells: CsvCell[] = [],
    text = "",
    quoted = false,
    inQuotes = false,
    closed = false,
    line = 1,
    startLine = 1;
  function cell() {
    cells.push({ text, quoted });
    text = "";
    quoted = false;
    closed = false;
  }
  function record() {
    cell();
    if (!(cells.length === 1 && cells[0]!.text === "" && !cells[0]!.quoted))
      records.push({ line: startLine, cells });
    cells = [];
    if (records.length > importLimits.rows + 1)
      invalid("Import files support up to 50,000 records");
  }
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          text += '"';
          index++;
        } else {
          inQuotes = false;
          closed = true;
        }
      } else {
        text += character;
        if (character === "\n") line++;
      }
    } else if (character === ",") cell();
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") index++;
      record();
      line++;
      startLine = line;
    } else if (character === '"' && text === "" && !closed) {
      quoted = true;
      inQuotes = true;
    } else if (closed || character === '"')
      invalid(`Malformed CSV at line ${line}`, line);
    else text += character;
    if (cells.length >= limits.maxFields)
      invalid("Import files support up to 200 columns", line);
  }
  if (inQuotes)
    invalid(`Unclosed quoted CSV value at line ${startLine}`, startLine);
  if (text !== "" || cells.length || quoted) record();
  return records;
}

export function parseImportSource(
  format: ImportSource["format"],
  raw: string,
): ParsedImport {
  if (new TextEncoder().encode(raw).byteLength > importLimits.sourceBytes)
    invalid("Import files support up to 4 MiB");
  const content = raw.replace(/^\uFEFF/, "");
  if (format === "csv") {
    const records = csvRecords(content);
    const header = records.shift();
    if (!header) invalid("The CSV file needs a header and at least one record");
    const columns = header.cells.map((cell) => cell.text);
    if (
      columns.some((column) => !column || column.length > 255) ||
      new Set(columns).size !== columns.length
    )
      invalid(
        "CSV headers must be distinct, nonempty names of up to 255 characters",
        header.line,
      );
    const rows = records.map((record) => ({
      ...record,
      ...(record.cells.length !== columns.length
        ? {
            issue: {
              line: record.line,
              code: "COLUMN_COUNT",
              message: `Expected ${columns.length} columns; found ${record.cells.length}`,
            },
          }
        : {}),
    }));
    if (!rows.length) invalid("The CSV file has no records");
    return { columns, rows };
  }
  const columns = new Set<string>();
  const rows: ImportSourceRow[] = [];
  for (const [index, text] of content.split(/\r?\n/).entries()) {
    if (!text.trim()) continue;
    const line = index + 1;
    if (rows.length >= importLimits.rows)
      invalid("Import files support up to 50,000 records");
    try {
      const lexemes: NumberLexeme[] = [];
      const values = parseStrictJson(text, {
        maxDepth: 96,
        safeIntegers: false,
        onNumber: (information) => lexemes.push(information),
      });
      if (!values || Array.isArray(values) || typeof values !== "object")
        invalid("Each JSONL line must contain an object", line);
      for (const key of Object.keys(values)) {
        if (!key || key.length > 255)
          invalid("JSONL property names must contain 1–255 characters", line);
        columns.add(key);
      }
      if (columns.size > limits.maxFields)
        invalid("Import files support up to 200 columns", line);
      rows.push({ line, values, lexemes });
    } catch (error) {
      rows.push({
        line,
        issue: {
          line,
          code: "INVALID_JSON",
          message:
            error instanceof Error ? error.message : "JSON could not be parsed",
        },
      });
    }
  }
  if (!rows.length) invalid("The JSONL file has no records");
  if (columns.size > limits.maxFields)
    invalid("Import files support up to 200 columns");
  return { columns: [...columns], rows };
}

function csvValue(field: FieldDefinition, cell: CsvCell): JsonValue {
  const text = cell.text;
  if (text === "\\N" || (text === "" && !cell.quoted))
    return validateCell(field, null);
  let value: JsonValue = text;
  if (field.type === "integer") {
    let number;
    try {
      number = analyseNumberLexeme(text.trim());
    } catch {
      invalid("Enter a whole number in the safe integer range");
    }
    if (!number.integer || !number.safeInteger)
      invalid("Enter a whole number in the safe integer range");
    value = number.value;
  } else if (field.type === "float") {
    try {
      value = analyseNumberLexeme(text.trim()).value;
    } catch {
      invalid("Enter a finite number");
    }
  } else if (field.type === "boolean") {
    if (text !== "true" && text !== "false")
      invalid("Use true or false for boolean values");
    value = text === "true";
  } else if (field.type === "json") value = parseStrictJson(text);
  else if (text.startsWith("\\\\")) value = text.slice(1);
  return validateCell(field, value);
}

export function prepareImportRows(
  parsed: ParsedImport,
  mapping: ImportSource["mapping"],
  fields: readonly FieldDefinition[],
): ImportRow[] {
  if (parsed.rows.every((row) => row.issue))
    return parsed.rows.map((row) => ({
      line: row.line,
      values: {},
      issue: row.issue,
    }));
  if (!mapping.length) invalid("Map at least one source column");
  const sourceNames = new Set<string>(),
    fieldIds = new Set<string>();
  const mapped = mapping.map((item) => {
    const field = fields.find((field) => field.id === item.fieldId);
    const index = parsed.columns.indexOf(item.source);
    if (!field || index < 0)
      invalid(
        "A mapped column no longer exists. Reload the schema and map the file again",
      );
    if (sourceNames.has(item.source) || fieldIds.has(field.id))
      invalid("Map each source column and destination field only once");
    sourceNames.add(item.source);
    fieldIds.add(field.id);
    return { source: item.source, field, index };
  });
  let bytes = 0;
  return parsed.rows
    .map((row) => {
      const values: Record<string, JsonValue> = Object.create(null);
      if (row.issue) return { line: row.line, values, issue: row.issue };
      let currentField: string | undefined;
      try {
        for (const item of mapped) {
          currentField = item.field.name;
          if (row.cells)
            values[item.field.name] = csvValue(
              item.field,
              row.cells[item.index]!,
            );
          else if (row.values && Object.hasOwn(row.values, item.source)) {
            assertValueLexemes(
              [{ ...item.field, name: item.source }],
              row.lexemes ?? [],
              [],
            );
            values[item.field.name] = validateCell(
              item.field,
              row.values[item.source],
            );
          }
        }
        currentField = undefined;
        const resolved = validateValues(fields, values);
        assertRowBytes(fields, resolved);
        bytes += new TextEncoder().encode(JSON.stringify(resolved)).byteLength;
        return { line: row.line, values };
      } catch (error) {
        const details =
          error instanceof RootsetError
            ? (error.details as { field?: string } | undefined)
            : undefined;
        return {
          line: row.line,
          values,
          issue: {
            line: row.line,
            ...(currentField || details?.field
              ? { field: currentField ?? details!.field }
              : {}),
            code:
              error instanceof RootsetError ? error.code : "VALIDATION_FAILED",
            message:
              error instanceof Error ? error.message : "This record is invalid",
          },
        };
      }
    })
    .map((row) => {
      if (bytes > importLimits.expandedBytes)
        invalid(
          "The mapped records exceed 32 MiB after defaults. Split the file into smaller imports",
        );
      return row;
    });
}
