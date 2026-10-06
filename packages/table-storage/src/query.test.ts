import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import {
  limits,
  RootsetError,
  type FieldDefinition,
  type FilterNode,
  type JsonValue,
  type QueryResult,
  type Row,
} from "@rootset/contracts";
import {
  buildPage,
  compileKeyset,
  compileQuery,
  CursorCodec,
  fieldColumn,
  type CursorBinding,
} from "./query.js";

const id = (value: number): string => `0${value.toString().padStart(25, "0")}`;
const fields: FieldDefinition[] = [
  { id: id(1), name: "name", type: "text", charLimit: 100 },
  {
    id: id(2),
    name: "number",
    type: "integer",
    min: 10,
    max: 100,
  },
  { id: id(3), name: "ratio", type: "float" },
  { id: id(4), name: "active", type: "boolean" },
  { id: id(5), name: "date", type: "date" },
  { id: id(6), name: "time", type: "time" },
  { id: id(7), name: "timestamp", type: "date-time" },
  { id: id(8), name: "document", type: "json" },
];
const row = (value: number, text = "x"): Row => ({
  id: id(value),
  version: "1",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  values: { name: text },
});
const cursorForRow = (value: Row): string => `cursor-${value.id}`;
const binding: CursorBinding = {
  orgId: id(10),
  tableId: id(11),
  schemaVersion: 1,
  membershipVersion: 3,
  actorId: id(12),
  queryHash: "a".repeat(64),
};
function nestedJson(depth: number): JsonValue {
  let value: JsonValue = true;
  for (let index = 0; index < depth; index++) value = { value };
  return value;
}
function fails(fn: () => unknown, code = "VALIDATION_FAILED"): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof RootsetError && error.code === code,
  );
}

test("default query projects every field and uses an ID tie-breaker", () => {
  const compiled = compileQuery(fields, {});
  assert.equal(compiled.where, "TRUE");
  assert.equal(compiled.orderBy, '"row_id" ASC NULLS LAST');
  assert.deepEqual(compiled.params, []);
  assert.deepEqual(compiled.projection, fields);
  assert.equal(compiled.limit, 5_000);
});

test("values, field references, and JSON paths cannot inject SQL", () => {
  const injection = "x'); DROP TABLE rootset.rows; --";
  const compiled = compileQuery(fields, {
    where: {
      and: [
        { field: "name", op: "eq", value: injection },
        {
          field: "document",
          op: "pathEq",
          path: ['unsafe"; DROP TABLE rows;--', 0],
          value: injection,
        },
      ],
    },
  });
  assert.ok(!compiled.where.includes(injection));
  assert.ok(!compiled.where.includes("DROP"));
  assert.deepEqual(compiled.params, [
    injection,
    ['unsafe"; DROP TABLE rows;--', "0"],
    JSON.stringify(injection),
  ]);
  fails(() => compileQuery(fields, { select: ['name";DROP TABLE rows'] }));
  fails(() => fieldColumn({ id: 'name";DROP TABLE rows' }));
  const unusualKey = 'column"; DROP TABLE rows;--';
  fails(() =>
    compileQuery([{ ...fields[0]!, name: unusualKey }], {
      where: { field: unusualKey, op: "eq", value: "safe" },
    }),
  );
});

test("LIKE predicates escape wildcard and escape characters", () => {
  const value = "a_%\\b";
  assert.deepEqual(
    compileQuery(fields, { where: { field: "name", op: "prefix", value } })
      .params,
    ["a\\_\\%\\\\b%"],
  );
  assert.deepEqual(
    compileQuery(fields, { where: { field: "name", op: "contains", value } })
      .params,
    ["%a\\_\\%\\\\b%"],
  );
  assert.match(
    compileQuery(fields, { where: { field: "name", op: "iContains", value } })
      .where,
    / ILIKE /,
  );
});

test("all scalar types bind typed values with canonical UTC fractions", () => {
  const predicates: FilterNode[] = [
    { field: "number", op: "lt", value: 0 },
    { field: "ratio", op: "between", value: [-0.5, 1.25] },
    { field: "active", op: "eq", value: false },
    { field: "date", op: "gte", value: "2024-02-29" },
    { field: "time", op: "eq", value: "08:09:10.1Z" },
    { field: "timestamp", op: "eq", value: "2026-10-02T08:09:10Z" },
  ];
  const compiled = compileQuery(fields, { where: { and: predicates } });
  assert.deepEqual(compiled.params, [
    0,
    -0.5,
    1.25,
    false,
    "2024-02-29",
    "08:09:10.100Z",
    "2026-10-02T08:09:10.000Z",
  ]);
});

