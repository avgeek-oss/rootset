# Tables, fields and data history

This is the revised V1 storage contract. PostgreSQL 18 holds installation control
records and native typed user tables for the installation's single organisation.
The [checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md) records the required
functional, recovery and five-million-row checks; none is accepted by this design.

## Physical storage and identity

The fresh installation schema comes from
[`0001_baseline.sql`](../packages/database/migrations/0001_baseline.sql). Runtime
user-table changes use a schema executor and durable journal rather than more
installation migrations. Control records live in `rootset_control`; logical
databases use schemas `rsd_<lowercase_database_id>`, tables use
`rst_<lowercase_table_id>`, and user columns use `f_<lowercase_field_id>`. Only
validated internal IDs enter these SQL identifiers. User names are never SQL.

Public IDs are opaque, case-normalised 26-character ULIDs. A field ID is stable
across a rename. New rows get server-generated IDs
inside the new table mappings. IDs identify records and do not grant permission.

A field has one `name`, matching `/^[A-Za-z_]+$/` with length 1–64. Names contain
only ASCII letters and underscores, including a leading underscore; digits are
invalid. They are case-sensitive and unique within the table. The UI label and
JSON row key are that same name. Rename changes both, preserves values and the
internal field ID, and updates current name-based references. Historical values
resolve by field ID and the definition recorded for that event. There is no
separate label or immutable public field key.

Rows carry hidden identity, organisation, positive revision and UTC creation/
update metadata. API responses keep these separate from `values`; clients cannot
write them. A no-op leaves revision, timestamps and cell history unchanged.
Control records also retain table generations/schema versions, field definitions,
rule/index state, schema journals, mutation outcomes, history, jobs and manifests.

The ordinary application role cannot own tables, disable history enforcement,
bypass RLS or issue schema DDL. Identity and trusted DDL services have separate
credentials; deployment migration authority stays out of runtime environments.
The managed-table owner is a PostgreSQL privilege boundary, not another user role.
A trusted DDL credential able to alter owned tables is not safe against hostile
use of that credential. [Runtime architecture](STACK_ARCHITECTURE.md) describes
that boundary. Product permission comes from live Admin/Member/Viewer membership.

## Values and types

Fields are nullable unless required. Creation uses a literal validated default
for omitted fields, otherwise null; patch omission keeps the old value. Explicit
null clears a nullable cell. Empty text, zero, false and null are different values.
Defaults do not rewrite existing rows and cannot contain expressions.

| Type      | PostgreSQL value   | Public contract                                                                                                            |
| --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Text      | `text`             | JSON string; positive Unicode scalar limit, default 4,096. Empty is valid.                                                 |
| URI       | `text`             | JSON string stored as entered; no URI syntax, scheme, host or address validation.                                          |
| URL       | `text`             | JSON string stored as entered; no URL syntax, scheme, host or address validation.                                          |
| Image     | `text`             | Plain URL string with no address validation; the UI displays a thumbnail and edits the URL as text.                        |
| Integer   | `bigint`           | JSON integer within ±9,007,199,254,740,991, with optional inclusive bounds.                                                |
| Float     | `double precision` | Finite JSON number with optional finite inclusive bounds; no string coercion, NaN or infinity.                             |
| Boolean   | `boolean`          | Strict true/false, or null when nullable.                                                                                  |
| Date      | `date`             | Valid `YYYY-MM-DD`, years 0001–9999, optional calendar bounds; no timezone conversion.                                     |
| Time      | `time(3)`          | UTC time of day: `HH:mm:ss` with optional 1–3 fractional digits and mandatory `Z`; emit three digits.                      |
| Date-time | `timestamptz(3)`   | Four-digit-year instant with `T` and mandatory `Z`, 0–3 fractional digits accepted and three emitted; optional UTC bounds. |
| JSON      | `jsonb`            | Typed JSON within byte/depth limits; top-level null clears the cell and nested null is retained.                           |

The field form uses date pickers for date-time minimum and maximum bounds.
Selected dates become midnight UTC; REST/MCP continue to accept UTC instants.
Editing another setting preserves an existing bound until its date is changed.

Time rejects 24:00, leap seconds, offsets and missing `Z`. Date-time rejects
missing/non-UTC zones and excess precision. PostgreSQL sessions and serializers
use UTC. Do not attach today's date to a time-only value. User timezone preferences
convert date-time displays/edits, leave date-only values as calendar dates and
keep time-only cells labelled UTC.

Equivalent JSON object key order/numeric spelling is a no-op; array order matters.
JSON numbers use the finite JavaScript transport domain, with safe integral values.
Reject malformed Unicode, U+0000, silently rounded integers and unsupported depth.
JSON search uses typed operators rather than stringifying the document.

## Limits and capacity

| Limit                            |                              V1 value |
| -------------------------------- | ------------------------------------: |
| Live rows per table              |                             5,000,000 |
| Active fields per table          |                                   200 |
| Canonical user-cell row bytes    |                                65,536 |
| JSON nesting                     |                             32 levels |
| Fields per composite unique rule |                                     8 |
| Active unique rules per table    |                                    16 |
| Synchronous mutation             | 1,000 rows, also request-byte bounded |
| Requested query rows             |                              1–25,000 |
| REST/browser JSON request/result |                                 8 MiB |
| MCP structured result            |                                 1 MiB |
| Interactive query budget         |                            10 seconds |

