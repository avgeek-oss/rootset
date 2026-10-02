"use client";

import type { CapacityStatus } from "@rootset/contracts";
import type { OperationalMetrics } from "@rootset/observability/schema";
import { DateLabel, Record, RecordList, Section, Status } from "./ui";

export function exactBytes(value: string | null): string {
  return value === null
    ? "Not configured or measured"
    : `${BigInt(value).toLocaleString()} bytes`;
}

export function StorageCapacity({
  capacity,
}: {
  capacity: CapacityStatus | null;
}) {
  return (
    <Section
      title="Measured storage capacity"
      description="Installation usage comes from PostgreSQL database size. Organisation usage includes native relations and retained control tuples. Filesystem free space is a separate worker measurement."
    >
      {!capacity ? (
        <p role="status">
          Storage measurements are unavailable. Refresh health to retry.
        </p>
      ) : (
        <>
          <p>
            <Status value={capacity.admission.state} /> ·{" "}
            {capacity.admission.enabled
              ? "Growth admission checks enabled"
              : "No quota or disk reserve configured"}
          </p>
          {capacity.admission.reason && (
            <p role="status">{capacity.admission.reason}</p>
          )}
          <RecordList>
            <Record
              title="Installation usage"
              description={exactBytes(capacity.installation.usedBytes)}
            />
            <Record
              title="Installation quota"
              description={exactBytes(capacity.installation.quotaBytes)}
            />
            <Record
              title="Available installation quota"
              description={exactBytes(
                capacity.installation.availableQuotaBytes,
              )}
            />
            {capacity.organisation && (
              <>
                <Record
                  title="Current organisation usage"
                  description={`${exactBytes(capacity.organisation.usedBytes)} · ${capacity.organisation.orgId}`}
                />
                <Record
                  title="Current organisation quota"
                  description={exactBytes(capacity.organisation.quotaBytes)}
                />
                <Record
                  title="Available organisation quota"
                  description={exactBytes(
                    capacity.organisation.availableQuotaBytes,
                  )}
                />
              </>
            )}
            <Record
              title="Reported filesystem free space"
              description={exactBytes(capacity.disk.reportedAvailableBytes)}
            />
            <Record
              title="In-flight headroom claims"
              description={exactBytes(capacity.disk.headroomClaimsBytes)}
            />
            <Record
              title="Effective filesystem headroom"
              description={exactBytes(capacity.disk.effectiveAvailableBytes)}
            />
            <Record
              title="Minimum disk reserve"
              description={exactBytes(capacity.disk.minimumFreeBytes)}
            />
            <Record
              title="Filesystem report"
              description={
                <>
                  <DateLabel value={capacity.disk.reportedAt} /> ·{" "}
                  {capacity.disk.fresh ? "fresh" : "stale or unavailable"} ·
                  maximum age {capacity.disk.reportMaxAgeSeconds}s
                </>
              }
            />
            {capacity.disk.volumes.map((volume) => (
              <Record
                key={volume.name}
                title={`Volume ${volume.name}`}
                description={`${exactBytes(volume.availableBytes)} free of ${exactBytes(volume.totalBytes)}`}
              />
            ))}
          </RecordList>
        </>
      )}
    </Section>
  );
}