test("JSON path equality distinguishes string, number, boolean, and nested null", () => {
  const compiled = compileQuery(fields, {
    where: {
      and: [
        { field: "document", op: "pathEq", path: ["code"], value: "1" },
        { field: "document", op: "pathEq", path: ["code"], value: 1 },
        { field: "document", op: "pathEq", path: ["flag"], value: false },
        { field: "document", op: "pathEq", path: ["empty"], value: null },
        { field: "document", op: "pathExists", path: ["items", 0] },
        {
          field: "document",
          op: "jsonContains",
          value: { b: 2, a: [1, null] },
        },
      ],
    },
  });
  assert.deepEqual(compiled.params, [
    ["code"],
    '"1"',
    ["code"],
    "1",
    ["flag"],
    "false",
    ["empty"],
    "null",
    ["items", "0"],
    '{"a":[1,null],"b":2}',
  ]);
  assert.match(compiled.where, / @> \$10::jsonb/);
});

test("JSON predicate values retain their full 32 levels inside query envelopes", () => {
  const value = nestedJson(limits.jsonDepth);
  const compiled = compileQuery(fields, {
    where: {
      and: [
        { field: "document", op: "pathEq", path: ["nested"], value },
        { or: [{ field: "document", op: "jsonContains", value }] },
      ],
    },
  });
  assert.equal(compiled.params[1], JSON.stringify(value));
  assert.equal(compiled.params[2], JSON.stringify(value));
  for (const op of ["pathEq", "jsonContains"] as const)
    fails(() =>
      compileQuery(fields, {
        where: {
          field: "document",
          op,
          ...(op === "pathEq" ? { path: ["nested"] } : {}),
          value: nestedJson(limits.jsonDepth + 1),
        },
      }),
    );
});

test("null tests are separate from equality and apply to every field type", () => {
  for (const field of fields) {
    assert.match(
      compileQuery(fields, { where: { field: field.name, op: "isNull" } })
        .where,
      / IS NULL$/,
    );
    assert.match(
      compileQuery(fields, { where: { field: field.name, op: "isNotNull" } })
        .where,
      / IS NOT NULL$/,
    );
  }
  fails(() =>
    compileQuery(fields, { where: { field: "name", op: "eq", value: null } }),
  );
});

test("invalid type/operator pairs and coercions fail before SQL execution", () => {
  for (const where of [
    { field: "number", op: "contains", value: 1 },
    { field: "active", op: "lt", value: false },
    { field: "document", op: "eq", value: {} },
    { field: "number", op: "eq", value: "1" },
    { field: "ratio", op: "eq", value: Infinity },
    { field: "date", op: "eq", value: "2023-02-29" },
    { field: "timestamp", op: "eq", value: "2026-10-02T10:00:00+01:00" },
    { field: "time", op: "eq", value: "25:00:00Z" },
  ] as FilterNode[])
    fails(() => compileQuery(fields, { where }));
});

test("in lists and ranges are bounded and parameterised", () => {
  const compiled = compileQuery(fields, {
    where: { field: "number", op: "in", value: [1, 2, 3] },
  });
  assert.match(compiled.where, / IN \(\$1, \$2, \$3\)$/);
  assert.deepEqual(compiled.params, [1, 2, 3]);
  fails(() =>
    compileQuery(fields, { where: { field: "number", op: "in", value: [] } }),
  );
  fails(() =>
    compileQuery(fields, {
      where: { field: "number", op: "in", value: Array(101).fill(1) },
    }),
  );
  fails(() =>
    compileQuery(fields, {
      where: { field: "number", op: "between", value: [2, 1] },
    }),
  );
});

