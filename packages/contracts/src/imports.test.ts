import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImportSource, prepareImportRows, importLimits } from "./imports";
import type { FieldDefinition } from "./models";

const fields: FieldDefinition[] = [
  {
    id: "00000000000000000000000001",
    name: "CODE",
    type: "text",
    required: true,
  },
  { id: "00000000000000000000000002", name: "COUNT", type: "integer" },
  { id: "00000000000000000000000003", name: "ENABLED", type: "boolean" },
  { id: "00000000000000000000000004", name: "PAYLOAD", type: "json" },
  { id: "00000000000000000000000005", name: "AMOUNT", type: "float" },
];
const mapping = fields.map((field) => ({
  source: field.name,
  fieldId: field.id,
}));

test("CSV and JSONL imports apply JSON Zod constraints and identify the failing source line", () => {
  const schema = [
    {
      ...fields[3]!,
      zodSchema: "z.object({ count: z.number().int().min(0) })",
    },
  ];
  for (const [format, content] of [
    ["jsonl", '{"PAYLOAD":{"count":0,"keep":true}}\n{"PAYLOAD":{"count":"1"}}'],
    ["csv", 'PAYLOAD\n"{""count"":0,""keep"":true}"\n"{""count"":""1""}"'],
  ] as const) {
    const rows = prepareImportRows(
      parseImportSource(format, content),
      [mapping[3]!],
      schema,
    );
    assert.equal(rows[0]!.issue, undefined);
    assert.deepEqual(rows[0]!.values.PAYLOAD, { count: 0, keep: true });
    assert.equal(rows[1]!.issue?.field, "PAYLOAD");
    assert.equal(rows[1]!.issue?.line, format === "csv" ? 3 : 2);
    assert.equal(rows[1]!.issue?.message.includes("count"), true);
  }
});

test("CSV preserves quoted newlines, escaped quotes, leading-zero text, false and zero", () => {
  const input =
    '\uFEFFCODE,COUNT,ENABLED,PAYLOAD,AMOUNT\r\n"001,\"\"two\"\"\nlines",0,false,"{""count"":0}",0.5\r\n';
  const parsed = parseImportSource("csv", input);
  assert.equal(parsed.rows[0]!.line, 2);
  const rows = prepareImportRows(parsed, mapping, fields);
  assert.equal(rows[0]!.issue, undefined);
  assert.deepEqual(
    { ...rows[0]!.values },
    {
      CODE: '001,"two"\nlines',
      COUNT: 0,
      ENABLED: false,
      PAYLOAD: { count: 0 },
      AMOUNT: 0.5,
    },
  );
});

test("CSV distinguishes NULL, quoted empty text and leading backslashes using export conventions", () => {
  const schema = [fields[0]!];
  const rows = prepareImportRows(
    parseImportSource("csv", 'CODE\n""\n\\\\N\n\\\\literal\n'),
    [mapping[0]!],
    schema,
  );
  assert.deepEqual(
    rows.map((row) => row.values.CODE),
    ["", "\\N", "\\literal"],
  );
  const optional = [{ ...fields[0]!, required: false }, fields[1]!];
  const nulls = prepareImportRows(
    parseImportSource("csv", "CODE,COUNT\n\\N,\n"),
    mapping.slice(0, 2),
    optional,
  );
  assert.deepEqual({ ...nulls[0]!.values }, { CODE: null, COUNT: null });
});

test("JSONL retains typed values, handles a final line without a newline and reports malformed rows", () => {
  const parsed = parseImportSource(
    "jsonl",
    '{"CODE":"001","COUNT":0,"ENABLED":false,"PAYLOAD":{"x":1},"AMOUNT":0.5}\n\n{"CODE":"bad",}\n{"CODE":"last","COUNT":null}',
  );
  const rows = prepareImportRows(parsed, mapping, fields);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.issue, undefined);
  assert.equal(rows[0]!.values.CODE, "001");
  assert.equal(rows[1]!.issue!.line, 3);
  assert.equal(rows[1]!.issue!.code, "INVALID_JSON");
  assert.equal(rows[2]!.values.CODE, "last");
  assert.equal(Object.hasOwn(rows[2]!.values, "ENABLED"), false);
});

test("a JSONL file with no valid objects still produces a complete error report without mappings", () => {
  const parsed = parseImportSource("jsonl", 'not JSON\n[1,2]\n{"bad":}\n');
  const rows = prepareImportRows(parsed, [], fields);
  assert.deepEqual(
    rows.map((row) => row.issue?.line),
    [1, 2, 3],
  );
  assert.ok(
    rows.every((row) => row.issue && Object.keys(row.values).length === 0),
  );
});