export function InstallationMetrics({
  metrics,
}: {
  metrics: OperationalMetrics;
}) {
  const database = metrics.database;
  return (
    <Section
      title="Operational metrics"
      description="Request counters cover this API process since its last start. PostgreSQL and worker measurements show the installation's current operational state."
    >
      <p className="settings-muted">
        Collected <DateLabel value={metrics.collectedAt} /> · process started{" "}
        <DateLabel value={metrics.processStartedAt} /> · uptime{" "}
        {Math.floor(metrics.uptimeSeconds).toLocaleString()}s
      </p>
      {metrics.signals.length > 0 && (
        <RecordList>
          {metrics.signals.map((signal, index) => (
            <Record
              key={`${signal.code}-${index}`}
              title={signal.code.replaceAll("_", " ")}
              description={signal.message}
            >
              <Status value={signal.severity} />
            </Record>
          ))}
        </RecordList>
      )}
      <RecordList>
        <Record
          title="Requests / errors / timeouts"
          description={`${metrics.requests.total.toLocaleString()} / ${metrics.requests.errors.toLocaleString()} / ${metrics.requests.timeouts.toLocaleString()}`}
        />
        <Record
          title="Row-limit / storage / rate-limit refusals"
          description={`${metrics.requests.rowLimitRejections.toLocaleString()} / ${metrics.requests.storageAdmissionRejections.toLocaleString()} / ${metrics.requests.rateLimitRejections.toLocaleString()}`}
        />
        <Record
          title="Logging failures"
          description={metrics.requests.loggingFailures.toLocaleString()}
        />
        {Object.entries(metrics.pools).map(
          ([name, pool]) =>
            pool && (
              <Record
                key={name}
                title={`${name} connection pool`}
                description={`${pool.total} connections, ${pool.idle} idle, ${pool.waiting} waiting; maximum ${pool.maximum}`}
              />
            ),
        )}
      </RecordList>
      <h3>PostgreSQL and background work</h3>
      {!database ? (
        <p role="status">
          Database metrics are unavailable. Check the health signals and refresh
          to retry.
        </p>
      ) : (
        <RecordList>
          <Record
            title="Database / WAL directory / temporary bytes"
            description={`${exactBytes(database.databaseBytes)} / ${exactBytes(database.walDirectoryBytes)} / ${exactBytes(database.temporaryBytes)}`}
          />
          <Record
            title="Connections"
            description={`${database.connections.active} active, ${database.connections.idle} idle, ${database.connections.idleInTransaction} idle in transaction; ${database.connections.total} of ${database.connections.maximum}`}
          />
          <Record
            title="Deadlocks / committed / rolled-back transactions"
            description={`${database.deadlocks} / ${database.transactionsCommitted} / ${database.transactionsRolledBack}`}
          />
          <Record
            title="Jobs"
            description={`${database.jobs.queued} queued, ${database.jobs.running} running, ${database.jobs.failed} failed, ${database.jobs.expiredLeases} expired leases, ${database.jobs.retried} retries`}
          />
          <Record
            title="Workers"
            description={`${database.workers.freshReady} ready, ${database.workers.stale} stale, ${database.workers.degraded} degraded`}
          />
          <Record
            title="Email delivery"
            description={`${database.email.pending} pending, ${database.email.sending} sending, ${database.email.failed} failed, ${database.email.retrying} retrying`}
          />
          <Record
            title="Schema and indexes"
            description={`${database.schema.pending} pending schema jobs, ${database.schema.failed} failed; ${database.schema.buildingIndexes} indexes building, ${database.schema.failedIndexes} failed, ${database.schema.invalidIndexes} invalid`}
          />
          <Record
            title="Backups"
            description={`${database.backups.verified} verified, ${database.backups.failed} failed; ${database.backups.pendingNotifications} pending notifications, ${database.backups.failedNotifications} failed notifications`}
          />
          <Record
            title="Recovery coverage"
            description={`${database.backups.databasesWithoutVerifiedBackup} databases without a verified recovery point`}
          />
          <Record
            title="Last verified backup"
            description={<DateLabel value={database.backups.lastVerifiedAt} />}
          />
          <Record
            title="Retained storage"
            description={`${database.storage.liveRows} live rows, ${database.storage.historyEvents} history events, ${database.storage.retainedTables} retained tables`}
          />
          <Record
            title="Data / index / history / artifact bytes"
            description={`${exactBytes(database.storage.dataBytes)} / ${exactBytes(database.storage.indexBytes)} / ${exactBytes(database.storage.historyBytes)} / ${exactBytes(database.storage.artifactBytes)}`}
          />
          <Record
            title="Database statistics reset"
            description={<DateLabel value={database.statisticsResetAt} />}
          />
        </RecordList>
      )}
      <details>
        <summary>Requests by operation</summary>
        <RecordList>
          {metrics.requests.operations.map((operation) => (
            <Record
              key={operation.operationId}
              title={operation.operationId}
              description={`${operation.requests} requests · ${operation.errors} errors · ${operation.timeouts} timeouts · maximum ${operation.durationMaxMs.toFixed(1)}ms`}
            />
          ))}
        </RecordList>
      </details>
    </Section>
  );
}
