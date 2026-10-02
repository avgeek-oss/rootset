# Jobs and dependencies

Use the shared job API/MCP and browser job views to inspect target, requester,
attempt, progress, checkpoint, state and redacted failure code. Preserve request
and job IDs when reporting a failure; omit raw payloads or credentials.

## Lease expiry, cancellation and retry

Only the worker holding the lease token commits a job checkpoint. Each worker
publishes a heartbeat under its own ID. A stale process heartbeat and an expired
job lease are different signals. Restart a failed worker using the same durable
PostgreSQL/object state; a new process ID must not create another copy of an
already committed effect.

Request cancellation through the job operation and wait for a terminal state.
A cancellation response describes committed work; partial import commits remain
visible at a safe checkpoint. Do not delete job records, edit lease tokens or
rewind checkpoints manually. Retry only when the persisted failure is retryable
and current requester/resource authority remains valid. A revoked actor must not
gain authority from an old queued specification.

For a schema job, inspect its durable journal, staging objects and cutover state.
Resume through the executor's reconciliation path. Verify the live schema,
dependent rules/indexes, values and history before cleaning retained staging
objects. A rollback or cancellation must leave the original source usable.

## SMTP outage

Inspect outbox attempts, next retry and redacted failure status. Fix the configured
endpoint, TLS/authentication or provider availability and resume normal delivery.
Persistent outbox events must survive a worker restart; retry must not duplicate
an already delivered logical event. An accepted email-test job is not proof that
the message arrived. Verify the terminal test result and captured/provider
delivery record. Data reads remain available when SMTP alone is degraded.

## Object storage outage or corruption

Inspect artifact and backup states plus storage error codes. Verify endpoint,
bucket, credential permissions and retained encryption key IDs. A failed upload,
read-back or isolated restore must not produce a successful backup record. Retry
uses the persisted run/object identity; do not create a second backup blindly.

If a checksum or authentication tag fails, preserve the artifact and investigate
the source/key/object history. Do not overwrite it with empty content. Restore
creates isolated staging data and validates it before publication; failure must
not damage the existing live database. Check retention does not remove a pinned
or sole last successful recovery point.

## Capacity and foreground health

Monitor PostgreSQL disk, WAL, connection pools, query timeouts, history growth,
index size/build progress, queue delay, stale leases and backup verification age.
Keep worker concurrency bounded so scans/imports/backups do not consume all API
capacity. Unindexed queries time out; a retry cannot silently increase their
budget or bypass byte/row limits. Stop admission when storage pressure threatens
durability and inspect the measured cause before changing operating budgets.

Avoid broad Docker pruning or volume removal as incident response. Identify the
exact installation/project and distinguish temporary artifacts from durable
rows, history, objects and recovery copies. A fixture cleanup must never touch
another product's containers or a customer's installation.

## Recovery rehearsal record

For each scenario record the exact injected failure, source/image/configuration
digests, job/checkpoint before and after, terminal result, data/history comparison,
dependency health and reviewer. The checklist requires disk pressure, connection
saturation, dependency outages, stale leases and failed schema jobs to produce
actionable operator signals. A runbook is not evidence until those steps run.
