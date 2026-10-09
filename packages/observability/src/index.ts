import type { Pool } from "@rootset/database";
import {
  DatabaseMetricsSchema,
  OperationalMetricsSchema,
  type DatabaseMetrics,
  type OperationalMetrics,
  type OperationalSignal,
} from "./schema.js";
export * from "./schema.js";

export interface RequestObservation {
  requestId: string;
  operationId: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}
export interface ObserverOptions {
  operatorPool: Pool;
  pools: Partial<
    Record<"api" | "ddl" | "identity" | "worker" | "admission", Pool>
  >;
  log?: (record: string) => void;
  now?: () => number;
}
const durationBuckets = [
  10,
  50,
  100,
  250,
  500,
  1000,
  2000,
  5000,
  10000,
  Infinity,
];
type OperationCounter = {
  operationId: string;
  requests: number;
  errors: number;
  timeouts: number;
  durationSumMs: number;
  durationMaxMs: number;
  histogram: number[];
};
const boundedCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
function canonicalDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDates);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry !== null && (key.endsWith("At") || key.endsWith("ResetAt"))
        ? new Date(String(entry)).toISOString()
        : canonicalDates(entry),
    ]),
  );
}

export class OperationalObserver {
  private readonly operations = new Map<string, OperationCounter>();
  private readonly now: () => number;
  private readonly started: number;
  private readonly log: (record: string) => void;
  private total = 0;
  private errors = 0;
  private timeouts = 0;
  private rowLimitRejections = 0;
  private rateLimitRejections = 0;
  private loggingFailures = 0;
  constructor(readonly options: ObserverOptions) {
    this.now = options.now ?? Date.now;
    this.started = this.now();
    this.log = options.log ?? ((record) => console.info(record));
  }

  record(event: RequestObservation): void {
    if (
      !event ||
      typeof event.requestId !== "string" ||
      !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(event.requestId) ||
      typeof event.operationId !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(event.operationId) ||
      !Number.isInteger(event.status) ||
      event.status < 100 ||
      event.status > 599 ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0
    )
      return;
    const operationId =
      this.operations.has(event.operationId) || this.operations.size < 255
        ? event.operationId
        : "other";
    let counter = this.operations.get(operationId);
    if (!counter) {
      counter = {
        operationId,
        requests: 0,
        errors: 0,
        timeouts: 0,
        durationSumMs: 0,
        durationMaxMs: 0,
        histogram: durationBuckets.map(() => 0),
      };
      this.operations.set(operationId, counter);
    }
    const errorCode = boundedCode(event.errorCode)
      ? event.errorCode
      : undefined;
    const failed = event.status >= 400 || !!errorCode;
    const timedOut =
      errorCode === "QUERY_TIMEOUT" ||
      event.status === 408 ||
      event.status === 504;
    this.total++;
    counter.requests++;
    if (failed) {
      this.errors++;
      counter.errors++;
    }
    if (timedOut) {
      this.timeouts++;
      counter.timeouts++;
    }
    if (errorCode === "ROW_LIMIT_REACHED") this.rowLimitRejections++;
    if (event.status === 429) this.rateLimitRejections++;
    counter.durationSumMs += event.durationMs;
    counter.durationMaxMs = Math.max(counter.durationMaxMs, event.durationMs);
    counter.histogram[
      durationBuckets.findIndex((limit) => event.durationMs <= limit)
    ]!++;
    const record = {
      level: failed ? "warn" : "info",
      event: "request_completed",
      timestamp: new Date(this.now()).toISOString(),
      request_id: event.requestId,
      operation_id: operationId,
      status: event.status,
      duration_ms: Math.round(event.durationMs * 1000) / 1000,
      ...(errorCode ? { error_code: errorCode } : {}),
    };
    try {
      this.log(JSON.stringify(record));
    } catch {
      this.loggingFailures++;
    }
  }

