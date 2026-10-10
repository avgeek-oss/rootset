import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { newId, limits, type QuerySpec, type Row } from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import { TableStorage } from "../../packages/table-storage/src/index.js";
import { fieldColumn } from "../../packages/table-storage/src/query.js";
import {
  loadScaleFixture,
  fixtureActor,
  hardware,
  type ScaleFixture,
} from "./scale-fixture.js";
import { closePools, fixtureSecret, testPools } from "./environment.js";
import { sourceProvenance } from "./source-provenance.js";

interface Measurement {
  id: string;
  scope: string;
  requests: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  errors: Record<string, number>;
  targetP95Ms?: number;
  measuredTargetMet?: boolean;
}
const code = (error: unknown): string =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "INTERNAL_ERROR";
const percentile = (sorted: number[], value: number): number =>
  sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]!;
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function measure(
  id: string,
  scope: string,
  request: (index: number) => Promise<unknown>,
  targetP95Ms?: number,
): Promise<Measurement> {
  const timings: number[] = [],
    errors: Record<string, number> = {};
  for (let index = 0; index < 1000; index++) {
    const start = performance.now();
    try {
      await request(index);
    } catch (error) {
      errors[code(error)] = (errors[code(error)] ?? 0) + 1;
    }
    timings.push(performance.now() - start);
    if ((index + 1) % 100 === 0)
      process.stdout.write(
        JSON.stringify({ scenario: id, requests: index + 1, errors }) + "\n",
      );
  }
  timings.sort((a, b) => a - b);
  const result = {
    id,
    scope,
    requests: timings.length,
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    p99Ms: percentile(timings, 0.99),
    minMs: timings[0]!,
    maxMs: timings.at(-1)!,
    errors,
    ...(targetP95Ms
      ? {
          targetP95Ms,
          measuredTargetMet:
            percentile(timings, 0.95) <= targetP95Ms &&
            Object.keys(errors).length === 0,
        }
      : {}),
  };
  process.stdout.write(JSON.stringify({ scenario: id, result }) + "\n");
  return result;
}

