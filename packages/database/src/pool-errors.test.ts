import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createPool, type PoolClient } from "./index.js";

test("pool connection failures are observed without raw errors or accumulating checkout listeners", async (t) => {
  const records: string[] = [];
  t.mock.method(console, "error", (record: string) => records.push(record));
  const pool = createPool(
    "postgres://fixture:private@127.0.0.1:1/unused",
    1,
    "api",
  );
  const client = new EventEmitter() as unknown as PoolClient;
  try {
    assert.equal(pool.listenerCount("error"), 1);
    pool.emit("connect", client);
    assert.equal(client.listenerCount("error"), 1);
    for (let i = 0; i < 20; i++) {
      pool.emit("acquire", client);
      pool.emit("release", undefined, client);
    }
    assert.equal(client.listenerCount("error"), 1);
    const error = Object.assign(new Error("private raw SQL and DSN"), {
      code: "57P01",
      detail: "private row value",
    });
    client.emit("error", error);
    assert.equal(records.length, 0);
    pool.emit("error", error, client);
    assert.equal(records.length, 1);
    pool.emit("acquire", client);
    client.emit("error", error);
    pool.emit("release", error, client);
    pool.emit(
      "error",
      Object.assign(new Error("private"), { code: "PRIVATE_SECRET" }),
      client,
    );
    assert.equal(records.length, 3);
    const parsed = records.map((record) => JSON.parse(record));
    assert.deepEqual(
      parsed.map((r) => r.state),
      ["idle", "checked_out", "idle"],
    );
    assert.deepEqual(
      parsed.map((r) => r.error_code),
      ["57P01", "57P01", "UNKNOWN"],
    );
    assert(
      parsed.every(
        (r) =>
          r.pool === "api" && r.event === "postgres_pool_connection_failed",
      ),
    );
    assert(
      records.every(
        (record) => !/private|raw SQL|PRIVATE_SECRET|fixture:/i.test(record),
      ),
    );
  } finally {
    await pool.end();
  }
  assert.equal(pool.ended, true);
  assert.equal(pool.listenerCount("error"), 1);
});