test("numeric validation uses original JSON lexemes after source-to-field mapping", () => {
  const map = [
    { source: "name", fieldId: fields[0]!.id },
    { source: "value", fieldId: fields[1]!.id },
  ];
  for (const value of ["9007199254740991.1", "9007199254740993", "1e100"]) {
    const rows = prepareImportRows(
      parseImportSource("jsonl", `{"name":"sample","value":${value}}`),
      map,
      fields,
    );
    assert.equal(rows[0]!.issue?.field, "COUNT");
  }
  const floats = prepareImportRows(
    parseImportSource("jsonl", '{"CODE":"sample","AMOUNT":1e100}'),
    [mapping[0]!, mapping[4]!],
    fields,
  );
  assert.equal(floats[0]!.issue, undefined);
  assert.equal(floats[0]!.values.AMOUNT, 1e100);
  const json = prepareImportRows(
    parseImportSource(
      "jsonl",
      '{"CODE":"sample","PAYLOAD":{"x":9007199254740993}}',
    ),
    [mapping[0]!, mapping[3]!],
    fields,
  );
  assert.equal(json[0]!.issue?.field, "PAYLOAD");
});

test("unmapped fields remain omitted for defaults and generated IDs", () => {
  const schema: FieldDefinition[] = [
    ...fields,
    {
      id: "00000000000000000000000006",
      name: "RECORD_ID",
      type: "integer",
      required: true,
      autoIncrement: true,
    },
    {
      id: "00000000000000000000000007",
      name: "STATUS",
      type: "text",
      required: true,
      default: "active",
      allowedValues: ["active", "paused"],
    },
  ];
  const rows = prepareImportRows(
    parseImportSource("csv", "CODE\n001\n"),
    [mapping[0]!],
    schema,
  );
  assert.equal(rows[0]!.issue, undefined);
  assert.deepEqual({ ...rows[0]!.values }, { CODE: "001" });
});

test("errors identify source lines and destination fields, with one error per invalid record", () => {
  const rows = prepareImportRows(
    parseImportSource(
      "csv",
      "CODE,COUNT,ENABLED\nfirst,abc,no\nsecond,1\nthird,2,true\n",
    ),
    mapping.slice(0, 3),
    fields,
  );
  assert.deepEqual(
    rows.map((row) => row.issue?.line),
    [2, 3, undefined],
  );
  assert.equal(rows[0]!.issue!.field, "COUNT");
  assert.equal(rows[1]!.issue!.code, "COLUMN_COUNT");
  const required = prepareImportRows(
    parseImportSource("csv", "COUNT\n1"),
    [mapping[1]!],
    fields,
  );
  assert.equal(required[0]!.issue!.field, "CODE");
});

test("ambiguous headers, mappings and malformed CSV fail without truncating the file", () => {
  for (const content of [
    "CODE,CODE\na,b",
    "CODE,\na,b",
    'CODE\n"unfinished',
    'CODE\n"value"tail',
    'CODE\nnot"quoted',
  ])
    assert.throws(() => parseImportSource("csv", content));
  const source = parseImportSource("csv", "CODE,COUNT\nfirst,1");
  assert.throws(
    () => prepareImportRows(source, [mapping[0]!, mapping[0]!], fields),
    /only once/,
  );
  assert.throws(
    () =>
      prepareImportRows(
        source,
        [{ ...mapping[0]!, source: "missing" }],
        fields,
      ),
    /no longer exists/,
  );
  assert.throws(
    () =>
      parseImportSource(
        "csv",
        Array.from({ length: 201 }, (_, index) => `field${index}`).join(",") +
          "\n",
      ),
    /200 columns/,
  );
});

test("JSONL rejects duplicate properties, non-object records and invalid Unicode", () => {
  const source = parseImportSource(
    "jsonl",
    '{"CODE":"a","CODE":"b"}\n[]\n{"CODE":"\\u0000"}',
  );
  assert.equal(source.rows.length, 3);
  assert.ok(source.rows.every((row) => row.issue?.code === "INVALID_JSON"));
});

test("imports have explicit byte and record bounds beyond a single mutation batch", () => {
  const content =
    "CODE\n" +
    Array.from({ length: 1001 }, (_, index) => `code${index}`).join("\n");
  assert.equal(
    prepareImportRows(parseImportSource("csv", content), [mapping[0]!], fields)
      .length,
    1001,
  );
  assert.throws(
    () => parseImportSource("csv", "x".repeat(importLimits.sourceBytes + 1)),
    /4 MiB/,
  );
  assert.throws(
    () =>
      parseImportSource("csv", "CODE\n" + "x\n".repeat(importLimits.rows + 1)),
    /50,000/,
  );
});
