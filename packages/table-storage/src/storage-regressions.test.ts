import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createPool,
  migrate,
  withOrg,
  type Pool,
  type PoolClient,
} from "@rootset/database";
import {
  canonicalJson,
  limits,
  newId,
  rowBytes,
  RootsetError,
  type Actor,
  type QuerySpec,
  type Row,
} from "@rootset/contracts";
import {
  TableStorage,
  type MutationOptions,
  type MutationResult,
  type RowOperation,
  type TableRecord,
} from "./index.js";
import { operationAdmissionBinding } from "../../idempotency/src/index.js";

const configured = Boolean(process.env.ROOTSET_TEST_DATABASE_URL);
let owner: Pool | null = null,
  app: Pool | null = null,
  ddl: Pool | null = null,
  admin: Pool | null = null;
let storage: TableStorage | null = null;
const isolatedName = `rootset_storage_${newId().toLowerCase()}`;
const actor: Actor = {
  id: newId(),
  orgId: newId(),
  kind: "operator",
  role: "admin",
  scopes: ["*"],
};
let databaseId: string;
let schemaName: string;
before(async () => {
  if (!configured) return;
  const source = new URL(process.env.ROOTSET_TEST_DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname))
    throw new Error(
      "Disposable storage tests require a loopback PostgreSQL service",
    );
  admin = createPool(source.toString(), 1);
  await admin.query(`CREATE DATABASE "${isolatedName}" TEMPLATE template0`);
  const target = (key: string) => {
    const url = new URL(process.env[key]!);
    url.pathname = `/${isolatedName}`;
    return url.toString();
  };
  owner = createPool(target("ROOTSET_TEST_DATABASE_URL"), 1);
  app = createPool(target("ROOTSET_TEST_DATABASE_URL"), 4);
  ddl = createPool(target("ROOTSET_TEST_DATABASE_URL"), 2);
  await migrate(owner);
  storage = new TableStorage({
    pool: app,
    ddlPool: ddl,
    cursorSecret: "storage-regression-secret-longer-than-thirty-two-bytes",
  });
  await owner!.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [actor.orgId, "Storage numeric and transport regressions"],
  );
  const database = await storage!.createDatabase(actor, {
    name: "Regressions",
  });
  databaseId = database.id;
  schemaName = database.schemaName;
});
after(async () => {
  await Promise.all([owner?.end(), app?.end(), ddl?.end()]);
  if (admin) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}"`);
    } finally {
      await admin.end();
    }
  }
});

test(
  "URI, URL and image storage preserves arbitrary strings, filters, edits and cell history",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Unvalidated addresses",
      fields: [
        { name: "RESOURCE", type: "uri" },
        { name: "WEBSITE", type: "url" },
        { name: "PHOTO", type: "image" },
      ],
    });
    const initial = {
      RESOURCE: "custom:opaque identifier",
      WEBSITE: "not a URL",
      PHOTO: "https://example.org/photo.png",
    };
    const row = await storage!.createRow(actor, table.id, initial);
    assert.deepEqual(
      (await storage!.getRow(actor, table.id, row.id)).values,
      initial,
    );
    const page = await storage!.queryRows(actor, table.id, {
      where: { field: "WEBSITE", op: "contains", value: "not a" },
    });
    assert.equal(page.data[0]?.id, row.id);
    const next = await storage!.updateRow(
      actor,
      table.id,
      row.id,
      { RESOURCE: "relative/path", WEBSITE: "", PHOTO: "not an image URL" },
      { expectedVersion: row.version },
    );
    assert.deepEqual(next.values, {
      RESOURCE: "relative/path",
      WEBSITE: "",
      PHOTO: "not an image URL",
    });
    const history = await storage!.cellHistory(
      actor,
      table.id,
      row.id,
      table.fields[1]!.id,
    );
    assert.ok(history.data.length >= 1);
    await storage!.updateRow(
      actor,
      table.id,
      row.id,
      { RESOURCE: null, WEBSITE: null, PHOTO: null },
      { expectedVersion: next.version },
    );
    assert.deepEqual((await storage!.getRow(actor, table.id, row.id)).values, {
      RESOURCE: null,
      WEBSITE: null,
      PHOTO: null,
    });
  },
);

test(
  "PostgreSQL canonical numeric bytes match JavaScript finite-double vectors, including shortest-rounding boundaries",
  { skip: !configured },
  async () => {
    const values = [
      1e100,
      1e-100,
      1e-6,
      1e-7,
      1e20,
      1e21,
      1e23,
      -0,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      1.2345678901234567,
      9007199254740991,
    ];
    let seed = 58342911;
    for (let index = 0; index < 10000; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const mantissa = seed / 4294967296;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value =
        (mantissa + 0.001) * 10 ** ((seed % 625) - 316) * (index % 2 ? -1 : 1);
      if (Number.isFinite(value)) values.push(value);
    }
    const result = await owner!.query<{ canonical: string }>(
      "SELECT rootset_control.canonical_json(value) AS canonical FROM jsonb_array_elements($1::jsonb)",
      [JSON.stringify(values)],
    );
    assert.deepEqual(
      result.rows.map((row) => row.canonical),
      values.map((value) => canonicalJson(value)),
    );
    const table = await storage!.createTable(actor, databaseId, {
      name: "Float byte boundary",
      fields: [
        { name: "text", type: "text", charLimit: 65536 },
        { name: "float", type: "float" },
      ],
    });
    const text = "x".repeat(
      65536 - rowBytes(table.fields, { text: "", float: 1e23 }),
    );
    const row = await storage!.createRow(actor, table.id, {
      text,
      float: 1e23,
    });
    assert.equal(rowBytes(table.fields, row.values), 65536);
    await assert.rejects(
      storage!.updateRow(
        actor,
        table.id,
        row.id,
        { text: text + "x" },
        { expectedVersion: row.version },
      ),
      { code: "ROW_SIZE_LIMIT" },
    );
    assert.equal((await storage!.getRow(actor, table.id, row.id)).version, "1");
  },
);

test(
  "MCP-sized mutation rejection rolls back every row and audit event; worker mutations keep bounded outcomes",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Wide batch",
      fields: [
        { name: "text", type: "text", charLimit: 64000 },
        { name: "flag", type: "boolean" },
      ],
    });
    const rows = [];
    for (let index = 0; index < 20; index++)
      rows.push(
        await storage!.createRow(actor, table.id, {
          text: "x".repeat(60000),
          flag: false,
        }),
      );
    const operations = rows.map((row) => ({
      kind: "update" as const,
      rowId: row.id,
      expectedVersion: "1",
      values: { flag: true },
    }));
    await assert.rejects(
      storage!.mutateRows(actor, table.id, {
        operations,
        idempotencyKey: "wide-mcp",
        context: { source: "mcp" },
      }),
      { code: "PAYLOAD_TOO_LARGE" },
    );
    for (const row of rows) {
      const current = await storage!.getRow(actor, table.id, row.id);
      assert.equal(current.version, "1");
      assert.equal(current.values.flag, false);
    }
    const audit = await withOrg(app!, actor.orgId, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rootset_control.cell_changes WHERE table_id=$1 AND operation=$2",
        [table.id, "update"],
      ),
    );
    assert.equal(audit.rows[0]!.count, "0");
    const imported = await storage!.mutateRows(actor, table.id, {
      operations,
      idempotencyKey: "wide-import",
      context: { source: "import" },
    });
    assert.deepEqual(imported.rows, []);
    assert.ok(Buffer.byteLength(JSON.stringify(imported)) < 2048);
    assert.equal(
      (await storage!.getRow(actor, table.id, rows[0]!.id)).version,
      "2",
    );
    const first = await storage!.queryHistory(actor, table.id, {
      fieldId: table.fields[0]!.id,
      limit: 25000,
      byteLimit: 1024 * 1024,
    });
    assert.equal(first.hasMore, true);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024);
    const second = await storage!.queryHistory(actor, table.id, {
      fieldId: table.fields[0]!.id,
      limit: 25000,
      byteLimit: 1024 * 1024,
      cursor: first.nextCursor!,
    });
    assert.equal(second.hasMore, false);
    assert.equal(
      new Set([...first.data, ...second.data].map((event) => event.row_id))
        .size,
      20,
    );
  },
);

test(
  "Numeric zero window does not build ranked anchors or claim a filtered count",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Zero window",
      fields: [{ name: "code", type: "text" }],
    });
    await storage!.createRow(actor, table.id, { code: "match" });
    const result = await storage!.queryWindow(actor, table.id, {
      position: 0,
      query: { where: { field: "code", op: "eq", value: "match" }, limit: 200 },
    });
    assert.equal(result.totalRows, null);
    assert.equal(result.countKind, "unknown");
    assert.equal(result.estimatedTotalRows, null);
    assert.equal(result.anchorsReady, false);
    assert.equal(result.result.data.length, 1);
  },
);

test(
  "Filtered first windows include a bounded planner estimate without creating ranked anchors",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Estimated filter count",
      fields: [{ name: "code", type: "integer" }],
    });
    await storage!.mutateRows(actor, table.id, {
      operations: Array.from({ length: 100 }, (_, code) => ({
        kind: "create" as const,
        values: { code },
      })),
    });
    const query = {
      where: { field: "code", op: "gte" as const, value: 50 },
      limit: 10,
    };
    const first = await storage!.queryWindow(actor, table.id, { query });
    assert.equal(first.totalRows, null);
    assert.equal(first.countKind, "unknown");
    assert.equal(first.anchorsReady, false);
    assert(first.estimatedTotalRows !== null);
    assert(first.estimatedTotalRows >= 11 && first.estimatedTotalRows <= 100);
    assert.equal(first.result.data.length, 10);
    const next = await storage!.queryRows(actor, table.id, {
      ...query,
      cursor: first.result.page.nextCursor,
    });
    assert.equal(next.data.length, 10);
    assert.equal(
      new Set([...first.result.data, ...next.data].map((row) => row.id)).size,
      20,
    );
    const last = await storage!.queryWindow(actor, table.id, {
      query,
      position: "last",
      sessionId: first.sessionId,
    });
    assert.equal(last.totalRows, 50);
    assert.equal(last.estimatedTotalRows, null);
    assert.equal(last.countKind, "exact");
    assert.equal(last.anchorsReady, true);
  },
);

test(
  "Projection changes retain existing ranked window anchors without changing cursor binding",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Projection session",
      fields: [
        { name: "code", type: "text" },
        { name: "flag", type: "boolean" },
      ],
    });
    await storage!.mutateRows(actor, table.id, {
      operations: Array.from({ length: 6 }, (_, index) => ({
        kind: "create",
        values: { code: String(index), flag: index % 2 === 0 },
      })),
    });
    const first = await storage!.queryWindow(actor, table.id, {
      position: "middle",
      query: { select: ["code"], limit: 2 },
    });
    assert.equal(first.anchorsReady, true);
    const second = await storage!.queryWindow(actor, table.id, {
      position: "middle",
      sessionId: first.sessionId,
      query: { select: ["flag"], limit: 2 },
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.position, first.position);
    assert.deepEqual(
      second.result.data.map((row) => row.id),
      first.result.data.map((row) => row.id),
    );
    assert.deepEqual(Object.keys(second.result.data[0]!.values), ["flag"]);
    await assert.rejects(
      storage!.queryRows(actor, table.id, {
        select: ["flag"],
        limit: 2,
        cursor: first.result.page.nextCursor,
      }),
      { code: "CURSOR_INVALID" },
    );
  },
);