test("query depth, predicate count, path length, sort and row caps hold at their boundaries", () => {
  let where: FilterNode = { field: "name", op: "eq", value: "x" };
  for (let index = 0; index < 7; index++) where = { and: [where] };
  compileQuery(fields, { where });
  fails(() => compileQuery(fields, { where: { and: [where] } }));
  compileQuery(fields, {
    where: {
      and: Array.from({ length: 100 }, () => ({
        field: "name",
        op: "eq",
        value: "x",
      })),
    },
  });
  fails(() =>
    compileQuery(fields, {
      where: {
        and: Array.from({ length: 101 }, () => ({
          field: "name",
          op: "eq",
          value: "x",
        })),
      },
    }),
  );
  compileQuery(fields, {
    where: { field: "document", op: "pathExists", path: Array(32).fill("a") },
  });
  fails(() =>
    compileQuery(fields, {
      where: { field: "document", op: "pathExists", path: Array(33).fill("a") },
    }),
  );
  fails(() =>
    compileQuery(fields, {
      orderBy: Array.from({ length: 9 }, () => ({
        field: "name",
        direction: "asc",
      })),
    }),
  );
  for (const limit of [1, 1_000, 5_000, 25_000])
    assert.equal(compileQuery(fields, { limit }).limit, limit);
  for (const limit of [0, -1, 25_001, 1.5])
    fails(() => compileQuery(fields, { limit }));
});

test("deep hostile filters fail within the bounded preflight before recursive parsing", () => {
  let where: FilterNode = { field: "name", op: "eq", value: "x" };
  for (let index = 0; index < 5_000; index++) where = { and: [where] };
  fails(() => compileQuery(fields, { where }));
});

test("aliases resolve to stable fields and query identity excludes page size and cursor", () => {
  const byKey = compileQuery(fields, {
    select: ["name"],
    where: { field: "number", op: "eq", value: 12 },
    orderBy: [{ field: "name", direction: "desc" }],
    limit: 1,
  });
  const byId = compileQuery(fields, {
    select: [id(1)],
    where: { field: id(2), op: "eq", value: 12 },
    orderBy: [{ field: id(1), direction: "desc" }],
    limit: 25_000,
    cursor: "opaque",
  });
  assert.equal(byId.queryHash, byKey.queryHash);
  assert.equal(byKey.sorts.at(-1)?.column, "row_id");
  assert.match(byKey.orderBy, / DESC NULLS LAST, "row_id" ASC NULLS LAST$/);
  fails(() => compileQuery(fields, { select: ["name", id(1)] }));
  fails(() =>
    compileQuery(fields, {
      orderBy: [
        { field: "name", direction: "asc" },
        { field: id(1), direction: "desc" },
      ],
    }),
  );
});

test("keyset comparison advances through equal values, nulls last, and ID tie-breakers", () => {
  const query = compileQuery(fields, {
    orderBy: [
      { field: "name", direction: "asc" },
      { field: "number", direction: "desc" },
    ],
  });
  const keyset = compileKeyset(query.sorts, ["same", null, id(20)], 4);
  assert.deepEqual(keyset.params, ["same", null, id(20)]);
  assert.match(keyset.where, / > \$4::text OR .* IS NULL/);
  assert.match(keyset.where, / IS NOT DISTINCT FROM \$4::text AND FALSE/);
  assert.match(
    keyset.where,
    / IS NOT DISTINCT FROM \$5::bigint AND \("row_id" > \$6::text\)/,
  );
  const descending = compileKeyset(query.sorts, ["same", 12, id(20)]);
  assert.match(descending.where, / < \$2::bigint OR .* IS NULL/);
  fails(() => compileKeyset(query.sorts, ["same", id(20)]));
  fails(() => compileKeyset(query.sorts, ["same", null, "invalid"]));
  fails(() => compileKeyset(query.sorts, ["same", null, id(20)], 0));
});

test("signed cursors round-trip and bind every authority/query attribute", () => {
  const codec = new CursorCodec("secret".repeat(8), { now: () => 1_000 });
  const tuple = ["same", null, id(20)];
  const cursor = codec.encode(binding, tuple);
  assert.deepEqual(codec.decode(cursor, binding), tuple);
  const variations: CursorBinding[] = [
    { ...binding, orgId: id(30) },
    { ...binding, tableId: id(31) },
    { ...binding, schemaVersion: 2 },
    { ...binding, membershipVersion: 4 },
    { ...binding, actorId: id(32) },
    { ...binding, queryHash: "b".repeat(64) },
  ];
  for (const variation of variations)
    fails(() => codec.decode(cursor, variation), "CURSOR_INVALID");
});

