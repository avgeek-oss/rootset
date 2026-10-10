import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createPool } from "@rootset/database";
import { OperationalObserver } from "./index.js";

const unavailablePool = createPool(
  "postgresql://fixture@127.0.0.1:1/unavailable",
  1,
);
const newId = () => "01K70YA0912YTW9S5J9YZX8K76";
after(() => unavailablePool.end());

test("Structured observations exclude input secrets and reject unbounded labels", () => {
  const logs: string[] = [];
  const observer = new OperationalObserver({
    operatorPool: unavailablePool,
    pools: {},
    log: (record) => logs.push(record),
  });
  const requestId = newId();
  observer.record({
    requestId,
    operationId: "queryRows",
    status: 200,
    durationMs: 5,
    ...{
      url: "https://private.invalid/?token=fixture-secret",
      authorization: "Bearer fixture-secret",
      body: { values: "fixture-secret" },
    },
  });
  observer.record({
    requestId,
    operationId: "queryRows?token=fixture-secret",
    status: 200,
    durationMs: 5,
  });
  observer.record({
    requestId: "fixture-secret",
    operationId: "queryRows",
    status: 200,
    durationMs: 5,
  });
  observer.record({
    requestId,
    operationId: "queryRows",
    status: 500,
    durationMs: 10,
    errorCode: "fixture-secret",
  });
  assert.equal(logs.length, 2);
  assert.ok(logs.every((record) => !record.includes("fixture-secret")));
  assert.deepEqual(Object.keys(JSON.parse(logs[0]!)).sort(), [
    "duration_ms",
    "event",
    "level",
    "operation_id",
    "request_id",
    "status",
    "timestamp",
  ]);
  assert.equal(JSON.parse(logs[0]!).request_id, requestId);
});

test("Cardinality stays bounded and an unavailable database remains unknown", async () => {
  const observer = new OperationalObserver({
    operatorPool: unavailablePool,
    pools: { api: unavailablePool },
    log: () => {},
  });
  for (let index = 0; index < 300; index++)
    observer.record({
      requestId: newId(),
      operationId: `operation${index}`,
      status: 200,
      durationMs: 1,
    });
  const metrics = await observer.metrics();
  assert.equal(metrics.requests.total, 300);
  assert.equal(metrics.requests.operations.length, 256);
  assert.equal(
    metrics.requests.operations.find(
      (operation) => operation.operationId === "other",
    )!.requests,
    45,
  );
  assert.equal(metrics.databaseStatus, "unavailable");
  assert.equal(metrics.database, null);
  assert.ok(
    metrics.signals.some(
      (signal) => signal.code === "DATABASE_METRICS_UNAVAILABLE",
    ),
  );
});

test("A failed log sink preserves completion and exposes its failure", async () => {
  const observer = new OperationalObserver({
    operatorPool: unavailablePool,
    pools: {},
    log: () => {
      throw new Error("fixture-private-sink-error");
    },
  });
  assert.doesNotThrow(() =>
    observer.record({
      requestId: newId(),
      operationId: "queryRows",
      status: 200,
      durationMs: 10,
    }),
  );
  const metrics = await observer.metrics();
  assert.equal(metrics.requests.total, 1);
  assert.equal(metrics.requests.errors, 0);
  assert.equal(metrics.requests.loggingFailures, 1);
  assert.ok(
    metrics.signals.some((signal) => signal.code === "LOG_SINK_FAILED"),
  );
  assert.ok(!JSON.stringify(metrics).includes("fixture-private-sink-error"));
});