export async function benchmarkScaleFixture(
  filename: string,
  onlyScenario?: string,
): Promise<void> {
  const fixture = await loadScaleFixture(filename),
    actor = fixtureActor(fixture),
    pools = testPools();
  const storage = new TableStorage({
    pool: pools.app,
    ddlPool: pools.ddl,
    cursorSecret: fixtureSecret("ROOTSET_SECRET"),
  });
  const directory = dirname(resolve(filename));
  await mkdir(directory, { recursive: true });
  const provenance = await sourceProvenance();
  const report: Record<string, unknown> = {
    kind: "scale-benchmark",
    sourceCommit: provenance.sourceCommit,
    dirty: provenance.dirty,
    startedAt: new Date().toISOString(),
    fixture: resolve(filename),
    environment: hardware(),
    seedEnvironment: fixture.environment,
    scope:
      "Actual PostgreSQL API-role shared storage service. HTTP/OAuth/browser/network/cold-cache/profile/reviewer evidence is separate and remains required.",
    acceptance: false,
    results: [] as Measurement[],
  };
  const results = report.results as Measurement[];
  const save = async () =>
    writeFile(
      join(
        directory,
        onlyScenario ? `benchmark-${onlyScenario}.json` : "benchmark.json",
      ),
      JSON.stringify(
        { ...report, lastUpdatedAt: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
  try {
    const table = await storage.getTable(actor, fixture.tableId);
    assert.equal(table.rowCount, 5000000);
    assert.equal(table.fields.length, 24);
    const actual = await pools.owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quote(table.schemaName)}.${quote(table.physicalName)}`,
    );
    assert.equal(Number(actual.rows[0]?.count), 5000000);
    const history = await pools.owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rootset_control.cell_changes WHERE table_id=$1",
      [table.id],
    );
    assert.ok(Number(history.rows[0]?.count) >= 10000000);
    report.actualFixture = {
      liveRows: Number(actual.rows[0]?.count),
      retainedHistoryEvents: Number(history.rows[0]?.count),
      schemaVersion: table.schemaVersion,
    };
    const indexed: QuerySpec = {
      where: { field: "INTEGER_A", op: "gte", value: 2500000 },
      orderBy: [{ field: "INTEGER_A", direction: "asc" }],
      limit: 200,
    };
    const plan = await withOrg(pools.app, actor.orgId, (client) =>
      client.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM ${quote(table.schemaName)}.${quote(table.physicalName)} WHERE ${quote(fieldColumn(table.fields.find((field) => field.name === "INTEGER_A")!))} >= $1 ORDER BY ${quote(fieldColumn(table.fields.find((field) => field.name === "INTEGER_A")!))},row_id LIMIT 200`,
        [2500000],
      ),
    );
    report.indexedPlan = plan.rows;
    report.coldEvidence = {
      status: "pending",
      reason:
        "The seeded PostgreSQL/OS caches are warm. Restart and OS-cache evidence on the declared profile must be recorded separately; first request is not relabelled cold.",
    };
    await save();

    const scenarios: Record<string, () => Promise<Measurement>> = {
      indexed200: () =>
        measure(
          "SCALE-INDEXED-200",
          "Warm 200-row indexed typed page with native rows and JSON serialization",
          async (index) => {
            const page = await storage.queryRows(actor, table.id, {
              ...indexed,
              where: {
                field: "INTEGER_A",
                op: "gte",
                value: 2500000 + index * 10,
              },
            });
            assert.equal(page.data.length, 200);
            assert.ok(
              Buffer.byteLength(JSON.stringify(page)) <= limits.restResultBytes,
            );
          },
          500,
        ),
      result5000: () =>
        measure(
          "SCALE-RESULT-5000",
          "Warm normal-width 5,000-row page and complete encoded REST result budget",
          async (index) => {
            const page = await storage.queryRows(actor, table.id, {
              ...indexed,
              where: {
                field: "INTEGER_A",
                op: "gte",
                value: 2500000 + index * 10,
              },
              limit: 5000,
            });
            assert.equal(page.data.length, 5000);
            assert.ok(
              Buffer.byteLength(JSON.stringify(page)) <= limits.restResultBytes,
            );
          },
          2000,
        ),
      result25000: () =>
        measure(
          "SCALE-RESULT-25000",
          "Requested 25,000-row pages stop at actual 8 MiB budget on complete rows",
          async (index) => {
            const page = await storage.queryRows(actor, table.id, {
              ...indexed,
              where: {
                field: "INTEGER_A",
                op: "gte",
                value: 2500000 + index * 10,
              },
              limit: 25000,
            });
            assert.ok(page.data.length > 0 && page.data.length <= 25000);
            assert.ok(
              Buffer.byteLength(JSON.stringify(page)) <= limits.restResultBytes,
            );
            assert.equal(page.page.stopReason, "byte_limit");
            assert.ok(page.page.nextCursor);
          },
        ),
      history200: () =>
        measure(
          "SCALE-HISTORY-200",
          "Warm 200-event cell lookup within ten million retained events",
          async (index) => {
            const rowId = ((index % 1000) + 1)
              .toString(16)
              .toUpperCase()
              .padStart(26, "0");
            const history = await storage.cellHistory(
              actor,
              table.id,
              rowId,
              table.fields.find((field) => field.name === "INTEGER_A")!.id,
            );
            assert.equal(history.data.length, 200);
            assert.equal(history.hasMore, true);
          },
          500,
        ),
      scanText: () =>
        measure(
          "SCALE-SCAN-TEXT",
          "Unindexed nonselective text scan of all five million live rows; timeouts recorded explicitly",
          async () =>
            storage.queryRows(actor, table.id, {
              where: {
                field: "TEXT_A",
                op: "contains",
                value: "missing-needle",
              },
              limit: 200,
            }),
        ),
      scanJson: () =>
        measure(
          "SCALE-SCAN-JSON",
          "Unindexed JSON containment scan of all five million live rows; timeouts recorded explicitly",
          async () =>
            storage.queryRows(actor, table.id, {
              where: {
                field: "JSON_A",
                op: "jsonContains",
                value: { g: 99999 },
              },
              limit: 200,
            }),
        ),
      scanRange: () =>
        measure(
          "SCALE-SCAN-RANGE",
          "Unindexed range scan on INTEGER_B with no matches, actual five million live rows",
          async () =>
            storage.queryRows(actor, table.id, {
              where: { field: "INTEGER_B", op: "lt", value: -1 },
              limit: 200,
            }),
        ),
    };
    if (
      onlyScenario &&
      !scenarios[onlyScenario] &&
      !["capacity", "edit10", "navigation", "timeout"].includes(onlyScenario)
    )
      throw new Error("Unknown benchmark scenario.");
    const selected = onlyScenario
      ? [onlyScenario]
      : [
          "capacity",
          ...Object.keys(scenarios),
          "edit10",
          "navigation",
          "timeout",
        ];
    for (const scenario of selected) {
      if (scenarios[scenario]) results.push(await scenarios[scenario]());
      else if (scenario === "capacity")
        report.capacity = await verifyCapacity(fixture, storage, pools.owner);
      else if (scenario === "navigation") {
        const ranges = [];
        let sessionId: string | undefined;
        for (const position of ["first", "middle", "last"] as const) {
          const start = performance.now(),
            window = await storage.queryWindow(actor, table.id, {
              position,
              query: { limit: 200 },
              sessionId,
            });
          sessionId = window.sessionId;
          assert.equal(window.totalRows, 5000000);
          assert.equal(window.result.data.length, 200);
          ranges.push({
            position,
            returned: window.result.data.length,
            durationMs: performance.now() - start,
            firstId: window.result.data[0]!.id,
            lastId: window.result.data.at(-1)!.id,
            anchorsReady: window.anchorsReady,
          });
        }
        report.navigation = ranges;
      } else if (scenario === "edit10")
        report.edit10 = await verifyConcurrentEdits(fixture, storage);
      else if (scenario === "timeout")
        report.timeout = await verifyTimeout(
          fixture,
          storage,
          pools.ddl,
          pools.owner,
        );
      await save();
    }
    report.finishedAt = new Date().toISOString();
    await save();
  } catch (error) {
    report.failure = {
      code: code(error),
      name: error instanceof Error ? error.name : "UnknownError",
    };
    throw error;
  } finally {
    const final = await sourceProvenance();
    report.sourceAtEnd = final;
    report.finishedAt ??= new Date().toISOString();
    await save();
    await closePools(pools);
  }
}