test("cursor envelope depth does not reduce the per-value JSON depth contract", () => {
  const codec = new CursorCodec("secret".repeat(8), { now: () => 1_000 });
  const tuple = [nestedJson(limits.jsonDepth), id(20)];
  const cursor = codec.encode(binding, tuple);
  assert.deepEqual(codec.decode(cursor, binding), tuple);
  fails(() =>
    codec.encode(binding, [nestedJson(limits.jsonDepth + 1), id(20)]),
  );
});

test("cursor payload/signature tampering and wrong signing keys reject", () => {
  const codec = new CursorCodec("secret".repeat(8), { now: () => 1_000 });
  const cursor = codec.encode(binding, [id(20)]);
  const [payload, signature] = cursor.split(".") as [string, string];
  const tampered = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload, "base64url").toString()),
      lastTuple: [id(99)],
    }),
  ).toString("base64url");
  fails(
    () => codec.decode(`${tampered}.${signature}`, binding),
    "CURSOR_INVALID",
  );
  fails(
    () => codec.decode(`${payload}.${signature.slice(0, -1)}A`, binding),
    "CURSOR_INVALID",
  );
  fails(
    () =>
      new CursorCodec("different".repeat(8), { now: () => 1_000 }).decode(
        cursor,
        binding,
      ),
    "CURSOR_INVALID",
  );
  for (const malformed of ["", "a.b", cursor + "=", cursor + ".extra"])
    fails(() => codec.decode(malformed, binding), "CURSOR_INVALID");
});

test("cursor expiry is inclusive and configuration does not allow weak secrets", () => {
  let now = 10_000;
  const codec = new CursorCodec("secret".repeat(8), {
    ttlMs: 1_000,
    now: () => now,
  });
  const cursor = codec.encode(binding, [id(20)]);
  now = 10_999;
  codec.decode(cursor, binding);
  now = 11_000;
  fails(() => codec.decode(cursor, binding), "CURSOR_INVALID");
  fails(() => new CursorCodec("short"), "CONFIGURATION_INVALID");
  fails(
    () => new CursorCodec("secret".repeat(8), { ttlMs: 0 }),
    "CONFIGURATION_INVALID",
  );
  fails(
    () =>
      new CursorCodec("secret".repeat(8), {
        ttlMs: limits.cursorLifetimeMs + 1,
      }),
    "CONFIGURATION_INVALID",
  );
});

test("complete pages, empty pages, and exact row boundaries report correct continuation", () => {
  const options = {
    limit: 2,
    byteLimit: limits.mcpResultBytes,
    schemaVersion: 1,
    cursorForRow,
  };
  const empty = buildPage([], options);
  assert.equal(empty.page.returned, 0);
  assert.equal(empty.page.hasMore, false);
  assert.equal(empty.page.nextCursor, null);
  const exact = buildPage([row(20), row(21)], options);
  assert.equal(exact.page.stopReason, "end");
  assert.equal(exact.page.hasMore, false);
  assert.equal(exact.page.nextCursor, null);
  const more = buildPage([row(20), row(21), row(22)], options);
  assert.deepEqual(
    more.data.map((value) => value.id),
    [id(20), id(21)],
  );
  assert.deepEqual(more.page, {
    returned: 2,
    requestedLimit: 2,
    hasMore: true,
    nextCursor: `cursor-${id(21)}`,
    stopReason: "row_limit",
    consistency: "live",
  });
});

test("byte limits include metadata, UTF-8, cursors, and complete rows with lossless resume", () => {
  const source = [
    row(20, "🙂".repeat(30)),
    row(21, "🙂".repeat(30)),
    row(22, "🙂".repeat(30)),
  ];
  const limit = 3;
  const single = buildPage(source, {
    limit: 1,
    byteLimit: limits.mcpResultBytes,
    schemaVersion: 1,
    cursorForRow,
  });
  const template: QueryResult = {
    ...single,
    page: { ...single.page, requestedLimit: limit, stopReason: "byte_limit" },
  };
  const envelope = { requestId: "trace" };
  const byteLimit = Buffer.byteLength(
    JSON.stringify({ ...envelope, ...template }),
  );
  const page = buildPage(source, {
    limit,
    byteLimit,
    schemaVersion: 1,
    cursorForRow,
    envelope,
  });
  assert.equal(page.data.length, 1);
  assert.equal(page.page.stopReason, "byte_limit");
  assert.equal(page.page.nextCursor, `cursor-${id(20)}`);
  assert.equal(
    Buffer.byteLength(JSON.stringify({ ...envelope, ...page })),
    byteLimit,
  );
  const rest = buildPage(source.slice(1), {
    limit,
    byteLimit: limits.mcpResultBytes,
    schemaVersion: 1,
    cursorForRow,
  });
  assert.deepEqual(
    [...page.data, ...rest.data].map((value) => value.id),
    source.map((value) => value.id),
  );
});

