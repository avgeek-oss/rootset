# REST, browser and MCP

One operation catalog owns input/output validation, role requirements, execution
and the generated OpenAPI/client/MCP contracts. Browser adapters call those same
domain services. Generated inventories are the route/tool reference; do not keep
a second handwritten operation count or endpoint table here.

## Current authority

Resolve the SQL-singleton organisation and the person's live membership for every
request. Enforce Admin, Member and Viewer capabilities from the
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

Account/team/member/personal-key name inputs share the trimmed, non-empty
120-character account-name schema used by the Towbar forms. Generated OpenAPI
and MCP schemas carry that bound; data-resource name contracts keep their own
limits. Account email addresses are capped at 320 characters and new passwords
at 15–1,024 characters.

Browser mutations enforce the exact UI Origin and cookie/CSRF policy at the
public API host. Expose separate HTTPS UI and API origins for remote use;
loopback HTTP is the local exception. API sessions use host-only Secure HttpOnly
cookies and exact credentialed CORS. OAuth
retains PKCE, exact redirect/state/issuer/audience/resource checks, single-use
codes, refresh rotation/reuse detection and protected metadata discovery.

Hardware authentication and browser approval have explicit interactive adapters.
Data, schema, operation progress and deployment readiness checks retain the applicable
REST/MCP operation path and current-role checks. Approval binds the exact input,
principal, client and expiry; it cannot add permissions to the credential.

## Browser authentication adapters

Identity routes are an explicit method/path allowlist. They reject API keys and
bearer credentials; a cookie mutation requires the configured exact Origin.
Data APIs/MCP do not inherit browser credential authority. Raw sign-up, password
mutation and profile-mutation shortcuts are unavailable; application adapters
retain reviewed actions and live-role checks.

`POST /v1/public/auth/request-verification-email` takes only `{ email }`, uses no
inherited session, has a fixed login callback and neutral `{ status: true }`
response. `/v1/auth/request-verification-email` is its compatible identity alias.
Public address/email budgets, private delivery limits and the response floor are
specified in the [account contract](ACCOUNT_ARCHITECTURE.md#authentication).
Signed-in `/v1/auth/send-verification-email` is bound to that session's email and
fixed Email & Password callback; callbacks supplied by a client cannot redirect
verification into another origin or account flow.

Email-change links use `/email-change#<proof>` so the proof is absent from the
HTTP request URL and referrer. The browser removes it from its address bar after
reading it, and supports earlier query-based prelaunch links. A strict
`POST /v1/auth/email-change/inspect` validates without effects and returns only
`{ status: "ready" }`; `POST /v1/auth/email-change/confirm` consumes `{ token }`
after an explicit confirmation. Email update, all browser/session/delegated
revocation and encrypted notices are one transaction. Unknown, cancelled,
expired and consumed proofs are unavailable. GET does not confirm a change.

Invitation creation returns `{ ...metadata, inviteUrl }` with an opaque ID in
`/invite/{id}`. `GET /v1/auth/invitations/{id}` previews eligibility.
`POST .../{id}/verify` requests recipient email proof, `POST .../{id}/code`
submits `{ name, code }` and issues a bounded password receipt, and
`POST .../{id}/signup` consumes `{ setupToken, password }` to create the verified
account and membership. `POST .../{id}/accept` accepts an existing matching
verified account. The invitation link is replayable metadata; email codes,
password receipts and recovery codes remain single-use credentials.

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

Import/export, schema work and history archiving can return a job
ID. An accepted request is not terminal success. Progress describes committed
checkpoints; cancellation reports already committed work. Revalidate current role
and OAuth consent before publication or a new effect.

Artifact downloads verify current access and use authenticated streams or bounded,
short-lived handoffs. Never place reusable credentials in URLs. History and
archives resolve their actual table and parent; after table/database deletion,
retained history is an Admin management operation. There are no retained resource
grant exceptions.

Backup/restore and installation configuration/test-email operations do
not exist in V1. Database backup and restore operations are absent. SMTP/S3 credentials are loaded only
from the deployment environment. Job IDs and status/cancellation/retry operations
remain the protocol for long-running actions; there is no separate jobs UI.

## Verification

Regenerate contracts and check drift. Exercise equivalent supported behavior
through REST, MCP and the rendered browser, including denial, revocation,
concurrency, cancellation, idempotency and typed errors. Record real OAuth-client
compatibility and artifact transfer behavior. Source schemas alone are not runtime
proof.