Measure row bytes using deterministic minified UTF-8 JSON keyed by stable field
IDs, including null cells and full JSON cell contents. This internal accounting
is separate from the public name-keyed row. System metadata/history have separate
accounting. The service and enforcement path use the same canonicaliser.

A database-enforced transactional counter reserves the net live-row change while
holding the table counter lock. Concurrent writers cannot race a prior count.
Rollback releases reservations; a committed deletion frees capacity. Updates and
history do not consume live-row slots.

Measure actual PostgreSQL allocation, filesystem headroom, WAL, indexes and
history, with object usage reported separately. Installation storage pressure
can refuse growth while preserving reads and recovery. There is no organisation
quota. Five million rows per table does not promise unlimited tables on arbitrary
hardware. Performance retains the [approved four-service 8 GiB profile](IMPLEMENTATION_VERIFICATION_CHECKLIST.md#performance-profile).

## Uniqueness and atomic mutations

No user field is unique by default. Single/composite rules support scalar types;
JSON uniqueness is deferred. Text equality is exact and case-sensitive without
implicit trimming/normalisation. Float equality treats positive and negative zero
as equal. A tuple containing null does not participate, allowing multiple nulls.

Use a native unique index when the whole key fits its entry limit. Wide supported
tuples use typed canonical bytes, a digest bucket lock and exact tuple comparison.
A digest collision is not equality. Lock all old/new buckets in deterministic
order; insert/update/delete changes participate in the data transaction. Building
a rule validates all existing rows and actual enforcement before marking it active.
A failed build keeps the previous active rules.

A mutation authorises the live actor, checks schema/row revisions and validates
values before committing rows, revision, counter delta, uniqueness, history and
idempotency outcome together. Retry returns the committed outcome only while the
credential retains current authority. Conflicts and failed/rolled-back writes
create no committed cell history.

Database history enforcement compares old/new cells. Insert records initial
non-null values. Deleting a row removes its cell changelogs in that same transaction; clearing a nullable cell records the former value to null.
Each event records stable row/field IDs, typed before/after values and definitions,
revisions, person/credential/client attribution, request/mutation/source and UTC
time, without authentication material. Same-value updates add no cell event.
Conversions and Admin corrections preserve these same guarantees.

History entries cannot be edited through the API and remain interpretable after a field rename. Deleting a row, field, table or database removes the corresponding cell changelogs; deleted-cell history is unavailable to every role, including Admin. Current live role and OAuth operation consent govern reads and writes. There is no separate
organisation audit resource or organisation deletion workflow.

History keeps the latest 200 saved changes per cell, including initial populated
values and subsequent edits and conversions. PostgreSQL prunes older
entries in the same transaction. No-op and failed writes do not consume history.
There are no schedules, retention settings, archives or table backup/restore
features. The dashboard changelog, API and MCP read the same retained entries.

## Schema changes and recovery

Every change supplies an expected schema version and has an idempotent journal.
The executor locks metadata, validates compatibility/row bytes, performs or
stages DDL and reconciles unfinished work against actual PostgreSQL catalog state.
A rename preserves IDs; adding null fields still adds canonical key bytes.
Required/default/bound/type/unique changes validate existing data and report
incompatibilities without silently coercing or deleting rows.

A populated type conversion makes the table visibly read-only, validates all
source values and writes a shadow generation in bounded batches. Conversion
history stays staged until one cutover publishes generation, schema and mutation.
Before cutover the old generation is authoritative; failure preserves it. After
cutover recovery must not repeat cells/history.
Deleting a field requires explicit handling of dependent unique rules and removes its cell changelogs.

## Queries and windows

One typed AST drives REST, MCP and the grid. Resolve fields by current
name or stable ID through metadata. Bind values as SQL parameters; identifiers
and operators come from internal allowlists. Raw SQL is outside V1.

Text supports equality, prefix, contains and explicit case-insensitive contains;
numbers/temporal values support comparisons/ranges; boolean supports equality;
JSON supports path existence, typed path equality and containment. Null tests
apply to nullable fields. Limit filter depth to 8, predicates to 100, sorts to 8
and JSON paths to 32. Invalid type/operator pairs fail before execution.

Every field is queryable without configuring search indexes. Expensive scans produce an actionable timeout within 10 seconds, followed
by bounded cancellation/physical transport cleanup. Peer requests must remain
usable. A timeout cannot turn an incomplete page into success.

Default order is row ID; other sorts append row ID as a unique tie-breaker. Signed
cursors bind target, schema, query/projection/sort, live authority, last tuple and
expiry. Schema or authority changes can require restart. Live pages are read-
committed, so changed sort values may move rows; snapshot exports give consistent
whole-result traversal.

REST defaults to 5,000 rows and MCP/grid windows to 200. Stop at the first row or
encoded-byte budget, return complete rows and accurate continuation/count/reason.
Do not calculate an exact filtered count for every page. Deep grid navigation
uses bounded windows/anchors rather than unlimited OFFSET and declares supported
jump/loading behavior.

## Exports

Export Requests always export every row and field; the creation modal asks only for CSV or JSONL. CSV/JSONL exports hold a schema barrier through extraction, use a consistent snapshot and return typed UTC data with checksums. Downloads recheck authority and never put reusable keys in URLs.

Row creation is available through REST and MCP. The browser edits existing rows inline and has no Add row action. Rootset does not provide database backup or restore operations. Use the PostgreSQL/provider tooling described in the [recovery runbook](../development/operations/upgrade-and-recovery.md) for installation recovery.