test("row sizes cannot produce an empty resumable page or exceed caps", () => {
  fails(
    () =>
      buildPage([row(20, "x".repeat(500))], {
        limit: 1,
        byteLimit: 250,
        schemaVersion: 1,
        cursorForRow,
      }),
    "PAYLOAD_TOO_LARGE",
  );
  fails(() =>
    buildPage([], {
      limit: 0,
      byteLimit: limits.mcpResultBytes,
      schemaVersion: 1,
      cursorForRow,
    }),
  );
  fails(() =>
    buildPage([], {
      limit: 1,
      byteLimit: limits.restResultBytes + 1,
      schemaVersion: 1,
      cursorForRow,
    }),
  );
});

test("the 25,000-row page cap preserves one-row lookahead without scanning total counts", () => {
  const source = Array.from({ length: 25_001 }, (_, index) =>
    row(index + 1, ""),
  );
  const result = buildPage(source, {
    limit: 25_000,
    byteLimit: limits.restResultBytes,
    schemaVersion: 1,
    cursorForRow,
  });
  assert.equal(result.data.length, 25_000);
  assert.equal(result.page.hasMore, true);
  assert.equal(result.page.nextCursor, cursorForRow(source[24_999]!));
  assert.equal(result.page.stopReason, "row_limit");
});