async function verifyCapacity(
  fixture: ScaleFixture,
  storage: TableStorage,
  owner: ReturnType<typeof testPools>["owner"],
): Promise<Record<string, unknown>> {
  const actor = fixtureActor(fixture),
    t = await storage.getTable(actor, fixture.tableId);
  assert.equal(t.rowCount, 5000000);
  await assert.rejects(
    storage.createRow(
      actor,
      t.id,
      { INTEGER_A: 1 },
      { idempotencyKey: newId() },
    ),
    (error) => code(error) === "ROW_LIMIT_REACHED",
  );
  const last = await storage.queryRows(actor, t.id, {
    orderBy: [{ field: "INTEGER_A", direction: "desc" }],
    limit: 1,
  });
  const before = last.data[0]!;
  await storage.deleteRow(actor, t.id, before.id, {
    expectedVersion: before.version,
    idempotencyKey: newId(),
  });
  assert.equal((await storage.getTable(actor, t.id)).rowCount, 4999999);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      storage.createRow(
        actor,
        t.id,
        { ...before.values },
        { idempotencyKey: newId() },
      ),
    ),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (outcome) =>
        outcome.status === "rejected" &&
        code(outcome.reason) === "ROW_LIMIT_REACHED",
    ).length,
    9,
  );
  assert.equal((await storage.getTable(actor, t.id)).rowCount, 5000000);
  const actual = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${quote(t.schemaName)}.${quote(t.physicalName)}`,
  );
  assert.equal(Number(actual.rows[0]?.count), 5000000);
  const triggers = await owner.query(
    "SELECT t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND t.tgname=$3",
    [t.schemaName, t.physicalName, "rootset_enforce"],
  );
  assert.equal(triggers.rows[0]?.tgenabled, "O");
  return {
    id: "SCALE-CAPACITY-BOUNDARY",
    gates: ["V1-16", "V1-34"],
    result: "passed",
    actualLiveRows: 5000000,
    concurrentAttempts: 10,
    committed: 1,
    rejected: 9,
    source:
      "Actual API database role, enabled row enforcement trigger, transactionally committed counter; performance seed is not correctness evidence.",
    fixtureMutation:
      "Deleted one row then recreated its canonical values with one new internal ID. Baseline seed checksums precede this audited mutation.",
  };
}

async function verifyConcurrentEdits(
  fixture: ScaleFixture,
  storage: TableStorage,
): Promise<Record<string, unknown>> {
  const actor = fixtureActor(fixture),
    rows: Row[] = (
      await storage.queryRows(actor, fixture.tableId, { limit: 10 })
    ).data;
  assert.equal(rows.length, 10);
  const histories = await Promise.all(
    rows.map((row) =>
      storage.cellHistory(
        actor,
        fixture.tableId,
        row.id,
        fixture.fields.find((field) => field.name === "INTEGER_A")!.id,
        { limit: 25000 },
      ),
    ),
  );
  const timings: number[] = [];
  await Promise.all(
    rows.map(async (initial, client) => {
      let row = initial;
      for (let index = 0; index < 100; index++) {
        const began = performance.now();
        row = await storage.updateRow(
          { ...actor, id: `${actor.id}:client-${client}` },
          fixture.tableId,
          row.id,
          { INTEGER_A: Number(row.values.INTEGER_A) + 1 },
          {
            expectedVersion: row.version,
            idempotencyKey: newId(),
            context: { requestId: newId(), source: "rest" },
          },
        );
        timings.push(performance.now() - began);
      }
    }),
  );
  for (const [index, row] of rows.entries()) {
    const current = await storage.getRow(actor, fixture.tableId, row.id);
    assert.equal(BigInt(current.version), BigInt(row.version) + 100n);
    const currentHistory = await storage.cellHistory(
      actor,
      fixture.tableId,
      row.id,
      fixture.fields.find((field) => field.name === "INTEGER_A")!.id,
      { limit: 25000 },
    );
    assert.equal(
      currentHistory.data.length,
      histories[index]!.data.length + 100,
    );
    const committed = currentHistory.data.filter((event) => {
      const version = BigInt(String(event.new_version));
      return (
        event.actor !== null &&
        typeof event.actor === "object" &&
        "id" in event.actor &&
        event.actor.id === `${actor.id}:client-${index}` &&
        version > BigInt(row.version) &&
        version <= BigInt(current.version)
      );
    });
    assert.equal(committed.length, 100);
    assert.equal(
      new Set(committed.map((event) => event.mutation_id)).size,
      100,
    );
    assert.deepEqual(
      committed
        .map((event) => BigInt(String(event.new_version)))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      Array.from(
        { length: 100 },
        (_, event) => BigInt(row.version) + BigInt(event + 1),
      ),
    );
  }
  timings.sort((a, b) => a - b);
  return {
    id: "SCALE-EDIT-TEN-CLIENTS",
    requests: timings.length,
    clients: 10,
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    p99Ms: percentile(timings, 0.99),
    errors: 0,
    committedHistoryEvents: 1000,
    targetP95Ms: 500,
    measuredTargetMet: percentile(timings, 0.95) <= 500,
    scope:
      "Storage service end-to-end locally; declared network/browser/API auth evidence remains required.",
  };
}

async function verifyTimeout(
  fixture: ScaleFixture,
  storage: TableStorage,
  pool: ReturnType<typeof testPools>["ddl"],
  observer: ReturnType<typeof testPools>["owner"],
): Promise<Record<string, unknown>> {
  const actor = fixtureActor(fixture),
    table = await storage.getTable(actor, fixture.tableId),
    connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT set_config('rootset.org_id',$1,true)", [
      actor.orgId,
    ]);
    await connection.query(
      `LOCK TABLE ${quote(table.schemaName)}.${quote(table.physicalName)} IN ACCESS EXCLUSIVE MODE`,
    );
    const began = performance.now();
    const pending = assert.rejects(
      storage.queryRows(actor, table.id, { limit: 200 }),
      (error) => code(error) === "QUERY_TIMEOUT",
    );
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const waiting = await observer.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
        [`%${table.physicalName}%`],
      );
      blocked = waiting.rows[0]!.count > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      blocked,
      true,
      "The real query must reach a PostgreSQL relation lock wait.",
    );
    const foreground = performance.now();
    const other = await storage.queryRows(actor, fixture.wideTableId, {
      select: ["FIELD_A"],
      limit: 1,
    });
    assert.equal(other.data.length, 1);
    const unaffectedTableQueryMs = performance.now() - foreground;
    await pending;
    const durationMs = performance.now() - began;
    assert.ok(durationMs >= 9000 && durationMs <= 13000);
    await connection.query("ROLLBACK");
    const recovered = await storage.queryRows(actor, table.id, { limit: 200 });
    assert.equal(recovered.data.length, 200);
    return {
      id: "SCALE-TIMEOUT-RECOVERY",
      result: "passed",
      durationMs,
      unaffectedTableQueryMs,
      foregroundWhileBlocked: true,
      recoveredRows: recovered.data.length,
      scope:
        "Actual PostgreSQL statement timeout while waiting for a relation lock; scan-specific timings are separate.",
    };
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const filename = process.argv[2];
  if (!filename)
    throw new Error(
      "Pass the completed scale-fixture.json path and optionally one scenario. Every interactive scenario records 1,000 actual timed requests.",
    );
  await benchmarkScaleFixture(filename, process.argv[3]);
}
