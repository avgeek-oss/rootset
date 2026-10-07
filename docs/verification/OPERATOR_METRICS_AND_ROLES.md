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
age/leases, fresh worker heartbeat, verified backup age, object/SMTP failures and
email retries. State whether a metric is process-local or installation-wide.
Restarted process counters are not a lifetime installation total.

Use aggregate observations without user values, credentials or SQL text. If a
metric cannot be read or validated, report it unavailable rather than zero.
Signals should distinguish a stale worker, expired lease, failed schema/index,
missing recovery point and degraded dependency. Static WAL bytes alone do not
establish imminent filesystem exhaustion.

Keep performance reporting tied to actual PostgreSQL/API/worker/web caps of
4/1/2/1 GiB, total 8 GiB with no extra swap. Record object/mail fixture resources,
browser memory, CPU/disk settings and host contention separately.

## SQL privilege boundary

The fresh baseline creates the required application, identity, trusted DDL and
managed/fixed-function owner boundaries. Runtime logins must not inherit deployment
superuser authority or become protected function owners. Ordinary row/history
writes use restricted roles and enforcement; deployment migration credentials
stay outside API/worker environments.

The DDL service is trusted: authority to alter managed tables includes authority
to alter their policies/triggers. `NOBYPASSRLS` does not protect against hostile
use of a table-owner credential. Test ordinary runtime denials and managed
operations separately, and state that trust boundary when reporting results.

A full recovery must restore the complete SQL membership/ownership/grant graph
along with database state. A database-only dump does not include cluster roles.
The former numbered ownership migrations and multi-organisation upgrade suite
are historical, not a promised upgrade route to the single baseline.

## Genuine verification

Current checks require real pool saturation, dependency failures, process restart,
job/schema recovery and redacted metrics/unknown-state behavior. Source declarations
or old suite totals do not establish these results. Map them to `V1-10`, `V1-23`,
`V1-24`, `V1-29`, `V1-30` and `V1-38` in the
[checklist](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md).