test(
  "PostgreSQL keyset pages traverse duplicate and NULL sort values without skips",
  {
    skip: !process.env.ROOTSET_TEST_DATABASE_URL,
  },
  async () => {
    const client = new pg.Client({
      connectionString: process.env.ROOTSET_TEST_DATABASE_URL,
    });
    await client.connect();
    try {
      const types = [
        'text COLLATE "C"',
        "bigint",
        "double precision",
        "boolean",
        "date",
        "time",
        "timestamptz",
        "jsonb",
      ];
      await client.query(
        `CREATE TEMPORARY TABLE rootset_query_test (row_id text COLLATE "C" PRIMARY KEY, ${fields.map((field, index) => `"${fieldColumn(field)}" ${types[index]}`).join(", ")})`,
      );
      const values = [
        { id: id(20), name: "same", number: 20 },
        { id: id(21), name: "same", number: null },
        { id: id(22), name: "same", number: 20 },
        { id: id(23), name: "same", number: 10 },
        { id: id(24), name: null, number: 20 },
        { id: id(25), name: null, number: null },
        { id: id(26), name: "other", number: null },
        { id: id(27), name: "a_%\\b", number: 30 },
      ];
      for (const [index, value] of values.entries())
        await client.query(
          `INSERT INTO rootset_query_test (row_id,"${fieldColumn(fields[0]!)}","${fieldColumn(fields[1]!)}","${fieldColumn(fields[2]!)}","${fieldColumn(fields[3]!)}","${fieldColumn(fields[4]!)}","${fieldColumn(fields[5]!)}","${fieldColumn(fields[6]!)}","${fieldColumn(fields[7]!)}") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            value.id,
            value.name,
            value.number,
            value.number === null ? null : value.number / 100,
            value.name === null ? null : index % 2 === 0,
            "2024-02-29",
            "08:09:10.100",
            "2026-10-02T08:09:10.100Z",
            JSON.stringify({
              string: "1",
              number: 1,
              empty: null,
              items: [false],
            }),
          ],
        );
      const scenarios = [
        { orderBy: undefined, ids: [20, 21, 22, 23, 24, 25, 26, 27] },
        {
          orderBy: [
            { field: "name", direction: "asc" as const },
            { field: "number", direction: "desc" as const },
          ],
          ids: [27, 26, 20, 22, 23, 21, 24, 25],
        },
        {
          orderBy: [
            { field: "name", direction: "desc" as const },
            { field: "number", direction: "asc" as const },
          ],
          ids: [23, 20, 22, 21, 26, 27, 24, 25],
        },
        {
          orderBy: [{ field: "ratio", direction: "asc" as const }],
          ids: [23, 20, 22, 24, 27, 21, 25, 26],
        },
        {
          orderBy: [{ field: "active", direction: "asc" as const }],
          ids: [21, 23, 27, 20, 22, 26, 24, 25],
        },
        {
          orderBy: [{ field: "date", direction: "asc" as const }],
          ids: [20, 21, 22, 23, 24, 25, 26, 27],
        },
        {
          orderBy: [{ field: "time", direction: "desc" as const }],
          ids: [20, 21, 22, 23, 24, 25, 26, 27],
        },
        {
          orderBy: [{ field: "timestamp", direction: "asc" as const }],
          ids: [20, 21, 22, 23, 24, 25, 26, 27],
        },
      ];
      for (const scenario of scenarios) {
        const compiled = compileQuery(fields, {
          ...(scenario.orderBy ? { orderBy: scenario.orderBy } : {}),
          limit: 2,
        });
        let tuple: JsonValue[] | undefined;
        const observed: string[] = [];
        for (let page = 0; page < 5; page++) {
          const keyset = tuple
            ? compileKeyset(compiled.sorts, tuple, compiled.params.length + 1)
            : { where: "TRUE", params: [] };
          const result = await client.query(
            `SELECT * FROM rootset_query_test WHERE (${compiled.where}) AND (${keyset.where}) ORDER BY ${compiled.orderBy} LIMIT 2`,
            [...compiled.params, ...keyset.params],
          );
          observed.push(...result.rows.map((value) => value.row_id as string));
          if (!result.rows.length) break;
          const last = result.rows.at(-1)!;
          tuple = compiled.sorts.map((sort) => {
            if (sort.type === "row_id") return last.row_id as string;
            const value = last[sort.column];
            if (value === null) return null;
            if (sort.type === "integer") return Number(value);
            if (sort.type === "date") {
              const date = value as Date;
              return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
            }
            if (sort.type === "date-time") return (value as Date).toISOString();
            if (sort.type === "time")
              return `${String(value).split(".")[0]}.${(String(value).split(".")[1] ?? "").padEnd(3, "0")}Z`;
            return value as JsonValue;
          });
        }
        assert.deepEqual(observed, scenario.ids.map(id));
        assert.equal(new Set(observed).size, values.length);
      }
      const cases: Array<{ where: FilterNode; count: number }> = [
        { where: { field: "name", op: "prefix", value: "a_%\\" }, count: 1 },
        {
          where: {
            field: "document",
            op: "pathEq",
            path: ["string"],
            value: "1",
          },
          count: 8,
        },
        {
          where: {
            field: "document",
            op: "pathEq",
            path: ["string"],
            value: 1,
          },
          count: 0,
        },
        {
          where: {
            field: "document",
            op: "pathEq",
            path: ["empty"],
            value: null,
          },
          count: 8,
        },
        {
          where: { field: "document", op: "pathExists", path: ["empty"] },
          count: 8,
        },
        {
          where: { field: "document", op: "pathExists", path: ["missing"] },
          count: 0,
        },
        {
          where: {
            field: "document",
            op: "pathEq",
            path: ["items", 0],
            value: false,
          },
          count: 8,
        },
        {
          where: {
            field: "document",
            op: "jsonContains",
            value: { number: 1 },
          },
          count: 8,
        },
        { where: { field: "time", op: "eq", value: "08:09:10.1Z" }, count: 8 },
        {
          where: {
            field: "timestamp",
            op: "eq",
            value: "2026-10-02T08:09:10.1Z",
          },
          count: 8,
        },
      ];
      for (const value of cases) {
        const compiled = compileQuery(fields, { where: value.where });
        const result = await client.query(
          `SELECT row_id FROM rootset_query_test WHERE ${compiled.where}`,
          compiled.params,
        );
        assert.equal(
          result.rows.length,
          value.count,
          JSON.stringify(value.where),
        );
      }
    } finally {
      await client.end();
    }
  },
);
