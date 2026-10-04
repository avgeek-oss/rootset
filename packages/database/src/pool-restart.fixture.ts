import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createPool, type PoolClient, type PoolPurpose } from "./index.js";

type Settled = { ok: true } | { ok: false; code: unknown };
type Observation = {
  event?: string;
  pool?: string;
  state?: string;
  error_code?: string;
};
type Backend = { pid: number; started: string };
const backendSQL =
  "SELECT pid, backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid() AND usename=current_user AND datname=current_database()";
const report = (record: Record<string, unknown>) => process.send?.(record);
const settle = (work: Promise<unknown>): Promise<Settled> =>
  work.then(
    () => ({ ok: true }),
    (error: unknown) => ({
      ok: false,
      code: (error as { code?: unknown }).code,
    }),
  );

async function until(
  check: () => boolean | Promise<boolean>,
  milliseconds = 5000,
) {
  const deadline = performance.now() + milliseconds;
  while (!(await check())) {
    assert(
      performance.now() < deadline,
      "Owned native condition must become true within its bound",
    );
    await delay(20);
  }
}

function restartCompletion(cycle: number) {
  let timer: NodeJS.Timeout;
  let receive: (message: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    receive = (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        "cycle" in message &&
        message.type === "restart_complete" &&
        message.cycle === cycle
      )
        resolve();
    };
    process.on("message", receive);
    timer = setTimeout(
      () =>
        reject(new Error("Admitted restart must finish within thirty seconds")),
      30000,
    );
  });
  return {
    promise,
    close: () => {
      clearTimeout(timer);
      process.off("message", receive);
    },
  };
}