test(
  "Native ranked windows preserve rows, counts, and bindings across the 10000-row anchor boundary",
  { skip: !configured, timeout: 240_000 },
  async (t) => {
    const size = 10_037;
    const table = await storage!.createTable(actor, databaseId, {
      name: "Native anchor boundaries",
      fields: [
        {
          name: "ordinal",
          type: "integer",
          required: true,
        },
        { name: "bucket", type: "integer" },
      ],
    });
    const ordinal = table.fields.find((field) => field.name === "ordinal")!;
    const bucket = table.fields.find((field) => field.name === "bucket")!;
    assert.match(table.schemaName, /^rsd_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    assert.match(table.physicalName, /^rst_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    assert.match(ordinal.id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.match(bucket.id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const path = `"${table.schemaName}"."${table.physicalName}"`;
    const ordinalColumn = `"f_${ordinal.id.toLowerCase()}"`;
    const bucketColumn = `"f_${bucket.id.toLowerCase()}"`;
    for (let start = 0; start < size; start += 250) {
      await storage!.mutateRows(actor, table.id, {
        expectedSchemaVersion: table.schemaVersion,
        operations: Array.from(
          { length: Math.min(250, size - start) },
          (_, index) => {
            const value = start + index + 1;
            return {
              kind: "create" as const,
              values: {
                ordinal: value,
                bucket: value % 7 === 0 ? null : value % 3,
              },
            };
          },
        ),
      });
    }
    type NativeRow = {
      id: string;
      version: string;
      ordinal: number;
      bucket: number | null;
    };
    const nativeRows = (
      predicate = "TRUE",
      params: unknown[] = [],
      direction?: "ASC" | "DESC",
    ) =>
      withOrg(app!, actor.orgId, async (client) => {
        const result = await client.query<NativeRow>(
          `SELECT row_id AS id,row_version::text AS version,${ordinalColumn}::int AS ordinal,${bucketColumn}::int AS bucket FROM ${path} WHERE ${predicate} ORDER BY ${direction ? `${bucketColumn} ${direction} NULLS LAST,` : ""}row_id ASC`,
          params,
        );
        return result.rows;
      });
    const nativeState = () =>
      withOrg(app!, actor.orgId, async (client) => {
        const population = await client.query<{
          rows: string;
          revisions: string;
        }>(
          `SELECT count(*)::text AS rows,coalesce(sum(row_version),0)::text AS revisions FROM ${path}`,
        );
        const events = await client.query<{
          cellChanges: string;
        }>(
          'SELECT (SELECT count(*)::text FROM rootset_control.cell_changes WHERE table_id=$1) AS "cellChanges"',
          [table.id],
        );
        return { ...population.rows[0]!, ...events.rows[0]! };
      });
    const nativeAnchors = (sessionId: string) =>
      withOrg(app!, actor.orgId, async (client) => {
        const result = await client.query<{
          anchors: Record<string, unknown[]>;
        }>(
          "SELECT anchors FROM rootset_control.query_sessions WHERE id=$1 AND table_id=$2",
          [sessionId, table.id],
        );
        assert.equal(result.rows.length, 1);
        return result.rows[0]!.anchors;
      });
    const oracle = await nativeRows();
    assert.equal(oracle.length, size);
    assert.equal((await storage!.getTable(actor, table.id)).rowCount, size);
    const beforeQueries = await nativeState();
    const assertRows = (
      actual: Row[],
      expected: NativeRow[],
      select: ("ordinal" | "bucket")[] = ["ordinal", "bucket"],
    ) => {
      assert.deepEqual(
        actual.map((row) => ({
          id: row.id,
          version: row.version,
          values: row.values,
        })),
        expected.map((row) => ({
          id: row.id,
          version: row.version,
          values: Object.fromEntries(select.map((key) => [key, row[key]])),
        })),
      );
    };
    const first = await storage!.queryWindow(actor, table.id, {
      position: "first",
      query: { limit: 31 },
    });
    await t.test(
      "first window is anchor-free with the live native population",
      () => {
        assert.equal(first.position, 0);
        assert.equal(first.totalRows, size);
        assert.equal(first.tableRowCount, size);
        assert.equal(first.countKind, "live");
        assert.equal(first.anchorsReady, false);
        assertRows(first.result.data, oracle.slice(0, 31));
      },
    );
    for (const position of ["middle", "last"] as const) {
      await t.test(
        `${position} window returns native IDs, revisions, and values`,
        async () => {
          const window = await storage!.queryWindow(actor, table.id, {
            sessionId: first.sessionId,
            position,
            query: { limit: 31 },
          });
          const expectedPosition: number =
            position === "middle" ? Math.floor(size / 2) : size - 31;
          assert.equal(window.sessionId, first.sessionId);
          assert.equal(window.position, expectedPosition);
          assert.equal(window.totalRows, size);
          assert.equal(window.countKind, "live");
          assert.equal(window.anchorsReady, true);
          assertRows(
            window.result.data,
            oracle.slice(expectedPosition, expectedPosition + 31),
          );
        },
      );
    }
    await t.test(
      "persisted anchors retain the exact native rows at ranks zero and 10000",
      async () => {
        const anchors = await nativeAnchors(first.sessionId);
        assert.deepEqual(anchors["0"], [oracle[0]!.id]);
        assert.deepEqual(anchors["10000"], [oracle[10000]!.id]);
        assert.deepEqual(anchors.__count, [size]);
      },
    );
    for (const position of [9999, 10000, 10001]) {
      await t.test(
        `numeric position ${position} begins at the exact native rank`,
        async () => {
          const window = await storage!.queryWindow(actor, table.id, {
            sessionId: first.sessionId,
            position,
            query: { limit: 3 },
          });
          assert.equal(window.position, position);
          assertRows(window.result.data, oracle.slice(position, position + 3));
          assert.equal(window.result.page.hasMore, true);
          assert.ok(window.result.page.nextCursor);
          const next = await storage!.queryRows(actor, table.id, {
            limit: 3,
            cursor: window.result.page.nextCursor,
          });
          assertRows(next.data, oracle.slice(position + 3, position + 6));
        },
      );
    }
    await t.test(
      "projection changes reuse ranked anchors while cursor projection remains bound",
      async () => {
        const projected = await storage!.queryWindow(actor, table.id, {
          sessionId: first.sessionId,
          position: 10001,
          query: { select: ["bucket"], limit: 3 },
        });
        assert.equal(projected.sessionId, first.sessionId);
        assert.equal(projected.anchorsReady, true);
        assertRows(projected.result.data, oracle.slice(10001, 10004), [
          "bucket",
        ]);
        assert.ok(projected.result.page.nextCursor);
        const next = await storage!.queryRows(actor, table.id, {
          select: ["bucket"],
          limit: 3,
          cursor: projected.result.page.nextCursor,
        });
        assertRows(next.data, oracle.slice(10004, 10007), ["bucket"]);
        await assert.rejects(
          storage!.queryRows(actor, table.id, {
            select: ["ordinal"],
            limit: 3,
            cursor: projected.result.page.nextCursor,
          }),
          { code: "CURSOR_INVALID" },
        );
      },
    );
    await t.test(
      "window sessions remain bound to filter, sort, and authority",
      async () => {
        for (const query of [
          { where: { field: "ordinal", op: "gte", value: 10000 } },
          { orderBy: [{ field: "bucket", direction: "desc" }] },
        ] satisfies QuerySpec[]) {
          await assert.rejects(
            storage!.queryWindow(actor, table.id, {
              sessionId: first.sessionId,
              position: "middle",
              query,
            }),
            { code: "CURSOR_INVALID" },
          );
        }
        await assert.rejects(
          storage!.queryWindow(
            { ...actor, membershipVersion: (actor.membershipVersion ?? 0) + 1 },
            table.id,
            {
              sessionId: first.sessionId,
              position: "middle",
            },
          ),
          { code: "CURSOR_INVALID" },
        );
      },
    );
    await t.test(
      "filtered first remains unknown until an exact middle or last count is needed",
      async () => {
        const query: QuerySpec = {
          where: { field: "ordinal", op: "gte", value: 10000 },
          limit: 5,
        };
        const filteredOracle = await nativeRows(
          `${ordinalColumn}>=$1`,
          [10000],
        );
        assert.equal(filteredOracle.length, 38);
        const initial = await storage!.queryWindow(actor, table.id, {
          position: 0,
          query,
        });
        assert.equal(initial.totalRows, null);
        assert.equal(initial.countKind, "unknown");
        assert.equal(initial.anchorsReady, false);
        assertRows(initial.result.data, filteredOracle.slice(0, 5));
        for (const position of ["middle", "last"] as const) {
          const window = await storage!.queryWindow(actor, table.id, {
            sessionId: initial.sessionId,
            position,
            query,
          });
          const expectedPosition: number =
            position === "middle"
              ? Math.floor(filteredOracle.length / 2)
              : filteredOracle.length - 5;
          assert.equal(window.position, expectedPosition);
          assert.equal(window.totalRows, filteredOracle.length);
          assert.equal(window.countKind, "exact");
          assertRows(
            window.result.data,
            filteredOracle.slice(expectedPosition, expectedPosition + 5),
          );
        }
      },
    );
    await t.test(
      "a zero-match filtered middle and last report exact zero",
      async () => {
        const query: QuerySpec = {
          where: { field: "ordinal", op: "eq", value: -1 },
          limit: 5,
        };
        assert.equal((await nativeRows(`${ordinalColumn}=$1`, [-1])).length, 0);
        const middle = await storage!.queryWindow(actor, table.id, {
          position: "middle",
          query,
        });
        const last = await storage!.queryWindow(actor, table.id, {
          sessionId: middle.sessionId,
          position: "last",
          query,
        });
        for (const window of [middle, last]) {
          assert.equal(window.position, 0);
          assert.equal(window.totalRows, 0);
          assert.equal(window.countKind, "exact");
          assertRows(window.result.data, []);
        }
      },
    );
    await t.test(
      "nullable filters retain exact native counts and row values",
      async () => {
        const query: QuerySpec = {
          where: { field: "bucket", op: "isNull" },
          limit: 7,
        };
        const filteredOracle = await nativeRows(`${bucketColumn} IS NULL`);
        assert.equal(filteredOracle.length, Math.floor(size / 7));
        const middle = await storage!.queryWindow(actor, table.id, {
          position: "middle",
          query,
        });
        const last = await storage!.queryWindow(actor, table.id, {
          sessionId: middle.sessionId,
          position: "last",
          query,
        });
        for (const [window, expectedPosition] of [
          [middle, Math.floor(filteredOracle.length / 2)],
          [last, filteredOracle.length - 7],
        ] as const) {
          assert.equal(window.position, expectedPosition);
          assert.equal(window.totalRows, filteredOracle.length);
          assert.equal(window.countKind, "exact");
          assertRows(
            window.result.data,
            filteredOracle.slice(expectedPosition, expectedPosition + 7),
          );
        }
      },
    );
    for (const direction of ["asc", "desc"] as const) {
      await t.test(
        `${direction} nullable duplicate sorts preserve native rank and exact filtered count`,
        async (sortedTest) => {
          const query: QuerySpec = {
            where: { field: "ordinal", op: "gte", value: 1 },
            orderBy: [{ field: "bucket", direction }],
            limit: 3,
          };
          const sortedOracle = await nativeRows(
            `${ordinalColumn}>=$1`,
            [1],
            direction === "asc" ? "ASC" : "DESC",
          );
          const middle = await storage!.queryWindow(actor, table.id, {
            position: "middle",
            query,
          });
          assert.equal(middle.totalRows, size);
          assert.equal(middle.countKind, "exact");
          assertRows(
            middle.result.data,
            sortedOracle.slice(Math.floor(size / 2), Math.floor(size / 2) + 3),
          );
          const anchors = await nativeAnchors(middle.sessionId);
          assert.deepEqual(anchors["10000"], [
            sortedOracle[10000]!.bucket,
            sortedOracle[10000]!.id,
          ]);
          assert.deepEqual(anchors.__count, [size]);
          for (const position of [9999, 10000, 10001, "last"] as const) {
            await sortedTest.test(`position ${position}`, async () => {
              const window = await storage!.queryWindow(actor, table.id, {
                sessionId: middle.sessionId,
                position,
                query,
              });
              const expectedPosition: number =
                position === "last" ? size - 3 : position;
              assert.equal(window.position, expectedPosition);
              assert.equal(window.totalRows, sortedOracle.length);
              assertRows(
                window.result.data,
                sortedOracle.slice(expectedPosition, expectedPosition + 3),
              );
            });
          }
        },
      );
    }
    await t.test(
      "window reads leave native revisions and row/cell history unchanged",
      async () => {
        assert.deepEqual(await nativeState(), beforeQueries);
      },
    );
    await t.test(
      "unfiltered existing sessions use live native counts after create and delete",
      async () => {
        const extra = await storage!.createRow(actor, table.id, {
          ordinal: 20000,
          bucket: null,
        });
        try {
          const grownOracle = await nativeRows();
          assert.equal(grownOracle.length, size + 1);
          const grown = await storage!.queryWindow(actor, table.id, {
            sessionId: first.sessionId,
            position: "first",
            query: { limit: 31 },
          });
          assert.equal(grown.totalRows, grownOracle.length);
          assert.equal(grown.tableRowCount, grownOracle.length);
          assert.equal(grown.countKind, "live");
          assertRows(grown.result.data, grownOracle.slice(0, 31));
        } finally {
          await storage!.deleteRow(actor, table.id, extra.id, {
            expectedVersion: extra.version,
          });
        }
        const restoredOracle = await nativeRows();
        assert.equal(restoredOracle.length, size);
        const restored = await storage!.queryWindow(actor, table.id, {
          sessionId: first.sessionId,
          position: "first",
          query: { limit: 31 },
        });
        assert.equal(restored.totalRows, restoredOracle.length);
        assert.equal(restored.tableRowCount, restoredOracle.length);
        assertRows(restored.result.data, restoredOracle.slice(0, 31));
      },
    );
    await t.test(
      "schema changes invalidate old sessions and new first windows retain values",
      async () => {
        const updated = await storage!.updateField(
          actor,
          table.id,
          ordinal.id,
          {
            expectedSchemaVersion: table.schemaVersion,
          },
        );
        assert.equal(updated.schemaVersion, table.schemaVersion + 1);
        await assert.rejects(
          storage!.queryWindow(actor, table.id, {
            sessionId: first.sessionId,
            position: "middle",
          }),
          { code: "CURSOR_INVALID" },
        );
        const fresh = await storage!.queryWindow(actor, table.id, {
          position: "first",
          query: { limit: 31 },
        });
        assert.equal(fresh.result.schemaVersion, updated.schemaVersion);
        assertRows(fresh.result.data, (await nativeRows()).slice(0, 31));
      },
    );
  },
);

test(
  "Schema idempotency keys bind database and field path identities",
  { skip: !configured },
  async () => {
    const create = { name: "Database identity", idempotencyKey: newId() };
    const first = await storage!.createDatabase(actor, create);
    const second = await storage!.createDatabase(actor, {
      name: "Other database identity",
    });
    try {
      assert.equal((await storage!.createDatabase(actor, create)).id, first.id);
      const update = { name: "Updated database", idempotencyKey: newId() };
      await storage!.updateDatabase(actor, first.id, update);
      await assert.rejects(storage!.updateDatabase(actor, second.id, update), {
        code: "IDEMPOTENCY_CONFLICT",
      });
      const deletion = { idempotencyKey: newId() };
      await storage!.deleteDatabase(actor, first.id, deletion);
      await assert.rejects(
        storage!.deleteDatabase(actor, second.id, deletion),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      assert.equal(
        (await storage!.getDatabase(actor, second.id)).state,
        "active",
      );
      const table = await storage!.createTable(actor, databaseId, {
        name: "Field identity",
        fields: [
          { name: "first", type: "text" },
          { name: "second", type: "text" },
        ],
      });
      const patch = {
        name: "Updated",
        expectedSchemaVersion: 1,
        idempotencyKey: newId(),
      };
      await storage!.updateField(actor, table.id, table.fields[0]!.id, patch);
      await assert.rejects(
        storage!.updateField(actor, table.id, table.fields[1]!.id, patch),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      assert.equal(
        (
          await storage!.updateField(
            actor,
            table.id,
            table.fields[0]!.id,
            patch,
          )
        ).schemaVersion,
        2,
      );
      const remove = { expectedSchemaVersion: 2, idempotencyKey: newId() };
      await storage!.deleteField(actor, table.id, table.fields[0]!.id, remove);
      await assert.rejects(
        storage!.deleteField(actor, table.id, table.fields[1]!.id, remove),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      assert.equal(
        (
          await storage!.deleteField(
            actor,
            table.id,
            table.fields[0]!.id,
            remove,
          )
        ).fields.length,
        1,
      );
      const appended = await storage!.createField(actor, table.id, {
        name: "third",
        type: "text",
        expectedSchemaVersion: 3,
      });
      assert.deepEqual(
        appended.fields.map((field) => field.order),
        [0, 1],
      );
    } finally {
      await storage!.deleteDatabase(actor, first.id);
      await storage!.deleteDatabase(actor, second.id);
      await owner!.query(`DROP SCHEMA IF EXISTS "${first.schemaName}" CASCADE`);
      await owner!.query(
        `DROP SCHEMA IF EXISTS "${second.schemaName}" CASCADE`,
      );
    }
  },
);

test(
  "A depth-32 JSON cell survives mutation envelopes, projected queries, and idempotent replay after schema and row deletion",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Depth and durable replay",
      fields: [{ name: "data", type: "json" }],
    });
    let nested: import("@rootset/contracts").JsonValue = "leaf";
    for (let i = 0; i < 32; i++) nested = [nested];
    const options = {
      idempotencyKey: "nested32",
      expectedSchemaVersion: table.schemaVersion,
    };
    const row = await storage!.createRow(
      actor,
      table.id,
      { data: nested },
      options,
    );
    assert.deepEqual(row.values.data, nested);
    const page = await storage!.queryRows(actor, table.id, {
      select: ["data"],
      limit: 1,
    });
    assert.deepEqual(page.data[0]!.values.data, nested);
    const advanced = await storage!.createField(actor, table.id, {
      name: "flag",
      type: "boolean",
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage!.createRow(actor, table.id, { data: nested }, options)).id,
      row.id,
    );
    await storage!.deleteRow(actor, table.id, row.id, {
      expectedVersion: row.version,
    });
    assert.equal(
      (await storage!.createRow(actor, table.id, { data: nested }, options)).id,
      row.id,
    );
    assert.equal((await storage!.getTable(actor, table.id)).rowCount, 0);
    await storage!.deleteTable(actor, table.id, {
      expectedSchemaVersion: advanced.schemaVersion,
    });
    assert.equal(
      (await storage!.createRow(actor, table.id, { data: nested }, options)).id,
      row.id,
    );
  },
);

async function runningJob(targetId: string, operationId = "createField") {
  const jobId = newId(),
    leaseToken = newId();
  await withOrg(owner!, actor.orgId, (c) =>
    c.query(
      "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key,state,lease_token,lease_until) VALUES($1,$2,'operation',$3,$4::jsonb,$5,'table',$6,'{}','hash',$7,'running',$8,clock_timestamp()+interval '5 minutes')",
      [
        jobId,
        actor.orgId,
        operationId,
        JSON.stringify(actor),
        actor.id,
        targetId,
        `lease-${jobId}`,
        leaseToken,
      ],
    ),
  );
  return { jobId, leaseToken };
}

const suppliedRepairActor: Actor = { ...actor, userId: actor.id };
async function repairOptions(
  tableId: string,
  operations: RowOperation[],
  reason = "Correct the verified source value",
): Promise<MutationOptions> {
  const fence = { jobId: newId(), leaseToken: newId() },
    table = await storage!.getTable(actor, tableId),
    originalKey = `direct-repair-${fence.jobId}`,
    requestId = `repair-request-${fence.jobId}`,
    admittedActor = { ...suppliedRepairActor, membershipVersion: 1 },
    publicInput = {
      orgId: actor.orgId,
      databaseId: table.databaseId,
      tableId,
      expectedSchemaVersion: table.schemaVersion,
      mutations: operations.map((operation) => {
        assert(operation.kind === "update");
        return {
          type: "update",
          rowId: operation.rowId,
          expectedVersion: operation.expectedVersion,
          values: operation.values,
        };
      }),
      repair: { reason },
    },
    admission = {
      source: "mcp",
    },
    operationContext = {
      idempotencyKey: originalKey,
      requestId,
      source: "operator",
      admissionBinding: operationAdmissionBinding(
        admittedActor,
        "mutateRows",
        publicInput,
        originalKey,
        "trusted-storage-fixture-admission-secret-at-least32-bytes",
        admission,
      ),
      admissionFields: Object.keys(publicInput).sort(),
      admissionSource: admission.source,
    },
    input = { ...publicInput, operationContext },
    requester = `${admittedActor.kind}:${admittedActor.id}`;
  const { requestId: omittedRequest, ...durableContext } = operationContext;
  assert.equal(omittedRequest, requestId);
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        actor: requester,
        orgId: actor.orgId,
        operationId: "mutateRows",
        target: { type: "table", id: tableId },
        input: { ...publicInput, operationContext: durableContext },
      }),
    )
    .digest("hex");
  await withOrg(owner!, actor.orgId, (c) =>
    c.query(
      "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key,state,lease_token,lease_until) VALUES($1,$2,'operation','mutateRows',$3::jsonb,$4,'table',$5,$6::jsonb,$7,$8,'running',$9,clock_timestamp()+interval '5 minutes')",
      [
        fence.jobId,
        actor.orgId,
        JSON.stringify(admittedActor),
        requester,
        tableId,
        JSON.stringify(input),
        digest,
        originalKey,
        fence.leaseToken,
      ],
    ),
  );
  return {
    idempotencyKey: `job:${fence.jobId}:operation`,
    expectedSchemaVersion: table.schemaVersion,
    context: {
      requestId,
      source: "operator",
      jobId: fence.jobId,
      jobFence: fence,
      repair: {
        reason,
        jobId: fence.jobId,
      },
      beforePublish: async () => undefined,
    },
    onCommit: async (client, outcome) => {
      const role = (
        await client.query(
          "SELECT current_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged",
        )
      ).rows[0]!;
      assert.deepEqual(role, {
        current_user: new URL(process.env.ROOTSET_TEST_DATABASE_URL!).username,
        privileged: false,
      });
      await client.query(
        "INSERT INTO rootset_control.operation_outcomes(job_id,org_id,operation_id,job_input_digest,result) SELECT id,org_id,operation_id,input_digest,$2::jsonb FROM rootset_control.jobs WHERE id=$1 ON CONFLICT(job_id) DO NOTHING",
        [fence.jobId, JSON.stringify(outcome)],
      );
    },
  };
}
async function repairState(table: TableRecord): Promise<string> {
  const data: Record<string, unknown> = {
    table: await storage!.getTable(actor, table.id),
  };
  data.rows = (
    await owner!.query(
      `SELECT to_jsonb(r) AS value FROM "${table.schemaName}"."${table.physicalName}" r ORDER BY row_id`,
    )
  ).rows;
  for (const relation of [
    "cell_changes",
    "mutations",
    "resource_history",
    "unique_rules",
    "schema_operations",
  ])
    data[relation] = (
      await owner!.query(
        `SELECT to_jsonb(r) AS value FROM rootset_control.${relation} r WHERE table_id=$1 ORDER BY id`,
        [table.id],
      )
    ).rows;
  data.entries = (
    await owner!.query(
      "SELECT rule_id,row_id,tuple,digest FROM rootset_control.unique_entries WHERE rule_id IN(SELECT id FROM rootset_control.unique_rules WHERE table_id=$1) ORDER BY rule_id,row_id",
      [table.id],
    )
  ).rows;
  data.outcomes = (
    await owner!.query(
      "SELECT to_jsonb(o) AS value FROM rootset_control.operation_outcomes o JOIN rootset_control.jobs j ON j.id=o.job_id WHERE j.target_id=$1 ORDER BY o.job_id",
      [table.id],
    )
  ).rows;
  return canonicalJson(data, { maxDepth: 96 });
}

async function assertRepairCapability(
  table: TableRecord,
  options: MutationOptions,
  result: MutationResult,
) {
  const permissions = (
    await owner!.query(
      "SELECT p.prosecdef,(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='rootset_control.resource_history'::regclass) forced_rls FROM pg_proc p WHERE p.oid='rootset_control.append_operator_repair_completion(varchar,varchar,varchar,varchar)'::regprocedure",
    )
  ).rows[0];
  assert.equal(permissions.prosecdef, false);
  assert.equal(permissions.forced_rls, true);
  const fence = options.context!.jobFence!,
    args = [actor.orgId, fence.jobId, fence.leaseToken, result.mutationId],
    sql =
      "SELECT rootset_control.append_operator_repair_completion($1,$2,$3,$4)",
    baseline = await repairState(table);
  await withOrg(app!, actor.orgId, (c) => c.query(sql, args));
  assert.equal(await repairState(table), baseline);
  async function denied(
    prepare: (client: PoolClient) => Promise<unknown> = async () => undefined,
    bound = args,
    statement = sql,
    organisation = actor.orgId,
  ) {
    const client = await owner!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rootset.org_id',$1,true)", [
        actor.orgId,
      ]);
      await prepare(client);
      await client.query("SELECT set_config('rootset.org_id',$1,true)", [
        organisation,
      ]);
      assert.equal(
        (await client.query("SELECT current_user AS role")).rows[0]!.role,
        new URL(process.env.ROOTSET_TEST_DATABASE_URL!).username,
      );
      await assert.rejects(client.query(statement, bound), { code: "42501" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.equal(await repairState(table), baseline);
  }
  await denied(undefined, [
    actor.orgId,
    fence.jobId,
    newId(),
    result.mutationId,
  ]);
  await denied(undefined, [
    actor.orgId,
    fence.jobId,
    fence.leaseToken,
    newId(),
  ]);
  await denied(undefined, [
    newId(),
    fence.jobId,
    fence.leaseToken,
    result.mutationId,
  ]);
  await denied(undefined, args, sql, newId());
  for (const key of ["orgId", "databaseId", "tableId", "expectedSchemaVersion"])
    await denied((c) =>
      c.query("UPDATE rootset_control.jobs SET input=input-$2 WHERE id=$1", [
        fence.jobId,
        key,
      ]),
    );
  for (const expectedSchemaVersion of ["1", 0, 1.5, 2147483648])
    await denied((c) =>
      c.query(
        "UPDATE rootset_control.jobs SET input=jsonb_set(input,'{expectedSchemaVersion}',$2::jsonb) WHERE id=$1",
        [fence.jobId, JSON.stringify(expectedSchemaVersion)],
      ),
    );
  for (const [path, value] of [
    ["{operationContext,admissionSource}", "worker"],
    ["{operationContext,admissionBinding}", "invalid"],
    ["{operationContext,requestId}", "different original request"],
    ["{mutations,0,expectedVersion}", "0"],
    ["{mutations,0,expectedVersion}", "9223372036854775808"],
    ["{mutations,0,expectedVersion}", 1],
    ["{mutations,0,type}", "delete"],
    ["{repair,reason}", "p".repeat(513)],
    ["{repair,reason}", "🙂".repeat(257)],
    ["{repair,reason}", "\u00a0untrimmed"],
  ] as const)
    await denied((c) =>
      c.query(
        "UPDATE rootset_control.jobs SET input=jsonb_set(input,$2::text[],$3::jsonb) WHERE id=$1",
        [fence.jobId, path, JSON.stringify(value)],
      ),
    );
  await denied((c) =>
    c.query(
      "UPDATE rootset_control.jobs SET input=input #- '{mutations,0,expectedVersion}' WHERE id=$1",
      [fence.jobId],
    ),
  );
  await denied((c) =>
    c.query(
      "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
      [fence.jobId],
    ),
  );
  await denied((c) =>
    c.query(
      "UPDATE rootset_control.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [fence.jobId],
    ),
  );
  await denied((c) =>
    c.query(
      "UPDATE rootset_control.jobs SET actor=jsonb_set(actor,'{credentialId}',to_jsonb($2::text)) WHERE id=$1",
      [fence.jobId, newId()],
    ),
  );
  await denied((c) =>
    c.query(
      "UPDATE rootset_control.mutations SET actor=jsonb_set(actor,'{kind}','\"invented\"') WHERE id=$1",
      [result.mutationId],
    ),
  );
  await denied((c) =>
    c.query("UPDATE rootset_control.mutations SET outcome=NULL WHERE id=$1", [
      result.mutationId,
    ]),
  );
  await denied((c) =>
    c.query(
      "INSERT INTO rootset_control.resource_history(org_id,database_id,table_id,resource_id,operation,before_value,after_value,actor,context) SELECT org_id,database_id,table_id,resource_id,operation,before_value,after_value,actor,context FROM rootset_control.resource_history WHERE table_id=$1 AND operation='operatorRepair'",
      [table.id],
    ),
  );
  await denied((c) =>
    c.query(
      "UPDATE rootset_control.resource_history SET after_value=jsonb_set(after_value,'{reason}','\"conflicting completion\"') WHERE table_id=$1 AND operation='operatorRepair'",
      [table.id],
    ),
  );
}

test(
  "Supplied direct repair commits native history, one redacted completion and durable outcome together; replay and no-op preserve exact effects",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Native repair completion",
      fields: [
        { name: "value", type: "integer" },
        { name: "original", type: "json" },
      ],
    });
    const original = { context: "literal original value", source: "original" };
    const row = await storage!.createRow(actor, table.id, {
      value: 1,
      original,
    });
    const operations: RowOperation[] = [
      {
        kind: "update",
        rowId: row.id,
        expectedVersion: "1",
        values: { value: 2 },
      },
    ];
    const input = {
      ...(await repairOptions(table.id, operations, "r".repeat(512))),
      operations,
    };
    input.context!.repair!.reason = `  ${"r".repeat(512)}  `;
    const refreshedActor = { ...suppliedRepairActor, membershipVersion: 2 };
    const result = await storage!.mutateRows(refreshedActor, table.id, input);
    assert.equal(result.rows[0]!.version, "2");
    assert.deepEqual(result.rows[0]!.values, { value: 2, original });
    const cells = (
      await owner!.query(
        "SELECT old_value,new_value,old_version::text,new_version::text,actor,context FROM rootset_control.cell_changes WHERE mutation_id=$1",
        [result.mutationId],
      )
    ).rows;
    assert.equal(cells.length, 1);
    assert.deepEqual(
      {
        old: cells[0]!.old_value,
        next: cells[0]!.new_value,
        previousVersion: cells[0]!.old_version,
        version: cells[0]!.new_version,
      },
      { old: 1, next: 2, previousVersion: "1", version: "2" },
    );
    assert.deepEqual(cells[0]!.actor, refreshedActor);
    assert.deepEqual(cells[0]!.context, {
      requestId: input.context!.requestId,
      source: "operator",
      jobId: input.context!.jobId,
    });
    const events = (
      await owner!.query(
        "SELECT operation,before_value,after_value,actor,context FROM rootset_control.resource_history WHERE table_id=$1 AND operation='operatorRepair'",
        [table.id],
      )
    ).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.before_value, null);
    assert.deepEqual(events[0]!.after_value, {
      ...input.context!.repair,
      reason: "r".repeat(512),
      mutationId: result.mutationId,
    });
    assert.deepEqual(events[0]!.actor, refreshedActor);
    assert.equal(
      (
        await owner!.query(
          "SELECT result FROM rootset_control.operation_outcomes WHERE job_id=$1",
          [input.context!.jobId],
        )
      ).rows[0]!.result.mutationId,
      result.mutationId,
    );
    await assertRepairCapability(table, input, result);
    const before = await repairState(table);
    assert.deepEqual(
      await storage!.mutateRows(refreshedActor, table.id, input),
      result,
    );
    assert.equal(await repairState(table), before);
    assert.deepEqual(
      await storage!.mutateRows(refreshedActor, table.id, {
        ...input,
        context: {
          ...input.context!,
          repair: { ...input.context!.repair!, reason: "r".repeat(512) },
        },
      }),
      result,
    );
    assert.equal(await repairState(table), before);
    await assert.rejects(
      storage!.mutateRows(refreshedActor, table.id, {
        ...input,
        context: {
          ...input.context!,
          repair: {
            ...input.context!.repair!,
            reason: "A different business reason",
          },
        },
      }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    assert.equal(await repairState(table), before);
    const noOpOperations: RowOperation[] = [
      {
        kind: "update",
        rowId: row.id,
        expectedVersion: "2",
        values: { value: 2 },
      },
    ];
    const noOp = {
      ...(await repairOptions(table.id, noOpOperations)),
      operations: noOpOperations,
    };
    const unchanged = await storage!.mutateRows(
      suppliedRepairActor,
      table.id,
      noOp,
    );
    assert.equal(unchanged.rows[0]!.version, "2");
    assert.equal(
      (
        await owner!.query(
          "SELECT count(*)::int n FROM rootset_control.cell_changes WHERE table_id=$1",
          [table.id],
        )
      ).rows[0]!.n,
      3,
    );
    assert.equal(
      (
        await owner!.query(
          "SELECT count(*)::int n FROM rootset_control.resource_history WHERE table_id=$1 AND operation='operatorRepair'",
          [table.id],
        )
      ).rows[0]!.n,
      2,
    );
    const persisted = await repairState(table);
    assert(!persisted.includes(input.context!.jobFence!.leaseToken));
    assert(!persisted.includes("beforePublish"));
    assert(!persisted.includes("onCommit"));
    const peer = newId();
    assert.equal(
      (
        await withOrg(app!, peer, (c) =>
          c.query(
            "SELECT id FROM rootset_control.resource_history WHERE table_id=$1",
            [table.id],
          ),
        )
      ).rowCount,
      0,
    );
  },
);