  async metrics(): Promise<OperationalMetrics> {
    let database: DatabaseMetrics | null = null;
    try {
      const result = await this.options.operatorPool.query<{
        metrics: unknown;
      }>("SELECT rootset_control.operator_metrics() AS metrics");
      database = DatabaseMetricsSchema.parse(
        canonicalDates(result.rows[0]?.metrics),
      );
    } catch {
      // Unavailable metrics stay explicitly unknown; they are never zero-filled.
    }
    const pools = Object.fromEntries(
      Object.entries(this.options.pools).map(([name, pool]) => [
        name,
        {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          maximum: pool.options.max ?? 10,
        },
      ]),
    );
    const signals: OperationalSignal[] = [];
    const signal = (
      code: OperationalSignal["code"],
      severity: OperationalSignal["severity"],
      component: OperationalSignal["component"],
      message: string,
    ) => signals.push({ code, severity, component, message });
    if (!database)
      signal(
        "DATABASE_METRICS_UNAVAILABLE",
        "critical",
        "database",
        "Operator metrics are unavailable; check PostgreSQL access, runtime-role ownership and migrations.",
      );
    for (const [name, pool] of Object.entries(pools))
      if (pool.waiting > 0 || (pool.total >= pool.maximum && pool.idle === 0))
        signal(
          "POOL_SATURATED",
          "warning",
          "pool",
          `${name} pool is saturated; preserve foreground capacity and inspect long-running work.`,
        );
    if (database) {
      if (database.connections.total >= database.connections.maximum * 0.8)
        signal(
          "DATABASE_CONNECTION_PRESSURE",
          "warning",
          "database",
          "PostgreSQL connections are near their limit; inspect pools and active work.",
        );
      if (
        database.connections.idleInTransaction > 0 &&
        (database.connections.oldestTransactionSeconds ?? 0) > 30
      )
        signal(
          "IDLE_TRANSACTION_PRESSURE",
          "warning",
          "database",
          "A long-lived transaction may block maintenance; inspect transaction and worker ownership.",
        );
      if (
        database.jobs.queued > 0 &&
        (database.jobs.oldestQueuedSeconds ?? 0) > 60
      )
        signal(
          "JOB_BACKLOG",
          "warning",
          "jobs",
          "Queued work is delayed; inspect worker availability, leases and dependency failures.",
        );
      if (database.jobs.expiredLeases > 0)
        signal(
          "JOB_LEASE_EXPIRED",
          "warning",
          "jobs",
          "Expired job leases require worker reconciliation before retrying effects.",
        );
      if (database.workers.freshReady === 0)
        signal(
          "WORKER_STALE",
          "critical",
          "worker",
          "No fresh ready worker heartbeat exists; restart or repair worker polling.",
        );
      if (database.workers.degraded > 0)
        signal(
          "WORKER_DEGRADED",
          "warning",
          "worker",
          "Worker polling reports degraded dependencies; inspect its redacted activity failures.",
        );
      if (database.email.failed > 0)
        signal(
          "EMAIL_DELIVERY_FAILED",
          "warning",
          "email",
          "Transactional email has terminal failures; inspect SMTP settings and message expiry before retry.",
        );
      if (database.email.retrying > 0)
        signal(
          "EMAIL_DELIVERY_RETRYING",
          "warning",
          "email",
          "Transactional email is retrying; inspect SMTP availability while data reads remain available.",
        );
      if (database.schema.failed > 0)
        signal(
          "SCHEMA_JOB_FAILED",
          "warning",
          "schema",
          "Schema jobs failed; inspect journals and reconcile before cleanup or retry.",
        );
      if (database.schema.invalidIndexes > 0)
        signal(
          "INDEX_INVALID",
          "warning",
          "schema",
          "PostgreSQL contains an invalid managed index; reconcile its build before advertising it as ready.",
        );
    }
    if (this.loggingFailures)
      signal(
        "LOG_SINK_FAILED",
        "warning",
        "logging",
        "The structured log sink failed; restore logging without changing completed request outcomes.",
      );
    return OperationalMetricsSchema.parse({
      collectedAt: new Date(this.now()).toISOString(),
      processStartedAt: new Date(this.started).toISOString(),
      uptimeSeconds: Math.max(0, (this.now() - this.started) / 1000),
      requestCounterScope: "process_since_start",
      requests: {
        total: this.total,
        errors: this.errors,
        timeouts: this.timeouts,
        rowLimitRejections: this.rowLimitRejections,
        rateLimitRejections: this.rateLimitRejections,
        loggingFailures: this.loggingFailures,
        operations: [...this.operations.values()]
          .sort((a, b) => a.operationId.localeCompare(b.operationId))
          .map((counter) => ({
            ...counter,
            histogram: counter.histogram.map((count, index) => ({
              upperBoundMs: Number.isFinite(durationBuckets[index])
                ? durationBuckets[index]
                : null,
              count,
            })),
          })),
      },
      pools,
      databaseStatus: database ? "healthy" : "unavailable",
      database,
      signals: signals.slice(0, 32),
    });
  }
}