export async function runPoolRestartFixture() {
  assert(
    process.send,
    "Native fixture requires the separately admitted IPC executor",
  );
  assert(
    process.env.ROOTSET_TEST_POOL_RESTART === "1",
    "Native restart fixture requires explicit admission",
  );
  const definitions: [PoolPurpose, string][] = [
    ["api", "ROOTSET_TEST_APP_DATABASE_URL"],
    ["admission", "ROOTSET_TEST_APP_DATABASE_URL"],
    ["ddl", "ROOTSET_TEST_DDL_DATABASE_URL"],
    ["identity", "ROOTSET_TEST_IDENTITY_DATABASE_URL"],
    ["worker", "ROOTSET_TEST_APP_DATABASE_URL"],
    ["database", "ROOTSET_TEST_DATABASE_URL"],
  ];
  const urls = definitions.map(([name, key]) => {
    assert(process.env[key], "Protected disposable test URL must be supplied");
    const url = new URL(process.env[key]!);
    assert(["postgres:", "postgresql:"].includes(url.protocol));
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert(
      url.port === "55467",
      "Restart fixture only admits the retained isolated native PostgreSQL port",
    );
    assert(!url.search && !url.hash);
    const expectedRole =
      name === "database"
        ? "rootset_owner"
        : name === "ddl"
          ? "rootset_ddl"
          : name === "identity"
            ? "rootset_identity"
            : "rootset_app";
    assert(
      url.username === expectedRole,
      "Disposable role must match its declared pool purpose",
    );
    return url;
  });
  assert(
    urls.every(
      (url) =>
        url.hostname === urls[0]!.hostname &&
        url.pathname === urls[0]!.pathname,
    ),
    "All test pools must use the same isolated database",
  );
  const pools = definitions.map(([name], index) =>
    createPool(urls[index]!.toString(), name === "api" ? 2 : 1, name),
  );
  const connectionEnds: Promise<void>[] = [];
  const connectionEndFor = new WeakMap<PoolClient, Promise<void>>();
  for (const pool of pools)
    pool.on("connect", (client) => {
      const stream = (
        client as PoolClient & { connection: { stream: EventEmitter } }
      ).connection.stream;
      const ended = new Promise<void>((resolve) =>
        stream.prependOnceListener("close", resolve),
      );
      connectionEnds.push(ended);
      connectionEndFor.set(client, ended);
    });
  for (const pool of pools)
    pool.options.application_name = "rootset_idle_restart_probe";
  const api = pools[0]!,
    monitor = pools[5]!;
  const observations: Observation[] = [];
  const originalLog = console.error;
  console.error = (record: string) => {
    const observation = JSON.parse(record) as Observation;
    assert(
      observation.event === "postgres_pool_connection_failed",
      "Only redacted pool observations may be emitted",
    );
    observations.push(observation);
    originalLog(record);
  };
  let unhandled = 0,
    phase = "warm",
    active: PoolClient | undefined,
    activeWork: Promise<Settled> | undefined;
  const uncaught = () => {
    unhandled++;
    report({ type: "native_uncaught_exception", phase });
  };
  process.on("uncaughtException", uncaught);
  let completed = false;
  try {
    for (let cycle = 1; cycle <= 2; cycle++) {
      phase = `warm_${cycle}`;
      for (const pool of pools) {
        assert.equal((await pool.query("SELECT 1 AS value")).rows[0]?.value, 1);
        assert.equal(pool.idleCount, 1);
      }
      const previousBackends = await Promise.all(
        pools.map(async (pool) => {
          let count: number | undefined, backend: Backend | undefined;
          for (let n = 0; n < 12; n++) {
            const client = await pool.connect();
            try {
              count ??= client.listenerCount("error");
              assert.equal(client.listenerCount("error"), count);
              backend = (await client.query<Backend>(backendSQL)).rows[0]!;
            } finally {
              client.release();
            }
          }
          assert(backend, "Warm native backend identity must be captured");
          return backend;
        }),
      );
      active = await api.connect();
      const activeBackend = (await active.query<Backend>(backendSQL)).rows[0]!;
      const activePID = activeBackend.pid;
      const spare = await api.connect();
      try {
        previousBackends[0] = (await spare.query<Backend>(backendSQL)).rows[0]!;
      } finally {
        spare.release();
      }
      activeWork = settle(active.query("SELECT pg_sleep(6)"));
      await until(
        async () =>
          (
            await monitor.query<{ active: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND state='active' AND wait_event='PgSleep' AND usename='rootset_app' AND datname=current_database()) AS active",
              [activePID, activeBackend.started],
            )
          ).rows[0]?.active === true,
      );
      phase = `restart_${cycle}`;
      const waiter = restartCompletion(cycle),
        started = performance.now(),
        offset = observations.length;
      try {
        report({
          type: "restart_ready",
          cycle,
          activePID,
          activeBackend,
          idlePIDs: previousBackends.map((backend) => backend.pid),
          idleBackends: previousBackends,
          pools: definitions.map(([name]) => name),
          nativeReadArmed: true,
        });
        const result = await activeWork;
        assert(
          !result.ok,
          "Actual restart must reject the owned active native read",
        );
        assert(
          result.code !== "57014",
          "Restart failure must be distinct from a statement timeout",
        );
        const activeEnd = connectionEndFor.get(active);
        assert(
          activeEnd,
          "Owned active connection must have a physical end join",
        );
        await activeEnd;
        active.release(true);
        active = undefined;
        assert(
          performance.now() - started < 6000,
          "Active read must fail before its six-second result",
        );
        await waiter.promise;
        assert.equal(
          unhandled,
          0,
          "No idle or checked-out connection failure may reach uncaughtException",
        );
        await until(() =>
          definitions.every(([name]) =>
            observations
              .slice(offset)
              .some((event) => event.pool === name && event.state === "idle"),
          ),
        );
        assert.equal(
          observations.slice(offset).filter((event) => event.state === "idle")
            .length,
          definitions.length,
          "Each removed idle connection must be observed once",
        );
        assert(
          observations
            .slice(offset)
            .some(
              (event) => event.pool === "api" && event.state === "checked_out",
            ),
          "Owned failed lease must retain its connection error observer until physical closure",
        );
      } finally {
        waiter.close();
      }
      phase = `recover_${cycle}`;
      for (const [index, pool] of pools.entries()) {
        const client = await pool.connect();
        try {
          const fresh = await client.query<{
            pid: number;
            started: string;
            value: number;
            budget: string;
          }>(
            "SELECT pid, backend_start::text AS started, 37 AS value, current_setting('statement_timeout') AS budget FROM pg_stat_activity WHERE pid=pg_backend_pid() AND usename=current_user AND datname=current_database()",
          );
          assert.equal(fresh.rows[0]?.value, 37);
          assert.equal(fresh.rows[0]?.budget, "10s");
          assert(
            fresh.rows[0]!.pid !== previousBackends[index]!.pid ||
              fresh.rows[0]!.started !== previousBackends[index]!.started,
            "Restart must create a fresh native connection",
          );
        } finally {
          client.release();
        }
        const reused = await pool.connect();
        try {
          assert.equal(reused.listenerCount("error"), 1);
          await reused.query("SELECT 1");
        } finally {
          reused.release();
        }
        assert.equal(pool.listenerCount("error"), 1);
      }
      report({
        type: "cycle_passed",
        cycle,
        activeFailureSurfaced: true,
        idleObservations: definitions.length,
        reconnects: definitions.length,
      });
    }
    completed = true;
  } finally {
    phase = "cleanup";
    if (activeWork) await activeWork;
    active?.release(true);
    const ends = await Promise.allSettled(pools.map((pool) => pool.end()));
    await Promise.all(connectionEnds);
    try {
      assert(ends.every((result) => result.status === "fulfilled"));
      assert(
        pools.every(
          (pool) =>
            pool.ended && pool.totalCount === 0 && pool.waitingCount === 0,
        ),
      );
      report({
        type: "pools_closed",
        pools: pools.length,
        completed,
        unhandled,
        physicalClientEndsJoined: connectionEnds.length,
      });
      assert.equal(
        unhandled,
        0,
        "No connection failure may reach uncaughtException during recovery or final closure",
      );
    } finally {
      process.off("uncaughtException", uncaught);
      console.error = originalLog;
    }
  }
}

if (process.env.ROOTSET_TEST_POOL_RESTART === "1") {
  runPoolRestartFixture().then(
    () => {
      report({ type: "passed", acceptance: false });
      process.disconnect?.();
    },
    () => {
      report({ type: "failed", acceptance: false });
      process.exitCode = 1;
      process.disconnect?.();
    },
  );
}