test(
  "Repair callback failure, late stale/unique members, lost authority and invalid live worker fences atomically reject every native and completion effect",
  { skip: !configured },
  async () => {
    let table = await storage!.createTable(actor, databaseId, {
      name: "Repair rollback",
      fields: [
        { name: "code", type: "text", charLimit: 20 },
        { name: "value", type: "integer" },
      ],
    });
    await storage!.createUniqueRule(actor, table.id, {
      expectedSchemaVersion: 1,
      fieldIds: [table.fields[0]!.id],
    });
    table = await storage!.getTable(actor, table.id);
    const a = await storage!.createRow(actor, table.id, {
        code: "a",
        value: 1,
      }),
      b = await storage!.createRow(actor, table.id, { code: "b", value: 2 });
    const operations: RowOperation[] = [
      {
        kind: "update",
        rowId: a.id,
        expectedVersion: "1",
        values: { value: 3 },
      },
    ];
    async function refused(
      input: MutationOptions & { operations: RowOperation[] },
      code: string,
      incoming = suppliedRepairActor,
    ) {
      const before = await repairState(table);
      await assert.rejects(storage!.mutateRows(incoming, table.id, input), {
        code,
      });
      assert.equal(await repairState(table), before);
    }
    const invalidActor = await repairOptions(table.id, operations);
    await refused(
      {
        ...invalidActor,
        operations,
        context: {
          ...invalidActor.context!,
          repair: { ...invalidActor.context!.repair!, reason: "r".repeat(513) },
        },
      },
      "VALIDATION_FAILED",
    );
    await refused(
      { ...invalidActor, operations, expectedSchemaVersion: undefined },
      "VALIDATION_FAILED",
    );
    await refused({ ...invalidActor, operations }, "OPERATOR_REQUIRED", {
      ...suppliedRepairActor,
      role: "viewer",
    });
    await refused({ ...invalidActor, operations }, "OPERATOR_REQUIRED", {
      ...suppliedRepairActor,
      role: "member",
    });
    await refused(
      { ...invalidActor, operations, onCommit: undefined },
      "ACCESS_DENIED",
    );
    await refused(
      {
        ...invalidActor,
        operations,
        context: {
          ...invalidActor.context!,
          repair: { ...invalidActor.context!.repair!, jobId: newId() },
        },
      },
      "ACCESS_DENIED",
    );
    await refused(
      {
        ...invalidActor,
        operations: [
          { kind: "create", values: { code: "not a repair", value: 5 } },
        ],
      },
      "VALIDATION_FAILED",
    );
    const failed = await repairOptions(table.id, operations),
      saved = failed.onCommit!;
    await refused(
      {
        ...failed,
        operations,
        onCommit: async (c, outcome) => {
          await saved(c, outcome);
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int n FROM rootset_control.resource_history WHERE table_id=$1 AND operation='operatorRepair'",
                [table.id],
              )
            ).rows[0]!.n,
            1,
          );
          throw new RootsetError("INTERNAL_ERROR", "Fail before commit", 500);
        },
      },
      "INTERNAL_ERROR",
    );
    let callbacks = 0;
    const stale = await repairOptions(table.id, operations);
    const input = {
      ...stale,
      onCommit: async () => {
        callbacks++;
      },
      operations,
    };
    await refused(
      {
        ...input,
        operations: [
          ...operations,
          {
            kind: "update",
            rowId: b.id,
            expectedVersion: "999",
            values: { value: 4 },
          },
        ],
      },
      "ROW_VERSION_CONFLICT",
    );
    await refused(
      {
        ...input,
        operations: [
          ...operations,
          {
            kind: "update",
            rowId: b.id,
            expectedVersion: "1",
            values: { code: "a" },
          },
        ],
      },
      "UNIQUE_CONFLICT",
    );
    await refused(
      {
        ...input,
        context: {
          ...input.context!,
          beforePublish: async () => {
            throw new RootsetError(
              "ACCESS_DENIED",
              "Current target authority revoked",
              403,
            );
          },
        },
      },
      "ACCESS_DENIED",
    );
    await owner!.query(
      "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
      [input.context!.jobId],
    );
    await refused(input, "JOB_LEASE_LOST");
    assert.equal(callbacks, 0);
    const committed = {
        ...(await repairOptions(table.id, operations)),
        operations,
      },
      outcome = await storage!.mutateRows(
        suppliedRepairActor,
        table.id,
        committed,
      ),
      afterCommit = await repairState(table);
    await refused(
      {
        ...committed,
        context: {
          ...committed.context!,
          beforePublish: async () => {
            throw new RootsetError(
              "ACCESS_DENIED",
              "Replay target authority revoked",
              403,
            );
          },
        },
      },
      "ACCESS_DENIED",
    );
    await owner!.query(
      "UPDATE rootset_control.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [committed.context!.jobId],
    );
    await refused(committed, "JOB_LEASE_LOST");
    assert.equal(await repairState(table), afterCommit);
    assert.equal((await storage!.getRow(actor, table.id, a.id)).version, "2");
    assert.equal(outcome.rows[0]!.values.value, 3);
  },
);

