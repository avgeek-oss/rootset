# REST, browser and MCP

One operation catalog owns input/output validation, role requirements, execution
and the generated OpenAPI/client/MCP contracts. Browser adapters call those same
domain services. Generated inventories are the route/tool reference; do not keep
a second handwritten operation count or endpoint table here.

## Current authority

Resolve the SQL-singleton organisation and the person's live membership for every
request. Enforce Admin, Editor and Viewer capabilities from the
[account contract](ACCOUNT_ARCHITECTURE.md). Validate every nested target against
its real database/table even within a single organisation; an unrelated ID must
not authorize the wrong parent.

Personal REST keys inherit current role permissions and have no selected-operation
or resource whitelist. OAuth MCP credentials additionally require approved
operations. Operation consent has no database/table selection. Member removal,
demotion and credential revocation apply before new effects and before replay of
stored results. Sessions, REST keys and MCP tokens keep their distinct audiences;
a transport/session identifier never replaces authentication.

## Transport

Use JSON Schema 2020-12 and OpenAPI 3.1.2 with strict request/output validation.
Reject unknown fields and invalid types before effects. Return stable error codes,
request IDs and meaningful status codes without secrets or inaccessible values.
Bound JSON requests/results to 8 MiB, and MCP structured results to 1 MiB.

Browser mutations enforce the configured Origin and cookie/CSRF policy. Expose
one HTTPS origin for remote use; loopback HTTP is the local exception. OAuth
retains PKCE, exact redirect/state/issuer/audience/resource checks, single-use
codes, refresh rotation/reuse detection and protected metadata discovery.

Hardware authentication and browser approval have explicit interactive adapters.
Data, schema, operation progress, manual backups and read-only installation health retain the applicable
REST/MCP operation path and current-role checks. Approval binds the exact input,
principal, client and expiry; it cannot add permissions to the credential.

## Fields, rows and queries

A field has one `name` property matching `/^[A-Za-z_]+$/`, length 1–64. Its name is
both the UI label and the key in row `values`. Renaming preserves the internal
field ID. Query compilation resolves names/IDs through metadata; names never
become SQL identifiers and values are parameters.

Require the expected row/schema revision for writes. Commit values, row revision,
uniqueness, row count and cell history together. Synchronous batches contain at
most 1,000 rows and are atomic. Idempotency binds method/operation, principal and
canonical input. A changed request conflicts; retries report the committed
outcome and never redisplay a one-time secret.

Queries support typed filters, projection, sorting and signed cursors. Default
order uses row ID; explicit sort adds row ID as a tie breaker. Cursors bind table,
schema, query and current authority. Incompatible schema/permission changes
require a restart. REST defaults to 5,000 rows, MCP/UI to 200; requested size is
1–25,000. Stop at the byte cap with complete rows and honest continuation metadata.

Cancel timed-out/disconnected work and physically close or return its owned
connection only after it is safe. An expensive scan has a ten-second statement
budget plus bounded transport cleanup; it must not return misleading partial
success or prevent unrelated foreground requests.

## Jobs and artifacts

Import/export, schema work, backup/restore and history archiving can return a job
ID. An accepted request is not terminal success. Progress describes committed
checkpoints; cancellation reports already committed work. Revalidate current role
and OAuth consent before publication or a new effect.

Artifact downloads verify current access and use authenticated streams or bounded,
short-lived handoffs. Never place reusable credentials in URLs. History and
archives resolve their actual table and parent; after table/database deletion,
retained history is an Admin management operation. There are no retained resource
grant exceptions.

Backup policy/schedule and installation configuration/test-email operations do
not exist in V1. `createBackup` explicitly queues an on-demand snapshot; there is
no automatic backup or retention schedule. SMTP/S3 credentials are loaded only
from the deployment environment. Job IDs and status/cancellation/retry operations
remain the protocol for long-running actions; there is no separate jobs UI.

## Verification

Regenerate contracts and check drift. Exercise equivalent supported behavior
through REST, MCP and the rendered browser, including denial, revocation,
concurrency, cancellation, idempotency and typed errors. Record real OAuth-client
compatibility and artifact transfer behavior. Source schemas alone are not runtime
proof.
