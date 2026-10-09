# Installation metrics and SQL roles

Admins manage team settings through their current membership. There is no
operator binding flag or separate Owner role. Product roles and deployment SQL
privileges are different boundaries.

## Useful observations

Request logs should contain only bounded request ID, operation/protocol label,
status, duration and typed error code. Exclude URLs, queries, headers, values,
credentials and raw exception messages. Report a failed log sink visibly without
rewriting an already completed response.

Report actual pool occupancy, request/error/duration counters, connection and
transaction pressure, disk/WAL/temp usage, data/index/history growth, job queue
age/leases, fresh worker heartbeat, object/SMTP failures and
email retries. State whether a metric is process-local or installation-wide.
Restarted process counters are not a lifetime installation total.

Use aggregate observations without user values, credentials or SQL text. If a
metric cannot be read or validated, report it unavailable rather than zero.
Signals should distinguish a stale worker, expired lease, failed schema/index,
missing recovery point and degraded dependency. WAL directory size is unavailable with the ordinary database credential and is
reported as null; WAL generation counters remain available.

Keep performance reporting tied to actual PostgreSQL/API/worker/web caps of
4/1/2/1 GiB, total 8 GiB with no extra swap. Record object/mail fixture resources,
browser memory, CPU/disk settings and host contention separately.

## SQL privilege boundary

Migrations, API and worker use one ordinary PostgreSQL database owner through
`ROOTSET_DATABASE_URL`. It has schema/extension creation permission and no
superuser or `BYPASSRLS` privileges. The baseline creates no extra SQL roles or
privileged definer functions. The installer provisions the database owner for
the local profile; an external database supplies its own owner credential.

Forced row-level security respects an explicit transaction organisation. With
no explicit context, backend identity and maintenance reads use the installation's
sole organisation. API/MCP entry points independently verify current membership,
permissions, credential expiry and the requested organisation before operations.

Database-owner credentials are trusted: their holder can alter schemas, triggers
and policies. They are not an end-user SQL access interface. Recovery preserves
database ownership, database/object state, `ROOTSET_SECRET` and
`ROOTSET_ENCRYPTION_KEY`. Earlier multi-role migrations and upgrade receipts are
historical, not a promised upgrade route to the fresh-install baseline.

## Genuine verification

Current checks require real pool saturation, dependency failures, process restart,
job/schema recovery and redacted metrics/unknown-state behavior. Source declarations
or old suite totals do not establish these results. Map them to `V1-10`, `V1-23`,
`V1-24`, `V1-29`, `V1-30` and `V1-38` in the
[checklist](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md).