test(
  "Trusted repair response cap rejects oversized results before commit and preserves operator audit, bounded replay and ordinary mutation budgets",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Repair response budget",
      fields: [
        { name: "text", type: "text", charLimit: 64000 },
        { name: "flag", type: "boolean" },
      ],
    });
    const rows = [];
    for (let index = 0; index < 20; index++)
      rows.push(
        await storage!.createRow(actor, table.id, {
          text: "x".repeat(60000),
          flag: false,
        }),
      );
    let callbacks = 0;
    const operations = rows.map((row) => ({
        kind: "update" as const,
        rowId: row.id,
        expectedVersion: row.version,
        values: { flag: true },
      })),
      options = await repairOptions(table.id, operations),
      saved = options.onCommit!,
      input = {
        ...options,
        responseBudget: limits.mcpResultBytes - 1024,
        onCommit: async (client: PoolClient, outcome: MutationResult) => {
          callbacks++;
          await saved(client, outcome);
        },
        operations,
      },
      before = await repairState(table);
    for (const responseBudget of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      limits.restResultBytes + 1,
    ]) {
      await assert.rejects(
        storage!.mutateRows(suppliedRepairActor, table.id, {
          ...input,
          responseBudget,
        }),
        { code: "VALIDATION_FAILED" },
      );
      assert.equal(await repairState(table), before);
    }
    await assert.rejects(
      storage!.mutateRows(actor, table.id, {
        operations: input.operations,
        context: { source: "mcp" },
        responseBudget: limits.mcpResultBytes + 1,
      }),
      { code: "VALIDATION_FAILED" },
    );
    assert.equal(await repairState(table), before);
    await assert.rejects(
      storage!.mutateRows(suppliedRepairActor, table.id, input),
      { code: "PAYLOAD_TOO_LARGE" },
    );
    assert.equal(callbacks, 0);
    assert.equal(await repairState(table), before);
    const boundedOperations = operations.slice(0, 16),
      boundedOptions = await repairOptions(table.id, boundedOperations),
      bounded = {
        ...boundedOptions,
        responseBudget: input.responseBudget,
        operations: boundedOperations,
        onCommit: async (client: PoolClient, outcome: MutationResult) => {
          callbacks++;
          await boundedOptions.onCommit!(client, outcome);
        },
      },
      result = await storage!.mutateRows(
        suppliedRepairActor,
        table.id,
        bounded,
      );
    assert.equal(result.rows.length, 16);
    assert.equal(callbacks, 1);
    assert(
      Buffer.byteLength(JSON.stringify(result)) +
        2048 +
        bounded.operations.length * 200 <=
        bounded.responseBudget,
    );
    const committed = await repairState(table);
    assert(!committed.includes("responseBudget"));
    assert.deepEqual(
      await storage!.mutateRows(suppliedRepairActor, table.id, {
        ...bounded,
        responseBudget: limits.mcpResultBytes - 2048,
      }),
      result,
    );
    assert.equal(callbacks, 2);
    assert.equal(await repairState(table), committed);
    await assert.rejects(
      storage!.mutateRows(suppliedRepairActor, table.id, {
        ...bounded,
        responseBudget: 128,
      }),
      { code: "PAYLOAD_TOO_LARGE" },
    );
    assert.equal(callbacks, 2);
    assert.equal(await repairState(table), committed);
    const audit = (
      await owner!.query(
        "SELECT context FROM rootset_control.cell_changes WHERE mutation_id=$1 UNION ALL SELECT context FROM rootset_control.resource_history WHERE table_id=$2 AND operation='operatorRepair'",
        [result.mutationId, table.id],
      )
    ).rows;
    assert.equal(audit.length, 17);
    for (const event of audit)
      assert.deepEqual(event.context, {
        requestId: bounded.context!.requestId,
        source: "operator",
        jobId: bounded.context!.jobId,
      });
    const ordinary = await storage!.mutateRows(actor, table.id, {
      idempotencyKey: `ordinary-${newId()}`,
      operations: rows.map((row, index) => ({
        kind: "update" as const,
        rowId: row.id,
        expectedVersion: index < 16 ? "2" : "1",
        values: { flag: false },
      })),
    });
    assert.equal(ordinary.rows.length, 20);
    assert(Buffer.byteLength(JSON.stringify(ordinary)) > limits.mcpResultBytes);
    assert.equal(
      (
        await owner!.query(
          "SELECT count(*)::int n FROM rootset_control.resource_history WHERE table_id=$1 AND operation='operatorRepair'",
          [table.id],
        )
      ).rows[0]!.n,
      1,
    );
  },
);

test(
  "Concurrent repair retry exercises the locked native replay branch and invokes fenced idempotent outcome hooks without duplicate completion or cell history",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Concurrent repair receipt",
      fields: [{ name: "value", type: "integer" }],
    });
    const row = await storage!.createRow(actor, table.id, { value: 1 });
    const operations: RowOperation[] = [
        {
          kind: "update",
          rowId: row.id,
          expectedVersion: "1",
          values: { value: 2 },
        },
      ],
      options = await repairOptions(table.id, operations),
      input = {
        ...options,
        responseBudget: limits.mcpResultBytes - 1024,
        operations,
      };
    let reached = 0,
      release!: () => void,
      abort!: (error: Error) => void,
      lockedReplay = 0,
      callbacks = 0;
    const together = new Promise<void>((resolve, reject) => {
      release = resolve;
      abort = reject;
    });
    void together.catch(() => undefined);
    const deadline = setTimeout(
      () => abort(new Error("Both actual repair dispatches did not arrive")),
      limits.queryTimeoutMs,
    );
    const observedPool = new Proxy(app!, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(c, member) {
                if (member === "query")
                  return async (sql: string, params?: unknown[]) => {
                    const result = await c.query(sql, params);
                    if (
                      sql.startsWith(
                        "SELECT input_hash,outcome FROM rootset_control.mutations",
                      ) &&
                      params?.[2] === input.idempotencyKey
                    ) {
                      assert.equal(result.rowCount, 0);
                      if (++reached === 2) release();
                      await together;
                    }
                    if (
                      sql.startsWith(
                        "SELECT * FROM rootset_control.mutations WHERE",
                      ) &&
                      params?.[2] === input.idempotencyKey &&
                      result.rows[0]?.outcome
                    )
                      lockedReplay++;
                    return result;
                  };
                const value = Reflect.get(c, member);
                return typeof value === "function" ? value.bind(c) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observed = new TableStorage({
        pool: observedPool,
        ddlPool: ddl!,
        cursorSecret: "repair-concurrent-replay-secret-at-least32-bytes",
      }),
      saved = input.onCommit!;
    input.onCommit = async (client, outcome: MutationResult) => {
      callbacks++;
      await saved(client, outcome);
    };
    let result: MutationResult[];
    try {
      const settled = await Promise.allSettled(
        [
          observed.mutateRows(suppliedRepairActor, table.id, input),
          observed.mutateRows(suppliedRepairActor, table.id, input),
        ].map((request) =>
          request.catch((error: unknown) => {
            abort(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }),
        ),
      );
      result = settled.map((entry) => {
        if (entry.status === "rejected") throw entry.reason;
        return entry.value;
      });
    } finally {
      clearTimeout(deadline);
    }
    assert.deepEqual(result[0], result[1]);
    assert.equal(reached, 2);
    assert.equal(lockedReplay, 1);
    assert.equal(callbacks, 2);
    assert.equal((await storage!.getRow(actor, table.id, row.id)).version, "2");
    const facts = (
      await owner!.query(
        "SELECT (SELECT count(*)::int FROM rootset_control.mutations WHERE table_id=$1 AND idempotency_key=$2) AS receipts,(SELECT count(*)::int FROM rootset_control.cell_changes WHERE table_id=$1) AS cells,(SELECT count(*)::int FROM rootset_control.resource_history WHERE table_id=$1 AND operation='operatorRepair') AS completions,(SELECT count(*)::int FROM rootset_control.operation_outcomes WHERE job_id=$3) AS outcomes",
        [table.id, input.idempotencyKey, input.context!.jobId],
      )
    ).rows[0]!;
    assert.deepEqual(facts, {
      receipts: 1,
      cells: 2,
      completions: 1,
      outcomes: 1,
    });
  },
);

test(
  "Worker schema publication rechecks cancellation and authority atomically, and private lease tokens never enter retained history",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Fenced schema worker",
      fields: [{ name: "value", type: "text" }],
    });
    const fence = await runningJob(table.id);
    let checks = 0;
    await assert.rejects(
      storage!.createField(actor, table.id, {
        name: "cancelled",
        type: "boolean",
        expectedSchemaVersion: 1,
        idempotencyKey: "cancel-at-publication",
        context: {
          jobId: fence.jobId,
          jobFence: fence,
          beforePublish: async () => {
            if (++checks === 2)
              await owner!.query(
                "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
                [fence.jobId],
              );
          },
        },
      }),
      { code: "JOB_LEASE_LOST" },
    );
    assert.equal(checks, 2);
    assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 1);
    assert.deepEqual(
      (await storage!.getTable(actor, table.id)).fields.map((f) => f.name),
      ["value"],
    );
    await owner!.query(
      "UPDATE rootset_control.jobs SET cancel_requested=false WHERE id=$1",
      [fence.jobId],
    );
    await assert.rejects(
      storage!.createField(actor, table.id, {
        name: "forbidden",
        type: "boolean",
        expectedSchemaVersion: 1,
        context: {
          jobFence: fence,
          beforePublish: async () => {
            throw Object.assign(new Error("Credential revoked"), {
              code: "ACCESS_DENIED",
            });
          },
        },
      }),
      { code: "ACCESS_DENIED" },
    );
    const updated = await storage!.createField(actor, table.id, {
      name: "valid",
      type: "boolean",
      expectedSchemaVersion: 1,
      context: {
        jobId: fence.jobId,
        jobFence: fence,
        beforePublish: async () => {
          checks++;
        },
      },
    });
    assert.equal(updated.schemaVersion, 2);
    const retained = await owner!.query<{ body: string }>(
      "SELECT row_to_json(s)::text AS body FROM rootset_control.schema_operations s WHERE s.table_id=$1 UNION ALL SELECT row_to_json(h)::text AS body FROM rootset_control.resource_history h WHERE h.table_id=$1",
      [table.id],
    );
    assert.equal(
      retained.rows.some((r) => r.body.includes(fence.leaseToken)),
      false,
    );
    assert.equal(
      retained.rows.some((r) => r.body.includes("beforePublish")),
      false,
    );
  },
);

