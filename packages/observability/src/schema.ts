import { z } from "zod";

const count = z.number().int().nonnegative();
const duration = z.number().finite().nonnegative();
const bytes = z.string().regex(/^(0|[1-9][0-9]*)$/);
const instant = z.iso.datetime();
const PoolMetricsSchema = z.strictObject({
  total: count,
  idle: count,
  waiting: count,
  maximum: count,
});
const OperationMetricsSchema = z.strictObject({
  operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/),
  requests: count,
  errors: count,
  timeouts: count,
  durationSumMs: duration,
  durationMaxMs: duration,
  histogram: z.array(
    z.strictObject({ upperBoundMs: duration.nullable(), count }),
  ),
});
export const DatabaseMetricsSchema = z.strictObject({
  databaseBytes: bytes,
  temporaryBytes: bytes,
  temporaryFiles: bytes,
  walDirectoryBytes: bytes,
  walGeneratedBytes: bytes,
  walRecords: bytes,
  transactionsCommitted: bytes,
  transactionsRolledBack: bytes,
  deadlocks: bytes,
  connections: z.strictObject({
    total: count,
    active: count,
    idle: count,
    idleInTransaction: count,
    maximum: count,
    oldestTransactionSeconds: duration.nullable(),
  }),
  jobs: z.strictObject({
    queued: count,
    running: count,
    failed: count,
    expiredLeases: count,
    oldestQueuedSeconds: duration.nullable(),
    retried: count,
  }),
  backups: z.strictObject({
    verified: count,
    failed: count,
    pendingNotifications: count,
    failedNotifications: count,
    lastVerifiedAt: instant.nullable(),
    oldestDatabaseVerifiedAgeSeconds: duration.nullable(),
    databasesWithoutVerifiedBackup: count,
  }),
  email: z.strictObject({
    pending: count,
    sending: count,
    failed: count,
    retrying: count,
    oldestPendingSeconds: duration.nullable(),
  }),
  schema: z.strictObject({
    pending: count,
    failed: count,
    buildingIndexes: count,
    failedIndexes: count,
    invalidIndexes: count,
  }),
  workers: z.strictObject({ freshReady: count, stale: count, degraded: count }),
  storage: z.strictObject({
    activeDatabases: count,
    activeTables: count,
    retainedTables: count,
    liveRows: bytes,
    dataBytes: bytes,
    indexBytes: bytes,
    historyEvents: bytes,
    historyBytes: bytes,
    artifactBytes: bytes,
  }),
  statisticsResetAt: instant.nullable(),
  walStatisticsResetAt: instant.nullable(),
});
export type DatabaseMetrics = z.infer<typeof DatabaseMetricsSchema>;
export const OperationalSignalSchema = z.strictObject({
  code: z.enum([
    "DATABASE_METRICS_UNAVAILABLE",
    "POOL_SATURATED",
    "DATABASE_CONNECTION_PRESSURE",
    "IDLE_TRANSACTION_PRESSURE",
    "JOB_BACKLOG",
    "JOB_LEASE_EXPIRED",
    "WORKER_STALE",
    "WORKER_DEGRADED",
    "EMAIL_DELIVERY_FAILED",
    "EMAIL_DELIVERY_RETRYING",
    "SCHEMA_JOB_FAILED",
    "INDEX_INVALID",
    "BACKUP_FAILED",
    "BACKUP_NOTIFICATION_FAILED",
    "BACKUP_RECOVERY_POINT_MISSING",
    "LOG_SINK_FAILED",
  ]),
  severity: z.enum(["warning", "critical"]),
  component: z.enum([
    "database",
    "pool",
    "jobs",
    "worker",
    "email",
    "schema",
    "backup",
    "logging",
  ]),
  message: z.string().max(300),
});
export type OperationalSignal = z.infer<typeof OperationalSignalSchema>;
export const OperationalMetricsSchema = z.strictObject({
  collectedAt: instant,
  processStartedAt: instant,
  uptimeSeconds: duration,
  requestCounterScope: z.literal("process_since_start"),
  requests: z.strictObject({
    total: count,
    errors: count,
    timeouts: count,
    rowLimitRejections: count,
    rateLimitRejections: count,
    loggingFailures: count,
    operations: z.array(OperationMetricsSchema).max(256),
  }),
  pools: z.partialRecord(
    z.enum(["api", "ddl", "identity", "worker", "admission"]),
    PoolMetricsSchema,
  ),
  databaseStatus: z.enum(["healthy", "unavailable"]),
  database: DatabaseMetricsSchema.nullable(),
  signals: z.array(OperationalSignalSchema).max(32),
});
export type OperationalMetrics = z.infer<typeof OperationalMetricsSchema>;
