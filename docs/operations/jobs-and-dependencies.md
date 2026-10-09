# Jobs and dependencies

Long-running actions expose progress in their own browser workflow and via the
job API/MCP status operation. There is no standalone Background Jobs screen.
Inspect target, requester, attempt,
progress, checkpoint, state and redacted failure code. Preserve request/job IDs
when reporting a failure; omit raw payloads, SQL, authentication material and
credentials.

## Cancellation, restart and schema work

Only a worker with the current lease token may commit a checkpoint. Its process
heartbeat and a persisted job lease are different signals. Restart with the same
durable PostgreSQL/object state; a new worker process must not duplicate an
already committed effect.

Request cancellation through the supported operation and wait for a terminal
state. Partial import commits stay visible and keep their history. Do not delete
job records, edit leases or rewind checkpoints by hand. Retry only a retryable
failure while the person's live role, credential and any OAuth consent still
permit it. An old queued request cannot preserve revoked access.

For schema work, inspect its journal, staging generation and cutover state.
Resume through reconciliation against actual catalog state. Verify values,
revisions, unique rules and history before removing staging data. Failure or
cancellation before publication must preserve the original source.

## SMTP and object storage

For SMTP failure, inspect outbox attempts, next retry and redacted status. Fix the
endpoint, TLS/authentication or provider availability and resume delivery. Outbox
state survives restart. Verify actual account-email delivery through local capture or provider records.
Change SMTP and S3 settings in `.env` and restart API/worker; the UI has no
configuration overrides or test-email action. SMTP-only failure
should leave data reads available.

For object failure, inspect artifact state, storage errors, endpoint, bucket permissions and the installation encryption key. Retry follows persisted run/object identity. If checksum or authentication-tag verification fails, preserve the object for diagnosis; never replace it with empty content.

## Resources and foreground health

Observe filesystem headroom, WAL/temp growth, pool occupancy, query timeouts,
history/index size, queue age, expired leases and artifact failures. Bound worker
concurrency so imports/scans/exports keep foreground requests usable. An expensive
query must return an actionable timeout within 10 seconds and cancel/join owned
work in bounded cleanup; retry cannot silently expand its budget.

Keep the existing PostgreSQL/API/worker/web allocation at 4/1/2/1 GiB with no added
swap for performance verification. Local object/mail dependencies are separate
fixtures. Report actual contention and capacity failures instead of changing the
accepted target. There is no storage admission policy or reporter. Fixed row/field/payload limits
remain enforced, and native disk failures must be reported without false success.

Do not use broad Docker pruning or volume removal as incident response. Identify
the exact project and distinguish temporary fixture data from durable rows,
history, objects and recovery copies. Cleanup must not touch other products.

Record the injected failure, relevant version/environment, job/checkpoint before
and after, terminal result and native data/history comparison. Outages, process
termination and disk/connection pressure need real rehearsals; this runbook is
not a test result.