test(
  "Populated default backfills preserve public worker correlation, native cell history, invalid-context isolation and cancellation rollback",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Correlated default backfill",
      fields: [{ name: "code", type: "text", charLimit: 30 }],
    });
    const originals = await Promise.all(
      ["first", "second"].map((code) =>
        storage!.createRow(actor, table.id, { code }),
      ),
    );
    const fence = await runningJob(table.id, "applySchemaChange");
    const requestId = `default-backfill-${fence.jobId}`;
    let checks = 0;
    const changed = await storage!.createField(actor, table.id, {
      name: "defaulted",
      type: "integer",
      required: true,
      default: 7,
      expectedSchemaVersion: 1,
      context: {
        requestId,
        jobId: fence.jobId,
        jobFence: fence,
        source: "rest",
        beforePublish: async () => {
          checks++;
        },
      },
    });
    assert.equal(checks, 2);
    assert.equal(changed.schemaVersion, 2);
    assert.equal(changed.rowCount, 2);
    const added = changed.fields.find((field) => field.name === "defaulted")!;
    const events = await owner!.query<{
      row_id: string;
      mutation_id: string;
      old_value: null;
      new_value: number;
      old_version: string;
      new_version: string;
      actor: Actor;
      context: Record<string, unknown>;
    }>(
      "SELECT row_id,mutation_id,old_value,new_value,old_version::text,new_version::text,actor,context FROM rootset_control.cell_changes WHERE table_id=$1 AND field_id=$2 ORDER BY row_id",
      [table.id, added.id],
    );
    assert.equal(events.rows.length, 2);
    assert.equal(
      new Set(events.rows.map((event) => event.mutation_id)).size,
      1,
    );
    for (const event of events.rows) {
      assert.deepEqual(event.context, {
        requestId,
        jobId: fence.jobId,
        source: "schema",
      });
      assert.equal(event.old_value, null);
      assert.equal(event.new_value, 7);
      assert.equal(event.old_version, "1");
      assert.equal(event.new_version, "2");
      assert.deepEqual(event.actor, actor);
    }
    assert.deepEqual(
      (
        await owner!.query<{ context: Record<string, unknown> }>(
          "SELECT context FROM rootset_control.mutations WHERE id=$1",
          [events.rows[0]!.mutation_id],
        )
      ).rows[0]!.context,
      { requestId, jobId: fence.jobId, source: "schema" },
    );
    const savedRows = (
      await storage!.queryRows(actor, table.id, { limit: 200 })
    ).data;
    assert.deepEqual(
      savedRows.map((row) => row.id).sort(),
      originals.map((row) => row.id).sort(),
    );
    assert.ok(
      savedRows.every(
        (row) => row.values.defaulted === 7 && row.version === "2",
      ),
    );
    const peerId = newId();
    assert.equal(
      (
        await withOrg(app!, peerId, (client) =>
          client.query(
            `SELECT row_id FROM "${schemaName}"."${changed.physicalName}"`,
          ),
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await withOrg(app!, peerId, (client) =>
          client.query(
            "SELECT public_id FROM rootset_control.cell_changes WHERE table_id=$1",
            [table.id],
          ),
        )
      ).rowCount,
      0,
    );
    const counts = async () =>
      (
        await owner!.query(
          "SELECT (SELECT count(*)::int FROM rootset_control.cell_changes WHERE table_id=$1) AS cells,(SELECT count(*)::int FROM rootset_control.mutations WHERE table_id=$1) AS mutations,(SELECT count(*)::int FROM pg_attribute WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped) AS native_columns",
          [table.id, `"${schemaName}"."${changed.physicalName}"`],
        )
      ).rows[0];
    const beforeCounts = await counts();
    checks = 0;
    await assert.rejects(
      storage!.createField(actor, table.id, {
        name: "cancelled_default",
        type: "boolean",
        default: true,
        expectedSchemaVersion: 2,
        context: {
          requestId,
          jobId: fence.jobId,
          jobFence: fence,
          beforePublish: async () => {
            if (++checks === 2)
              await owner!.query(
                "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
                [fence.jobId],
              );
          },
        },
      }),
      { code: "JOB_LEASE_LOST" },
    );
    assert.deepEqual(await counts(), beforeCounts);
    assert.deepEqual(
      (await storage!.queryRows(actor, table.id, { limit: 200 })).data,
      savedRows,
    );
    const after = await storage!.getTable(actor, table.id);
    assert.equal(after.schemaVersion, 2);
    assert.equal(
      after.fields.some((field) => field.name === "cancelled_default"),
      false,
    );
    const retained = await owner!.query<{ value: string }>(
      "SELECT to_jsonb(r)::text AS value FROM rootset_control.cell_changes r WHERE table_id=$1 UNION ALL SELECT to_jsonb(r)::text FROM rootset_control.mutations r WHERE table_id=$1 UNION ALL SELECT to_jsonb(r)::text FROM rootset_control.schema_operations r WHERE table_id=$1",
      [table.id],
    );
    assert.ok(
      retained.rows.every(
        (row) =>
          !row.value.includes(fence.leaseToken) &&
          !row.value.includes('"jobFence"') &&
          !row.value.includes('"beforePublish"'),
      ),
    );
  },
);

test(
  "Native unique rules use exact typed grouping and extend the SQL budget only for a current authorised queued worker",
  { skip: !configured },
  async () => {
    const url = new URL(process.env.ROOTSET_TEST_DATABASE_URL!);
    url.pathname = `/${isolatedName}`;
    const observedPool = createPool(url.toString(), 2);
    const observations: { timeout: string; sql: string }[] = [];
    observedPool.on(
      "connect",
      (client: import("@rootset/database").PoolClient) => {
        const execute = client.query.bind(client) as unknown as (
          sql: string,
          parameters?: unknown[],
        ) => Promise<{ rows: Record<string, unknown>[] }>;
        client.query = (async (sql: string, parameters?: unknown[]) => {
          if (typeof sql === "string" && sql.includes("HAVING count(*)>1")) {
            const setting = await execute("SHOW statement_timeout");
            observations.push({
              timeout: String(setting.rows[0]!.statement_timeout),
              sql,
            });
          }
          return execute(sql, parameters);
        }) as typeof client.query;
      },
    );
    const observed = new TableStorage({
      pool: app!,
      ddlPool: observedPool,
      cursorSecret: "unique-rule-budget-regression-secret-at-least-32-bytes",
    });
    const fixture = async (label: string, duplicates = false) => {
      const table = await observed.createTable(actor, databaseId, {
        name: label,
        fields: [
          { name: "code", type: "text", charLimit: 40 },
          { name: "count", type: "integer" },
          { name: "rate", type: "float" },
        ],
      });
      await observed.mutateRows(actor, table.id, {
        operations: [
          { kind: "create", values: { code: "Case", count: 1, rate: 0 } },
          {
            kind: "create",
            values: { code: duplicates ? "Case" : "case", count: 1, rate: -0 },
          },
          { kind: "create", values: { code: null, count: 1, rate: 0 } },
          { kind: "create", values: { code: null, count: 1, rate: 0 } },
        ],
      });
      return table;
    };
    try {
      const ordinary = await fixture("Ordinary typed grouping");
      assert.equal(
        (
          await observed.createUniqueRule(actor, ordinary.id, {
            fieldIds: ordinary.fields.map((f) => f.id),
            expectedSchemaVersion: 1,
          })
        ).strategy,
        "native",
      );
      assert.equal(observations.at(-1)!.timeout, "10s");
      assert.ok(observations.at(-1)!.sql.startsWith("WITH duplicates AS"));
      assert.equal(observations.at(-1)!.sql.includes("canonical_json"), false);
      const worker = await fixture("Queued typed grouping");
      const fence = await runningJob(worker.id, "createUniqueRule");
      assert.equal(
        (
          await observed.createUniqueRule(actor, worker.id, {
            fieldIds: worker.fields.map((f) => f.id),
            expectedSchemaVersion: 1,
            context: { jobFence: fence },
          })
        ).state,
        "active",
      );
      assert.equal(observations.at(-1)!.timeout, "0");
      const expired = await fixture("Expired queued grouping");
      const deadFence = await runningJob(expired.id, "createUniqueRule");
      await owner!.query(
        "UPDATE rootset_control.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [deadFence.jobId],
      );
      const scans = observations.length;
      await assert.rejects(
        observed.createUniqueRule(actor, expired.id, {
          fieldIds: expired.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
          context: { jobFence: deadFence },
        }),
        { code: "JOB_LEASE_LOST" },
      );
      await assert.rejects(
        observed.createUniqueRule(actor, expired.id, {
          fieldIds: expired.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
          context: {
            jobFence: fence,
            beforePublish: async () => {
              throw Object.assign(new Error("Authority revoked"), {
                code: "ACCESS_DENIED",
              });
            },
          },
        }),
        { code: "ACCESS_DENIED" },
      );
      assert.equal(observations.length, scans);
      assert.equal(
        (await observed.listUniqueRules(actor, expired.id)).length,
        0,
      );
      const duplicate = await fixture("Signed-zero duplicates", true);
      await assert.rejects(
        observed.createUniqueRule(actor, duplicate.id, {
          fieldIds: duplicate.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
        }),
        (error) => {
          const result = error as {
            code: string;
            details: { conflicts: { count: number; rowIds: string[] }[] };
          };
          assert.equal(result.code, "UNIQUE_CONFLICT");
          assert.equal(result.details.conflicts[0]!.count, 2);
          assert.equal(result.details.conflicts[0]!.rowIds.length, 2);
          return true;
        },
      );
      const cancelled = await fixture("Cancellation at rule publication");
      const cancelledFence = await runningJob(cancelled.id, "createUniqueRule");
      let checks = 0;
      await assert.rejects(
        observed.createUniqueRule(actor, cancelled.id, {
          fieldIds: cancelled.fields.map((f) => f.id),
          expectedSchemaVersion: 1,
          context: {
            jobFence: cancelledFence,
            beforePublish: async () => {
              if (++checks === 2)
                await owner!.query(
                  "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
                  [cancelledFence.jobId],
                );
            },
          },
        }),
        { code: "JOB_LEASE_LOST" },
      );
      assert.equal(checks, 2);
      assert.equal(
        (await observed.getTable(actor, cancelled.id)).schemaVersion,
        1,
      );
      assert.equal(
        (await observed.listUniqueRules(actor, cancelled.id)).length,
        0,
      );
      assert.equal(
        (
          await owner!.query(
            "SELECT c.oid FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE i.indrelid=$1::regclass AND c.relname LIKE 'rsu_%'",
            [`"${schemaName}"."${cancelled.physicalName}"`],
          )
        ).rowCount,
        0,
      );
    } finally {
      await observedPool.end();
    }
  },
);

test(
  "Unique rules reject repeated field sets regardless of order or name without changing schema or indexes",
  { skip: !configured },
  async () => {
    for (const charLimit of [20, 4000]) {
      const table = await storage!.createTable(actor, databaseId, {
        name: `Duplicate rule ${charLimit}`,
        fields: [
          { name: "code", type: "text", charLimit },
          { name: "region", type: "text", charLimit: 20 },
        ],
      });
      const fieldIds = table.fields.map((field) => field.id);
      const input = {
        fieldIds,
        expectedSchemaVersion: 1,
        idempotencyKey: `duplicate-rule-${charLimit}`,
      };
      const first = await storage!.createUniqueRule(actor, table.id, input);
      assert.equal(first.strategy, charLimit === 20 ? "native" : "registry");
      assert.deepEqual(
        await storage!.createUniqueRule(actor, table.id, input),
        first,
      );
      for (const selected of [fieldIds, [...fieldIds].reverse()]) {
        await assert.rejects(
          storage!.createUniqueRule(actor, table.id, {
            fieldIds: selected,
            name: "Another name",
            expectedSchemaVersion: 2,
          }),
          {
            code: "UNIQUE_CONFLICT",
            status: 409,
            message: "A unique rule already exists for these fields.",
          },
        );
      }
      assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 2);
      assert.deepEqual(await storage!.listUniqueRules(actor, table.id), [
        first,
      ]);
      assert.equal(
        (
          await owner!.query(
            "SELECT c.oid FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE i.indrelid=$1::regclass AND c.relname LIKE 'rsu_%'",
            [`"${schemaName}"."${table.physicalName}"`],
          )
        ).rowCount,
        charLimit === 20 ? 1 : 0,
      );
      await storage!.deleteUniqueRule(actor, table.id, first.id, {
        expectedSchemaVersion: 2,
      });
      const replacement = await storage!.createUniqueRule(actor, table.id, {
        fieldIds: [...fieldIds].reverse(),
        expectedSchemaVersion: 3,
      });
      assert.notEqual(replacement.id, first.id);
      assert.deepEqual(await storage!.listUniqueRules(actor, table.id), [
        replacement,
      ]);
    }
  },
);

test(
  "Concurrent unique rule creation publishes only one index for the same field set",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Concurrent rule definitions",
      fields: [
        { name: "code", type: "text", charLimit: 20 },
        { name: "region", type: "text", charLimit: 20 },
      ],
    });
    const fieldIds = table.fields.map((field) => field.id);
    const results = await Promise.allSettled([
      storage!.createUniqueRule(actor, table.id, {
        fieldIds,
        expectedSchemaVersion: 1,
      }),
      storage!.createUniqueRule(actor, table.id, {
        fieldIds: [...fieldIds].reverse(),
        expectedSchemaVersion: 1,
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.reason.code, "SCHEMA_VERSION_CONFLICT");
    assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 2);
    assert.equal((await storage!.listUniqueRules(actor, table.id)).length, 1);
    await assert.rejects(
      storage!.createUniqueRule(actor, table.id, {
        fieldIds: [...fieldIds].reverse(),
        expectedSchemaVersion: 2,
      }),
      { code: "UNIQUE_CONFLICT", status: 409 },
    );
  },
);

test(
  "Rule idempotency replays the exact durable outcome when rules share names and after subsequent rule deletion",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Exact rule result",
      fields: [
        { name: "code", type: "text", charLimit: 20 },
        { name: "other_code", type: "text", charLimit: 20 },
      ],
    });
    const firstInput = {
      name: "Shared name",
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: 1,
      idempotencyKey: "first-exact-rule",
    };
    const secondInput = {
      name: "Shared name",
      fieldIds: [table.fields[1]!.id],
      expectedSchemaVersion: 2,
      idempotencyKey: "second-exact-rule",
    };
    const first = await storage!.createUniqueRule(actor, table.id, firstInput);
    const second = await storage!.createUniqueRule(
      actor,
      table.id,
      secondInput,
    );
    assert.notEqual(second.id, first.id);
    const restarted = new TableStorage({
      pool: app!,
      ddlPool: ddl!,
      cursorSecret: "restarted-rule-outcome-secret-at-least-thirty-two-bytes",
    });
    assert.deepEqual(
      await restarted.createUniqueRule(actor, table.id, secondInput),
      second,
    );
    await restarted.deleteUniqueRule(actor, table.id, second.id, {
      expectedSchemaVersion: 3,
    });
    const afterDeletion = await restarted.getTable(actor, table.id);
    assert.equal(
      (await restarted.listUniqueRules(actor, table.id)).some(
        (rule) => rule.id === second.id,
      ),
      false,
    );
    assert.equal(afterDeletion.schemaVersion, 4);
    assert.deepEqual(
      await restarted.createUniqueRule(actor, table.id, secondInput),
      second,
    );
    const saved = (
      await owner!.query<{ plan: { ruleId: string; outcome: unknown } }>(
        "SELECT plan FROM rootset_control.schema_operations WHERE org_id=$1 AND idempotency_key=$2",
        [actor.orgId, secondInput.idempotencyKey],
      )
    ).rows[0]!.plan;
    assert.equal(saved.ruleId, second.id);
    assert.deepEqual(saved.outcome, second);
    await owner!.query(
      "UPDATE rootset_control.schema_operations SET plan=plan-'outcome' WHERE org_id=$1 AND idempotency_key=$2",
      [actor.orgId, secondInput.idempotencyKey],
    );
    await assert.rejects(
      restarted.createUniqueRule(actor, table.id, secondInput),
      { code: "INTERNAL_ERROR", status: 500 },
    );
    assert.equal((await restarted.getTable(actor, table.id)).schemaVersion, 4);
    assert.equal((await restarted.listUniqueRules(actor, table.id)).length, 1);
  },
);

test(
  "Conversions rebuild native uniqueness and preserve registry uniqueness across repeated conversion and replay",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Generation enforcement",
      fields: [
        { name: "code", type: "text", charLimit: 30 },
        { name: "wide", type: "text", charLimit: 4000 },
        { name: "value", type: "float" },
        { name: "payload", type: "json" },
      ],
    });
    const native = await storage!.createUniqueRule(actor, table.id, {
      name: "Native unchanged",
      fieldIds: [table.fields[0]!.id],
      expectedSchemaVersion: 1,
    });
    const registry = await storage!.createUniqueRule(actor, table.id, {
      name: "Registry unchanged",
      fieldIds: [table.fields[1]!.id],
      expectedSchemaVersion: 2,
    });
    assert.equal(registry.strategy, "registry");
    const rows = [];
    for (let i = 0; i < 3; i++)
      rows.push(
        await storage!.createRow(actor, table.id, {
          code: `code-${i}`,
          wide: `wide-${i}`,
          value: i + 0.25,
          payload: { keep: i },
        }),
      );
    const jobFence = await runningJob(table.id, "updateField");
    const requestId = newId();
    const input = {
      type: "text" as const,
      conversion: { strategy: "stringify" as const },
      expectedSchemaVersion: 3,
      idempotencyKey: "generation-stringify",
      context: {
        source: "mcp" as const,
        requestId,
        jobId: jobFence.jobId,
        jobFence,
      },
    };
    const converted = await storage!.updateField(
      actor,
      table.id,
      table.fields[2]!.id,
      input,
    );
    assert.equal(converted.generation, 2);
    for (const relation of ["mutations", "cell_changes", "resource_history"]) {
      const records = await owner!.query<{ context: unknown; body: string }>(
        `SELECT context,row_to_json(r)::text AS body FROM rootset_control.${relation} r WHERE table_id=$1 AND context->>'jobId'=$2`,
        [table.id, jobFence.jobId],
      );
      assert.ok(records.rowCount! > 0);
      for (const record of records.rows) {
        assert.deepEqual(record.context, {
          source: "schema",
          requestId,
          jobId: jobFence.jobId,
        });
        assert.equal(record.body.includes(jobFence.leaseToken), false);
        assert.equal(record.body.includes("jobFence"), false);
      }
    }
    async function enforcement(current: typeof converted) {
      const rules = await storage!.listUniqueRules(actor, table.id);
      assert.deepEqual(
        rules.map((r) => r.id).sort(),
        [native.id, registry.id].sort(),
      );
      for (const definition of rules.filter((r) => r.strategy === "native")) {
        const info = (
          await owner!.query<{
            relid: string;
            valid: boolean;
            definition: string;
          }>(
            "SELECT i.indrelid::regclass::text AS relid,i.indisvalid AS valid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i WHERE i.indexrelid=$1::regclass",
            [`"${current.schemaName}"."${definition.physicalName}"`],
          )
        ).rows[0]!;
        assert.equal(
          info.relid,
          `${current.schemaName}.${current.physicalName}`,
        );
        assert.equal(info.valid, true);
      }
      const value = current.fields[2]!.type === "text" ? "7" : 7;
      await assert.rejects(
        storage!.createRow(actor, table.id, {
          code: "code-0",
          wide: "unused-wide",
          value,
          payload: null,
        }),
        { code: "UNIQUE_CONFLICT" },
      );
      await assert.rejects(
        storage!.createRow(actor, table.id, {
          code: "unused-code",
          wide: "wide-0",
          value,
          payload: null,
        }),
        { code: "UNIQUE_CONFLICT" },
      );
      assert.equal((await storage!.getTable(actor, table.id)).rowCount, 3);
    }
    await enforcement(converted);
    assert.equal(
      (await storage!.updateField(actor, table.id, table.fields[2]!.id, input))
        .generation,
      2,
    );
    assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 4);
    const reverted = await storage!.updateField(
      actor,
      table.id,
      table.fields[2]!.id,
      {
        type: "float",
        conversion: { strategy: "parse" },
        expectedSchemaVersion: 4,
        idempotencyKey: "generation-parse",
      },
    );
    assert.equal(reverted.generation, 3);
    await enforcement(reverted);
    for (const row of rows)
      assert.equal(
        (await storage!.getRow(actor, table.id, row.id)).version,
        "3",
      );
    assert.equal(
      (
        await owner!.query(
          "SELECT id FROM rootset_control.cell_changes WHERE table_id=$1 AND operation='conversion'",
          [table.id],
        )
      ).rowCount,
      6,
    );
  },
);

test(
  "field names rename existing values without changing native identity and reject invalid or colliding names",
  { skip: !configured },
  async () => {
    let table = await storage!.createTable(actor, databaseId, {
      name: "Field naming",
      fields: [
        { name: "Airline_Code", type: "text" },
        { name: "Country", type: "text" },
      ],
    });
    const original = table.fields[0]!;
    const row = await storage!.createRow(actor, table.id, {
      Airline_Code: "AI",
      Country: "IN",
    });
    for (const name of [
      "Airline Code",
      "Airline.Code",
      "Airline1",
      "id",
      "country",
    ]) {
      await assert.rejects(
        storage!.updateField(actor, table.id, original.id, {
          name,
          expectedSchemaVersion: table.schemaVersion,
        }),
        { code: "VALIDATION_FAILED" },
      );
    }
    const before = await storage!.cellHistory(
      actor,
      table.id,
      row.id,
      original.id,
      { limit: 100 },
    );
    table = await storage!.updateField(actor, table.id, original.id, {
      name: "Carrier_Code",
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(table.fields[0]!.id, original.id);
    const renamed = await storage!.getRow(actor, table.id, row.id);
    assert.deepEqual(renamed.values, { Carrier_Code: "AI", Country: "IN" });
    assert.equal(renamed.version, row.version);
    assert.deepEqual(
      await storage!.cellHistory(actor, table.id, row.id, original.id, {
        limit: 100,
      }),
      before,
    );
    await assert.rejects(
      storage!.updateRow(
        actor,
        table.id,
        row.id,
        { Airline_Code: "XX" },
        { expectedVersion: row.version },
      ),
      { code: "VALIDATION_FAILED" },
    );
    await storage!.updateRow(
      actor,
      table.id,
      row.id,
      { Carrier_Code: "XX" },
      { expectedVersion: row.version },
    );
    assert.equal(
      (await storage!.getRow(actor, table.id, row.id)).values.Carrier_Code,
      "XX",
    );
  },
);

test(
  "Cell history keeps exactly the latest 200 changes per cell across typed mutations and no-ops",
  { skip: !configured },
  async () => {
    let table = await storage!.createTable(actor, databaseId, {
      name: "Bounded cell history",
      fields: [
        { name: "value", type: "integer" },
        { name: "other", type: "text" },
      ],
    });
    let row = await storage!.createRow(actor, table.id, {
      value: 0,
      other: "untouched",
    });
    for (let value = 1; value <= 205; value++) {
      row = await storage!.updateRow(
        actor,
        table.id,
        row.id,
        { value },
        {
          expectedVersion: row.version,
          context: {
            source: value % 2 ? "rest" : "mcp",
            requestId: `edit-${value}`,
          },
        },
      );
    }
    const fieldId = table.fields.find((field) => field.name === "value")!.id;
    const retained = await storage!.cellHistory(
      actor,
      table.id,
      row.id,
      fieldId,
    );
    assert.equal(retained.data.length, 200);
    assert.equal(retained.hasMore, false);
    assert.equal(retained.data[0]!.old_value, 5);
    assert.equal(retained.data[0]!.new_value, 6);
    assert.equal(retained.data.at(-1)!.new_value, 205);
    assert.equal((retained.data.at(-1)!.actor as { id: string }).id, actor.id);
    assert.equal(
      (retained.data.at(-1)!.context as { requestId: string }).requestId,
      "edit-205",
    );
    assert(retained.data.every((entry) => entry.operation === "update"));
    const other = await storage!.cellHistory(actor, table.id, row.id, "other");
    assert.equal(other.data.length, 1);
    assert.equal(other.data[0]!.new_value, "untouched");
    const peer = await storage!.createRow(actor, table.id, {
      value: 1,
      other: "another row",
    });
    assert.equal(
      (await storage!.cellHistory(actor, table.id, peer.id, fieldId)).data
        .length,
      1,
    );
    const counts = await withOrg(app!, actor.orgId, (client) =>
      client.query(
        "SELECT count(*)::int AS count FROM rootset_control.cell_changes WHERE table_id=$1 AND row_id=$2 AND field_id=$3",
        [table.id, row.id, fieldId],
      ),
    );
    assert.equal(counts.rows[0]!.count, 200);
    const metrics = await withOrg(app!, actor.orgId, (client) =>
      client.query(
        "SELECT events::int AS count FROM rootset_control.history_metrics WHERE table_id=$1",
        [table.id],
      ),
    );
    assert.equal(metrics.rows[0]!.count, 203);
    const unchanged = await storage!.updateRow(
      actor,
      table.id,
      row.id,
      { value: 205 },
      { expectedVersion: row.version },
    );
    assert.equal(unchanged.version, row.version);
    await assert.rejects(
      storage!.updateRow(
        actor,
        table.id,
        row.id,
        { value: 206 },
        { expectedVersion: "1" },
      ),
      { code: "ROW_VERSION_CONFLICT" },
    );
    assert.deepEqual(
      (await storage!.cellHistory(actor, table.id, row.id, fieldId)).data,
      retained.data,
    );
    let cursor: string | undefined;
    const values: number[] = [];
    do {
      const page = await storage!.cellHistory(
        actor,
        table.id,
        row.id,
        fieldId,
        { limit: 50, ...(cursor ? { cursor } : {}) },
      );
      values.push(...page.data.map((entry) => entry.new_value as number));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(
      values,
      Array.from({ length: 200 }, (_, index) => index + 6),
    );
    const invisible = await withOrg(app!, newId(), (client) =>
      client.query(
        "SELECT id FROM rootset_control.cell_changes WHERE table_id=$1",
        [table.id],
      ),
    );
    assert.equal(invisible.rowCount, 0);
    await storage!.updateField(actor, table.id, fieldId, {
      type: "text",
      conversion: { strategy: "stringify" },
      expectedSchemaVersion: table.schemaVersion,
    });
    const converted = await storage!.cellHistory(
      actor,
      table.id,
      row.id,
      fieldId,
    );
    assert.equal(converted.data.length, 200);
    assert.equal(converted.data[0]!.new_value, 7);
    assert.equal(converted.data.at(-1)!.operation, "conversion");
    assert.equal(converted.data.at(-1)!.new_value, "205");

    await storage!.deleteRow(actor, table.id, peer.id, {
      expectedVersion: (await storage!.getRow(actor, table.id, peer.id))
        .version,
    });
    assert.equal(
      (await storage!.cellHistory(actor, table.id, peer.id, fieldId)).data
        .length,
      0,
    );
    table = await storage!.getTable(actor, table.id);
    await storage!.deleteField(actor, table.id, fieldId, {
      expectedSchemaVersion: table.schemaVersion,
    });
    await assert.rejects(
      storage!.cellHistory(actor, table.id, row.id, fieldId),
      { code: "RESOURCE_NOT_FOUND" },
    );
    assert.equal(
      (await storage!.queryHistory(actor, table.id, { fieldId })).data.length,
      0,
    );
    table = await storage!.getTable(actor, table.id);
    await storage!.deleteTable(actor, table.id, {
      expectedSchemaVersion: table.schemaVersion,
    });
    await assert.rejects(storage!.queryHistory(actor, table.id), {
      code: "RESOURCE_NOT_FOUND",
    });
    const remaining = await withOrg(app!, actor.orgId, (client) =>
      client.query(
        "SELECT count(*)::int AS count FROM rootset_control.cell_changes WHERE table_id=$1",
        [table.id],
      ),
    );
    assert.equal(remaining.rows[0]!.count, 0);

    const deletedDatabase = await storage!.createDatabase(actor, {
      name: "Deleted history",
    });
    const deletedTable = await storage!.createTable(actor, deletedDatabase.id, {
      name: "Deleted history",
      fields: [{ name: "value", type: "text" }],
    });
    await storage!.createRow(actor, deletedTable.id, { value: "saved" });
    await storage!.deleteDatabase(actor, deletedDatabase.id);
    await assert.rejects(storage!.queryHistory(actor, deletedTable.id), {
      code: "RESOURCE_NOT_FOUND",
    });
    const databaseHistory = await withOrg(app!, actor.orgId, (client) =>
      client.query(
        "SELECT count(*)::int AS count FROM rootset_control.cell_changes WHERE database_id=$1",
        [deletedDatabase.id],
      ),
    );
    assert.equal(databaseHistory.rows[0]!.count, 0);

    const removed = await owner!.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='rootset_control' AND tablename IN ('history_archives','history_archive_occurrences','history_retention_policies','history_gaps','row_events')",
    );
    assert.equal(removed.rowCount, 0);
  },
);

test(
  "list summaries report tenant-scoped physical table sizes including indexes",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Storage sizes",
      fields: [{ name: "VALUE", type: "text", charLimit: 10000 }],
    });
    await storage!.createRow(actor, table.id, { VALUE: "data".repeat(2000) });
    const statistics = await storage!.statistics(actor, table.id);
    const tables = await storage!.listTables(actor, databaseId);
    const summary = tables.find((entry) => entry.id === table.id)!;
    assert.equal(
      summary.storageBytes,
      statistics.bytes + statistics.indexBytes,
    );
    assert.ok(summary.storageBytes > 0);
    const databases = await storage!.listDatabases(actor);
    assert.equal(
      databases.find((entry) => entry.id === databaseId)?.storageBytes,
      tables.reduce((bytes, entry) => bytes + entry.storageBytes, 0),
    );
    const empty = await storage!.createDatabase(actor, { name: "Empty size" });
    assert.equal(
      (await storage!.listDatabases(actor)).find(
        (entry) => entry.id === empty.id,
      )?.storageBytes,
      0,
    );
    const other = { ...actor, orgId: newId() };
    assert.deepEqual(await storage!.listDatabases(other), []);
    await assert.rejects(
      storage!.listTables(other, databaseId),
      (error: unknown) =>
        error instanceof RootsetError && error.code === "RESOURCE_NOT_FOUND",
    );
  },
);

for (const charLimit of [20, 4000]) {
  const strategy = charLimit === 20 ? "native" : "registry";
  const conditionalTable = () =>
    storage!.createTable(actor, databaseId, {
      name: `Conditional ${strategy}`,
      fields: [
        { name: "code", type: "text", charLimit },
        { name: "region", type: "text", charLimit: 20 },
        { name: "status", type: "text", charLimit: 40 },
        { name: "unrelated", type: "integer" },
      ],
    });
  test(
    `Conditional ${strategy}: backfill, subset transitions, composites, nulls, batches and concurrent writes`,
    { skip: !configured },
    async () => {
      const table = await conditionalTable();
      const where = {
        field: table.fields[2]!.id,
        op: "eq" as const,
        value: "active",
      };
      const values = { code: "shared", region: "west", status: "ceased" };
      await storage!.mutateRows(actor, table.id, {
        operations: [
          { kind: "create", values },
          { kind: "create", values },
        ],
      });
      const input = {
        fieldIds: table.fields.slice(0, 2).map((f) => f.id),
        where,
        expectedSchemaVersion: 1,
        idempotencyKey: `conditional-${table.id}`,
      };
      const rule = await storage!.createUniqueRule(actor, table.id, input);
      assert.equal(rule.strategy, strategy);
      assert.deepEqual(rule.where, where);
      assert.deepEqual(
        await storage!.createUniqueRule(actor, table.id, input),
        rule,
      );
      assert.deepEqual(
        (await storage!.listUniqueRules(actor, table.id))[0],
        rule,
      );
      let first = await storage!.createRow(actor, table.id, {
        ...values,
        status: "active",
      });
      const second = await storage!.createRow(actor, table.id, values);
      const conflict = {
        code: "UNIQUE_CONFLICT",
        details: { ruleId: rule.id },
      };
      await assert.rejects(
        storage!.updateRow(
          actor,
          table.id,
          second.id,
          { status: "active" },
          { expectedVersion: second.version },
        ),
        conflict,
      );
      assert.equal(
        (await storage!.getRow(actor, table.id, second.id)).version,
        second.version,
      );
      first = await storage!.updateRow(
        actor,
        table.id,
        first.id,
        { status: "ceased" },
        { expectedVersion: first.version },
      );
      const entered = await storage!.updateRow(
        actor,
        table.id,
        second.id,
        { status: "active" },
        { expectedVersion: second.version },
      );
      await assert.rejects(
        storage!.updateRow(
          actor,
          table.id,
          first.id,
          { status: "active" },
          { expectedVersion: first.version },
        ),
        conflict,
      );
      // A different composite tuple, null key parts and nonmatching/null predicates are all allowed.
      for (const extra of [
        { code: "shared", region: "east", status: "active" },
        ...Array.from({ length: 2 }, () => ({
          code: null,
          region: "west",
          status: "active",
        })),
        ...Array.from({ length: 2 }, () => ({
          code: "shared",
          region: null,
          status: "active",
        })),
        ...Array.from({ length: 2 }, () => ({ ...values, status: null })),
      ])
        await storage!.createRow(actor, table.id, extra);
      const before = await storage!.getTable(actor, table.id);
      await assert.rejects(
        storage!.mutateRows(actor, table.id, {
          operations: [
            {
              kind: "create",
              values: { ...values, code: "batch", status: "active" },
            },
            {
              kind: "create",
              values: { ...values, code: "batch", status: "active" },
            },
          ],
        }),
        conflict,
      );
      assert.equal(
        (await storage!.getTable(actor, table.id)).rowCount,
        before.rowCount,
      );
      await assert.rejects(
        storage!.mutateRows(actor, table.id, {
          context: { source: "import" },
          operations: [
            {
              kind: "create",
              values: { ...values, code: "imported", status: "active" },
            },
            { kind: "create", values: { ...values, status: "active" } },
          ],
        }),
        conflict,
      );
      assert.equal(
        (await storage!.getTable(actor, table.id)).rowCount,
        before.rowCount,
      );
      const changes: RowOperation[] = [
        {
          kind: "update",
          rowId: first.id,
          expectedVersion: first.version,
          values: { status: "active" },
        },
      ];
      await assert.rejects(
        storage!.mutateRows(suppliedRepairActor, table.id, {
          ...(await repairOptions(table.id, changes)),
          operations: changes,
        }),
        conflict,
      );
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          storage!.createRow(actor, table.id, {
            ...values,
            code: "race",
            status: "active",
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert(
        results
          .filter((r) => r.status === "rejected")
          .every((r) => r.reason.code === "UNIQUE_CONFLICT"),
      );
      await storage!.deleteRow(actor, table.id, entered.id, {
        expectedVersion: entered.version,
      });
      await storage!.updateRow(
        actor,
        table.id,
        first.id,
        { status: "active" },
        { expectedVersion: first.version },
      );
      if (strategy === "registry") {
        const entries = await withOrg(owner!, actor.orgId, (c) =>
          c.query(
            "SELECT count(*)::int AS count FROM rootset_control.unique_entries WHERE rule_id=$1",
            [rule.id],
          ),
        );
        assert.equal(entries.rows[0].count, 3);
      }
    },
  );

  test(
    `Conditional ${strategy}: conflicting activation and publication cancellation roll back completely`,
    { skip: !configured },
    async () => {
      const table = await conditionalTable();
      const matching = { code: "duplicate", status: "active" };
      const excluded = await storage!.createRow(actor, table.id, {
        ...matching,
        status: "ceased",
      });
      const a = await storage!.createRow(actor, table.id, matching);
      const b = await storage!.createRow(actor, table.id, matching);
      const where = {
        field: table.fields[2]!.id,
        op: "eq" as const,
        value: "active",
      };
      const input = {
        fieldIds: [table.fields[0]!.id],
        where,
        expectedSchemaVersion: 1,
      };
      await assert.rejects(
        storage!.createUniqueRule(actor, table.id, input),
        (error: unknown) => {
          assert(error instanceof RootsetError);
          assert.equal(error.code, "UNIQUE_CONFLICT");
          const details = error.details as {
            where: unknown;
            conflicts: { rowIds: string[] }[];
          };
          assert.deepEqual(details.where, where);
          assert.deepEqual(
            details.conflicts[0]!.rowIds.sort(),
            [a.id, b.id].sort(),
          );
          assert(!details.conflicts[0]!.rowIds.includes(excluded.id));
          return true;
        },
      );
      assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 1);
      assert.equal((await storage!.listUniqueRules(actor, table.id)).length, 0);
      await storage!.deleteRow(actor, table.id, b.id, {
        expectedVersion: b.version,
      });
      const jobFence = await runningJob(table.id, "createUniqueRule");
      let calls = 0;
      await assert.rejects(
        storage!.createUniqueRule(actor, table.id, {
          ...input,
          context: {
            jobFence,
            beforePublish: async () => {
              if (++calls === 2)
                await owner!.query(
                  "UPDATE rootset_control.jobs SET cancel_requested=true WHERE id=$1",
                  [jobFence.jobId],
                );
            },
          },
        }),
        { code: "JOB_LEASE_LOST" },
      );
      assert.equal((await storage!.listUniqueRules(actor, table.id)).length, 0);
      assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 1);
      await storage!.createUniqueRule(actor, table.id, input);
      await assert.rejects(storage!.createRow(actor, table.id, matching), {
        code: "UNIQUE_CONFLICT",
      });
    },
  );

  test(
    `Conditional ${strategy}: field dependencies and unrelated conversion preserve membership`,
    { skip: !configured },
    async () => {
      const table = await conditionalTable();
      const where = {
        field: table.fields[2]!.id,
        op: "eq" as const,
        value: "active",
      };
      const rule = await storage!.createUniqueRule(actor, table.id, {
        fieldIds: [table.fields[0]!.id],
        where,
        expectedSchemaVersion: 1,
      });
      for (const status of ["active", "ceased", "ceased"])
        await storage!.createRow(actor, table.id, {
          code: "same",
          status,
          unrelated: 1,
        });
      let current = await storage!.updateField(actor, table.id, where.field, {
        name: "state",
        expectedSchemaVersion: 2,
      });
      assert.deepEqual(
        (await storage!.listUniqueRules(actor, table.id))[0]!.where,
        where,
      );
      await assert.rejects(
        storage!.updateField(actor, table.id, where.field, {
          type: "boolean",
          conversion: { strategy: "strict" },
          expectedSchemaVersion: current.schemaVersion,
        }),
        { code: "VALIDATION_FAILED" },
      );
      await assert.rejects(
        storage!.deleteField(actor, table.id, where.field, {
          expectedSchemaVersion: current.schemaVersion,
        }),
        { code: "VALIDATION_FAILED" },
      );
      await assert.rejects(
        storage!.previewSchemaChange(actor, table.id, {
          expectedSchemaVersion: current.schemaVersion,
          change: { kind: "delete_field", fieldId: where.field },
        }),
        { code: "VALIDATION_FAILED" },
      );
      current = await storage!.updateField(
        actor,
        table.id,
        table.fields[3]!.id,
        {
          type: "text",
          conversion: { strategy: "stringify" },
          expectedSchemaVersion: current.schemaVersion,
        },
      );
      await assert.rejects(
        storage!.createRow(actor, table.id, { code: "same", state: "active" }),
        { code: "UNIQUE_CONFLICT", details: { ruleId: rule.id } },
      );
      await storage!.createRow(actor, table.id, {
        code: "same",
        state: "ceased",
      });
      current = await storage!.deleteField(actor, table.id, where.field, {
        removeDependencies: true,
        expectedSchemaVersion: current.schemaVersion,
      });
      assert.equal((await storage!.listUniqueRules(actor, table.id)).length, 0);
      await storage!.createRow(actor, table.id, { code: "same" });
    },
  );

  test(
    `Conditional ${strategy}: activation holds writes until enforcement is visible`,
    { skip: !configured },
    async () => {
      const table = await conditionalTable();
      await storage!.createRow(actor, table.id, {
        code: "held",
        status: "active",
      });
      let reachedResolve!: () => void;
      let releaseResolve!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedResolve = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      let calls = 0;
      const building = storage!.createUniqueRule(actor, table.id, {
        fieldIds: [table.fields[0]!.id],
        where: { field: table.fields[2]!.id, op: "eq", value: "active" },
        expectedSchemaVersion: 1,
        context: {
          beforePublish: async () => {
            if (++calls === 2) {
              reachedResolve();
              await release;
            }
          },
        },
      });
      await reached;
      let completed = false;
      const writing = storage!
        .createRow(actor, table.id, { code: "held", status: "active" })
        .finally(() => {
          completed = true;
        });
      const rejected = assert.rejects(writing, { code: "UNIQUE_CONFLICT" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(completed, false);
      } finally {
        releaseResolve();
      }
      await building;
      await rejected;
    },
  );
}

for (const charLimit of [20, 4000]) {
  test(
    `Conditional scalar/null predicate parity with query filters (${charLimit === 20 ? "native" : "registry"})`,
    { skip: !configured },
    async () => {
      const cases: {
        type: import("@rootset/contracts").FieldDefinition["type"];
        values: import("@rootset/contracts").JsonValue[];
        target: import("@rootset/contracts").JsonValue;
      }[] = [
        {
          type: "text",
          values: ["a'\\quoted", "A'\\quoted", "", null],
          target: "a'\\quoted",
        },
        {
          type: "uri",
          values: ["opaque:One", "opaque:one", null],
          target: "opaque:One",
        },
        { type: "url", values: ["One", "one", null], target: "One" },
        { type: "image", values: ["One", "one", null], target: "One" },
        { type: "integer", values: [1, 2, 9007199254740991, null], target: 1 },
        {
          type: "float",
          values: [1e23, -1e23, Number.MIN_VALUE, 0, null],
          target: 1e23,
        },
        {
          type: "float",
          values: [Number.MIN_VALUE, 0, -0, null],
          target: Number.MIN_VALUE,
        },
        { type: "boolean", values: [true, false, null], target: false },
        {
          type: "date",
          values: ["2026-01-01", "2026-01-02", null],
          target: "2026-01-01",
        },
        {
          type: "time",
          values: ["09:30:00Z", "09:30:01Z", null],
          target: "09:30:00Z",
        },
        {
          type: "date-time",
          values: ["2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z", null],
          target: "2026-01-01T00:00:00Z",
        },
      ];
      for (const item of cases)
        for (const op of ["eq", "ne", "isNull", "isNotNull"] as const) {
          const table = await storage!.createTable(actor, databaseId, {
            name: `Condition ${item.type} ${op}`,
            fields: [
              { name: "code", type: "text", charLimit },
              { name: "value", type: item.type },
            ],
          });
          for (const [i, value] of item.values.entries())
            await storage!.createRow(actor, table.id, {
              code: String(i),
              value,
            });
          const where =
            op === "eq" || op === "ne"
              ? {
                  field: table.fields[1]!.id,
                  op,
                  value: item.target as string | number | boolean,
                }
              : { field: table.fields[1]!.id, op };
          const matched = new Set(
            (await storage!.queryRows(actor, table.id, { where })).data.map(
              (row) => row.values.code,
            ),
          );
          await storage!.createUniqueRule(actor, table.id, {
            fieldIds: [table.fields[0]!.id],
            where,
            expectedSchemaVersion: 1,
          });
          for (const [i, value] of item.values.entries()) {
            const write = () =>
              storage!.createRow(actor, table.id, { code: String(i), value });
            if (matched.has(String(i)))
              await assert.rejects(write(), { code: "UNIQUE_CONFLICT" });
            else {
              await write();
              await write();
            }
          }
        }
    },
  );

  test(
    `Conditional rule identity, atomic handoff and concurrent updates (${charLimit})`,
    { skip: !configured },
    async () => {
      const table = await storage!.createTable(actor, databaseId, {
        name: "Multiple subsets",
        fields: [
          { name: "code", type: "text", charLimit },
          { name: "status", type: "text" },
        ],
      });
      const where = {
        field: table.fields[1]!.id,
        op: "eq" as const,
        value: "active",
      };
      const input = {
        fieldIds: [table.fields[0]!.id],
        where,
        expectedSchemaVersion: 1,
      };
      const firstRule = await storage!.createUniqueRule(actor, table.id, input);
      await assert.rejects(
        storage!.createUniqueRule(actor, table.id, {
          ...input,
          expectedSchemaVersion: 2,
        }),
        { code: "UNIQUE_CONFLICT" },
      );
      await storage!.createUniqueRule(actor, table.id, {
        ...input,
        where: { ...where, value: "reserved" },
        expectedSchemaVersion: 2,
      });
      const rows = await Promise.all(
        ["active", "ceased", "ceased"].map((status) =>
          storage!.createRow(actor, table.id, { code: "same", status }),
        ),
      );
      const handed = await storage!.mutateRows(actor, table.id, {
        operations: [
          {
            kind: "update",
            rowId: rows[0]!.id,
            expectedVersion: rows[0]!.version,
            values: { status: "ceased" },
          },
          {
            kind: "update",
            rowId: rows[1]!.id,
            expectedVersion: rows[1]!.version,
            values: { status: "active" },
          },
        ],
      });
      await storage!.updateRow(
        actor,
        table.id,
        rows[1]!.id,
        { status: "ceased" },
        { expectedVersion: handed.rows[1]!.version },
      );
      const race = await Promise.allSettled(
        [handed.rows[0]!, rows[2]!].map((row) =>
          storage!.updateRow(
            actor,
            table.id,
            row.id,
            { status: "active" },
            { expectedVersion: row.version },
          ),
        ),
      );
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = race.find((r) => r.status === "rejected");
      assert(rejected?.status === "rejected");
      assert.equal(rejected.reason.code, "UNIQUE_CONFLICT");
      assert.deepEqual(rejected.reason.details, { ruleId: firstRule.id });
      // An unconditional rule is distinct from conditional rules and still rejects
      // historical duplicates during activation.
      await assert.rejects(
        storage!.createUniqueRule(actor, table.id, {
          fieldIds: input.fieldIds,
          expectedSchemaVersion: 3,
        }),
        { code: "UNIQUE_CONFLICT" },
      );
    },
  );
}

for (const charLimit of [20, 4000]) {
  test(
    `Allowed values and conditional uniqueness share every write boundary (${charLimit})`,
    { skip: !configured },
    async () => {
      const table = await storage!.createTable(actor, databaseId, {
        name: "Choice writes",
        fields: [
          { name: "code", type: "text", charLimit },
          {
            name: "status",
            type: "text",
            allowedValues: ["active", "ceased", "NULL", " Active "],
            default: "ceased",
          },
          {
            name: "required_status",
            type: "text",
            allowedValues: ["active", "ceased"],
            required: true,
            default: "active",
          },
        ],
      });
      const field = table.fields[1]!;
      const rule = await storage!.createUniqueRule(actor, table.id, {
        fieldIds: [table.fields[0]!.id],
        where: { field: field.id, op: "eq", value: "active" },
        expectedSchemaVersion: 1,
      });
      const row = await storage!.createRow(actor, table.id, { code: "same" });
      assert.equal(row.values.status, "ceased");
      assert.equal(row.values.required_status, "active");
      await storage!.createRow(actor, table.id, {
        code: "same",
        status: "active",
      });
      for (const status of [null, "NULL", " Active ", "ceased"])
        await storage!.createRow(actor, table.id, { code: "same", status });
      for (const invalid of ["Active", "active ", "other", ""]) {
        await assert.rejects(
          storage!.createRow(actor, table.id, { code: "new", status: invalid }),
          {
            code: "VALIDATION_FAILED",
            details: { fieldId: field.id, field: field.name },
          },
        );
        await assert.rejects(
          storage!.updateRow(
            actor,
            table.id,
            row.id,
            { status: invalid },
            { expectedVersion: row.version },
          ),
          { code: "VALIDATION_FAILED" },
        );
      }
      await assert.rejects(
        storage!.createRow(actor, table.id, {
          code: "new",
          required_status: null,
        }),
        { code: "VALIDATION_FAILED" },
      );
      const before = await repairState(table);
      for (const source of ["rest", "mcp", "ui", "import"] as const) {
        await assert.rejects(
          storage!.mutateRows(actor, table.id, {
            context: { source },
            operations: [
              {
                kind: "create",
                values: { code: "rolled-back", status: "ceased" },
              },
              {
                kind: "update",
                rowId: row.id,
                expectedVersion: row.version,
                values: { status: "not-listed" },
              },
            ],
          }),
          { code: "VALIDATION_FAILED" },
        );
        assert.deepEqual(await repairState(table), before);
      }
      const repair: RowOperation[] = [
        {
          kind: "update",
          rowId: row.id,
          expectedVersion: row.version,
          values: { status: "not-listed" },
        },
      ];
      await assert.rejects(
        storage!.mutateRows(suppliedRepairActor, table.id, {
          ...(await repairOptions(table.id, repair)),
          operations: repair,
        }),
        { code: "VALIDATION_FAILED" },
      );
      assert.equal(
        (await storage!.getRow(actor, table.id, row.id)).version,
        row.version,
      );
      await assert.rejects(
        storage!.updateRow(
          actor,
          table.id,
          row.id,
          { status: "active" },
          { expectedVersion: row.version },
        ),
        { code: "UNIQUE_CONFLICT", details: { ruleId: rule.id } },
      );
      // Exercise the authoritative trigger directly, without validateValues.
      await assert.rejects(
        withOrg(app!, actor.orgId, async (c) => {
          const mutationId = newId();
          await c.query(
            "INSERT INTO rootset_control.mutations(id,org_id,table_id,input_hash,actor,context,schema_version) VALUES($1,$2,$3,'raw-fixture','{}','{}',2)",
            [mutationId, actor.orgId, table.id],
          );
          await c.query("SELECT set_config('rootset.mutation_id',$1,true)", [
            mutationId,
          ]);
          await c.query(
            `UPDATE "${table.schemaName}"."${table.physicalName}" SET "f_${field.id.toLowerCase()}"='not-listed' WHERE row_id=$1`,
            [row.id],
          );
        }),
        { code: "23514", detail: field.id },
      );
      assert.equal(
        (await storage!.getRow(actor, table.id, row.id)).values.status,
        "ceased",
      );
    },
  );
}

test(
  "Allowed-value changes validate existing rows, defaults, add-field backfill and conversion without rewriting values",
  { skip: !configured },
  async () => {
    let table = await storage!.createTable(actor, databaseId, {
      name: "Choice schema",
      fields: [
        { name: "status", type: "text" },
        { name: "number", type: "integer" },
      ],
    });
    const row = await storage!.createRow(actor, table.id, {
      status: "in-use",
      number: 1,
    });
    const fieldId = table.fields[0]!.id;
    const patch = { allowedValues: ["new"], expectedSchemaVersion: 1 };
    await assert.rejects(
      storage!.updateField(actor, table.id, fieldId, patch),
      {
        code: "VALIDATION_FAILED",
        details: { rowId: row.id, fieldId, field: "status" },
      },
    );
    const preview = await storage!.previewSchemaChange(actor, table.id, {
      expectedSchemaVersion: 1,
      change: {
        kind: "update_field",
        fieldId,
        changes: { allowedValues: ["new"] },
      },
    });
    assert.equal(preview.valid, false);
    assert.equal(preview.conflicts[0]!.rowId, row.id);
    assert.equal((await storage!.getTable(actor, table.id)).schemaVersion, 1);
    assert.equal(
      (await storage!.getRow(actor, table.id, row.id)).values.status,
      "in-use",
    );
    table = await storage!.updateField(actor, table.id, fieldId, {
      allowedValues: ["in-use", "new"],
      expectedSchemaVersion: 1,
    });
    await assert.rejects(
      storage!.updateField(actor, table.id, fieldId, {
        allowedValues: ["new"],
        expectedSchemaVersion: table.schemaVersion,
      }),
      { code: "VALIDATION_FAILED" },
    );
    await assert.rejects(
      storage!.updateField(actor, table.id, fieldId, {
        allowedValues: ["in-use", "new"],
        default: "invalid",
        expectedSchemaVersion: table.schemaVersion,
      }),
      { code: "VALIDATION_FAILED" },
    );
    await assert.rejects(
      storage!.createField(actor, table.id, {
        name: "required_choice",
        type: "text",
        allowedValues: ["ok"],
        required: true,
        default: "wrong",
        expectedSchemaVersion: table.schemaVersion,
      }),
      { code: "VALIDATION_FAILED" },
    );
    table = await storage!.createField(actor, table.id, {
      name: "required_choice",
      type: "text",
      allowedValues: ["ok"],
      required: true,
      default: "ok",
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage!.getRow(actor, table.id, row.id)).values.required_choice,
      "ok",
    );
    const optional = await storage!.createField(actor, table.id, {
      name: "optional_choice",
      type: "text",
      allowedValues: ["ok"],
      expectedSchemaVersion: table.schemaVersion,
    });
    table = optional;
    assert.equal(
      (await storage!.getRow(actor, table.id, row.id)).values.optional_choice,
      null,
    );
    const numberId = table.fields.find((f) => f.name === "number")!.id;
    await assert.rejects(
      storage!.updateField(actor, table.id, numberId, {
        type: "text",
        allowedValues: ["2"],
        conversion: { strategy: "stringify" },
        expectedSchemaVersion: table.schemaVersion,
      }),
      { code: "VALIDATION_FAILED" },
    );
    table = await storage!.getTable(actor, table.id);
    assert.equal(table.fields.find((f) => f.id === numberId)!.type, "integer");
    table = await storage!.updateField(actor, table.id, numberId, {
      type: "text",
      allowedValues: ["1"],
      conversion: { strategy: "stringify" },
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage!.getRow(actor, table.id, row.id)).values.number,
      "1",
    );
    const updated = await storage!.updateRow(
      actor,
      table.id,
      row.id,
      { status: "new" },
      {
        expectedVersion: (await storage!.getRow(actor, table.id, row.id))
          .version,
      },
    );
    table = await storage!.updateField(actor, table.id, fieldId, {
      allowedValues: ["new"],
      expectedSchemaVersion: table.schemaVersion,
    });
    assert.equal(
      (await storage!.getRow(actor, table.id, row.id)).version,
      updated.version,
    );
    table = await storage!.updateField(actor, table.id, fieldId, {
      allowedValues: null,
      expectedSchemaVersion: table.schemaVersion,
    });
    await storage!.createRow(actor, table.id, {
      status: "arbitrary",
      number: "1",
    });
    assert.equal(
      table.fields.find((f) => f.id === fieldId)!.allowedValues,
      null,
    );
  },
);

test(
  "Allowed-value activation serializes with writers and checks the final existing-row set",
  { skip: !configured },
  async () => {
    const table = await storage!.createTable(actor, databaseId, {
      name: "Choice race",
      fields: [{ name: "status", type: "text" }],
    });
    await storage!.createRow(actor, table.id, { status: "active" });
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const changing = storage!.updateField(
      actor,
      table.id,
      table.fields[0]!.id,
      {
        allowedValues: ["active"],
        expectedSchemaVersion: 1,
        context: {
          beforePublish: async () => {
            if (++calls === 2) {
              reached();
              await held;
            }
          },
        },
      },
    );
    await started;
    let written = false;
    const rejected = assert.rejects(
      storage!.createRow(actor, table.id, { status: "ceased" }).finally(() => {
        written = true;
      }),
      { code: "VALIDATION_FAILED" },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(written, false);
    } finally {
      release();
    }
    await changing;
    await rejected;
    const next = await storage!.createTable(actor, databaseId, {
      name: "Choice writer wins",
      fields: [{ name: "status", type: "text" }],
    });
    await storage!.createRow(actor, next.id, { status: "ceased" });
    await assert.rejects(
      storage!.updateField(actor, next.id, next.fields[0]!.id, {
        allowedValues: ["active"],
        expectedSchemaVersion: 1,
      }),
      { code: "VALIDATION_FAILED" },
    );
    assert.equal((await storage!.getTable(actor, next.id)).schemaVersion, 1);
  },
);
