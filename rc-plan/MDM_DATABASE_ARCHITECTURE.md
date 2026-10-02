# MDM database architecture

Baseline: 2026-10-02. Status: v1 design contract; implementation and verification are in progress. Final acceptance requires the [verification checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md). Related contracts: [accounts](ACCOUNT_ARCHITECTURE.md), [API and MCP](API_AND_MCP_ARCHITECTURE.md), and [stack](STACK_ARCHITECTURE.md).

## Storage model

PostgreSQL 18 stores both management records and user data. A Rootset database is a logical container belonging to one organisation. Each logical database gets a managed PostgreSQL schema. Each logical table gets a physical PostgreSQL table with native typed columns. This follows the physical-table approach documented by [Baserow](https://github.com/baserow/baserow/blob/develop/docs/technical/database-plugin.md).

The control schema is `rootset_control`. Data schemas have generated names such as `rsd_<lowercase_database_id>`; data tables have names such as `rst_<lowercase_table_id>`. User columns use `f_<lowercase_field_id>`. Names fit PostgreSQL's identifier limit and come exclusively from validated server-generated IDs. API keys and display labels never become SQL identifiers.

System metadata has migration-managed schemas. User tables have runtime-managed schemas, recorded in a schema-operation journal. Drizzle migrations manage control records; a dedicated schema executor manages user tables. Mixing runtime tables into a generated static ORM schema is not supported.

## Control records and identity

| Record             | Responsibilities                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Database           | Organisation, stable ID, name, description, schema name, lifecycle, backup policy.                                    |
| Table              | Database/organisation, stable ID, name, physical generation, schema version, row count, lifecycle.                    |
| Field              | Table, stable ID, immutable API key, display label, ordering, type, nullable/default/bounds configuration, lifecycle. |
| Unique rule        | Stable ID, ordered scalar field IDs, null policy, active/building/failed state, enforcement strategy.                 |
| Index              | Stable ID, field/operator coverage, physical identity, build state, size and usage.                                   |
| Schema operation   | Idempotency key, expected schema version, before/after definition, planned DDL, job state, failure/recovery detail.   |
| Mutation           | Actor, request ID, idempotency digest, target table, schema version, commit time, outcome.                            |
| Cell change        | Mutation, row, field, prior/new typed value, prior/new revision, operation and UTC timestamp.                         |
| Resource audit     | Database/table/field/rule/index creation, deletion, renaming, type/bounds changes, backup/restore operations.         |
| Query/export job   | Authorised target and projection, immutable query specification, snapshot/artifact state, limits and result.          |
| Backup/restore job | Policy/run identity, snapshot/manifest, object checksums, verification stage, source/target mapping.                  |

All public resource identifiers are 26-character ULIDs, treated as opaque, case-normalised identifiers. ID generation must use a maintained implementation with secure randomness and collision handling. IDs are not auto-incrementing integers and are never an authorisation mechanism.

Row IDs are unique within their table. Normal API operations cannot set or change them. Trusted restore preserves row IDs within restored table mappings. Importing new rows creates new row IDs; importing updates resolves existing rows by an explicit ID or active unique rule. Logical resource identity is organisation/database/table/row, so restoring into a separate database cannot collide with the original table's identity.

Field API keys match `[A-Za-z][A-Za-z0-9_]{0,63}`, are case-sensitive, and are unique within the table. Leading-underscore names are reserved. API keys are immutable in v1; labels can be renamed. A field removed and recreated with the same label has a new field ID. History always resolves by field ID and stored schema metadata.

## Physical rows

Every physical data table contains hidden system columns:

| Column         | Purpose                                                           |
| -------------- | ----------------------------------------------------------------- |
| `row_id`       | Alphanumeric row identity and primary key.                        |
| `org_id`       | Fixed organisation ownership, checked against the database owner. |
| `row_version`  | Positive bigint revision used for optimistic concurrency.         |
| `created_at`   | UTC creation instant.                                             |
| `updated_at`   | UTC last committed value-change instant.                          |
| `f_<field_id>` | Native typed user column.                                         |

These columns do not appear as user fields in the grid. API/MCP return system identity and revision separately from `values`. No user-supplied system column is accepted. A no-op update leaves the row version and cell history unchanged.

The API database role does not own data tables, cannot bypass row-level security, and cannot run schema DDL. Data-table ownership and DDL belong to a separate worker/migration role. Force organisation RLS and use transaction-local organisation context. Control records also enforce organisation isolation where applicable. Application services additionally enforce database/table grants; RLS is not a substitute for those checks. Customer direct PostgreSQL credentials are outside v1.

## Field types

All fields are nullable by default. `required=true` disallows null. Omitted values on creation use the field default, otherwise null. Omitted values on patch retain the old value. Explicit null clears a nullable cell. Defaults are literals validated against the complete field definition; expression defaults are deferred. Empty text, zero, false, and null remain distinct.

| Type      | PostgreSQL representation   | API contract and validation                                                                                                                                                                                          |
| --------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text      | `text`                      | JSON string; configurable positive character limit, default 4,096. Count Unicode scalar values. Empty string is valid. Row bytes remain bounded independently.                                                       |
| Integer   | `bigint` with bounds        | JSON integer in `[-9007199254740991, 9007199254740991]` for lossless JavaScript transport. Optional inclusive min/max inside this range.                                                                             |
| Float     | `double precision`          | Finite JSON number. Optional inclusive finite min/max. Reject NaN/infinities and coercion from strings. Approximate binary arithmetic is explicit.                                                                   |
| Boolean   | `boolean`                   | JSON true/false, or null if nullable. No string/number coercion.                                                                                                                                                     |
| Date      | `date`                      | Valid `YYYY-MM-DD`, years 0001-9999, optional inclusive min/max. No timezone conversion.                                                                                                                             |
| Time      | `time(3) without time zone` | UTC time-of-day convention; accept `HH:mm:ss` with optional 1-3 fractional digits and mandatory `Z`; emit `HH:mm:ss.SSSZ`. Reject 24:00, leap seconds, offsets, or missing Z.                                        |
| Date-time | `timestamptz(3)`            | Valid four-digit-year ISO/RFC3339-style instant with T and mandatory Z; accept 0-3 fractional digits and emit exactly three. Optional inclusive UTC min/max. Reject timezone-less/non-Z values and excess precision. |
| JSON      | `jsonb`                     | Any JSON value, subject to size/depth limits. Top-level API null clears the cell; nested null is retained. Root JSON null is not a separate populated-cell state.                                                    |

Set PostgreSQL sessions to UTC. Use explicit UTC serializers rather than relying on driver or session formatting. The backend must not parse time-only values by attaching today's date. Date-time min/max compare instants; date bounds compare calendar dates. The UI converts date-time preferences before making a canonical UTC request. UTC time-only cells remain UTC in the UI.

JSON object key order and numeric spelling do not define distinct cell values. Equivalent JSON objects are no-op updates after canonicalisation. Arrays retain order. JSON numbers use the finite IEEE-754/JavaScript transport domain; integral values must fit the safe-integer range, and inputs outside that domain reject instead of silently rounding large identifiers. Decimal fractions use the documented approximate numeric representation. Reject malformed JSON, invalid Unicode, U+0000 in text or JSON strings, and payloads beyond supported nesting/size. Never stringify JSON for a generic text comparison and call that a JSON query.

## Limits and measurement

| Limit                              |                                                                  V1 default |
| ---------------------------------- | --------------------------------------------------------------------------: |
| Live rows per table                |                                                                   5,000,000 |
| Active fields per table            |                                                                         200 |
| Canonical user-cell row bytes      |                                                                      65,536 |
| JSON object/array nesting          |                                                                   32 levels |
| Fields in a composite unique rule  |                                                                           8 |
| Active unique rules                | 16 per table; native unique indexes also consume the secondary-index budget |
| Synchronous mutation batch         |                                   1,000 rows, also bounded by request bytes |
| Requested query rows               |                                                                    1-25,000 |
| REST/browser JSON request/result   |                                                                       8 MiB |
| MCP structured result              |                                                                       1 MiB |
| Interactive query timeout          |                                                                  10 seconds |
| Non-primary secondary index budget |                               16 per table, including native unique indexes |

Measure row bytes from deterministic, minified UTF-8 JSON of the user values keyed by stable field IDs. Include null cells, key bytes, and the complete JSON cell value. System metadata and change history have separate accounting. Implement the same canonicaliser in the service and enforcement path; do not use JavaScript string length or PostgreSQL on-disk size as the row-byte definition.

A table's row-count admission is transactional. A statement-level trigger/counter update or equivalent database-enforced operation reserves the net insert/delete delta while holding the table counter lock. Imports and concurrent writers cannot exceed the limit by racing a prior count query. Updates do not consume new row slots. Deletes release live slots after commit; audit records do not count as live rows. An aborted transaction releases its reservation.

Installation capacity depends on total data, indexes, history, and backups. Operators configure optional PostgreSQL storage quotas and an operational minimum of free disk. Installation quota usage is actual PostgreSQL database allocation; organisation quota usage is native relation allocation plus retained control values. The host reporter measures PostgreSQL data, WAL and custom tablespace filesystems. S3 artifacts have separate measured usage and retention; they do not count as PostgreSQL filesystem space. The [capacity service contract](../packages/capacity/README.md) defines these metrics, growth reservations, stale-report refusal and concurrent-index admission. Configured capacity failures refuse growth while existing data remains readable. V1 does not promise five million rows for unlimited tables on arbitrary hardware.

## Uniqueness

No user field is unique by default. The internal row primary key remains unique. Users can create single-field or composite rules over scalar types. JSON uniqueness is deferred. Text equality is exact, case-sensitive Unicode without implicit trimming or normalisation; use explicit C/binary-compatible comparison semantics. Floats use numeric equality, including equality of positive/negative zero.

If any member of a unique tuple is null, that tuple does not participate. Thus multiple nulls are allowed, matching the [distinct-null PostgreSQL default](https://www.postgresql.org/docs/18/indexes-unique.html). Case-insensitive/custom normalisation rules are deferred. Changes to a field default do not rewrite existing rows.

Use native unique indexes when the complete key is proven to fit PostgreSQL index-entry limits. Do not assume arbitrary long text/composite values fit a B-tree key. For wider permitted scalar tuples, use a transactional uniqueness registry: type-tagged canonical tuple bytes, a digest used to locate/lock a bucket, and exact tuple comparison within that bucket. A digest is not equality. Different tuples with a forced digest collision must remain distinct. A registry has a unique bucket-lock record, indexed entries, and row/rule attribution; the database trigger serialises bucket checks and writes within the row transaction.

Lock multiple affected buckets in deterministic order, covering both old and new tuples. On update remove the previous participation and add the new tuple atomically. Delete releases participation in the same transaction. Unique-rule errors identify fields and a conflict without disclosing an inaccessible row. Do not implement uniqueness as an unlocked `SELECT` followed by `INSERT`.

Rule creation validates the entire table, produces a bounded conflict report plus downloadable report if necessary, and cannot report active until enforcement is installed. Large rule builds are jobs. Keep a documented write barrier during final activation, or a proven concurrent-build strategy. A failed build leaves the prior active rules intact. The implementation spike decides the safe build strategy and verifies native-index and registry paths.

## Mutation and cell history

The shared write service authorises the actor, validates the schema/version and request, locks/reserves necessary resources, checks the expected row revision, and commits values, revision, uniqueness, counter delta, audit events, and idempotency outcome in one transaction.

Install database-level history enforcement for each user table, using mutation context supplied transaction-locally by the trusted service/worker. The API role cannot turn it off. A trigger compares OLD and NEW user cells and records only actual value changes. An insert records initial non-null cell values; the row-create event accounts for empty cells. Delete records former non-null cell values to null plus a row-delete event, preserving the old revision. The event type distinguishes deletion from ordinary clearing. A batch shares a mutation ID and records individual rows/fields.

Each cell event contains organisation/database/table/row/field IDs, old/new values and type metadata, old/new row revisions, actor kind/ID, credential/client attribution, request and mutation IDs, source surface, and UTC time. Retain enough field-definition history to interpret old events after a rename, type change, or deletion. Never store access-token material in attribution.

Changes made by imports, restores, schema conversions, and approved operator repair use the same auditable path. V1 repair is an optional mode of the existing batch mutation operation: at most 1,000 updates of explicit row IDs, each with its expected revision and a required expected schema version. It requires a current verified personal installation operator, `installation:manage`, ordinary `rows:write` and an edit grant for the table. An explicit browser approval binds the exact target, revisions, proposed values and trimmed reason of 1–512 characters. A recent session alone cannot approve it.

Repair admission commits the approval consumption, intent audit, durable job and replay receipt in one control transaction. Its worker uses normal typed validation, uniqueness and history enforcement; native rows, revisions, cell history, completion audit and the durable operation outcome commit in the same data transaction. Current authority and the live uncancelled job lease are checked before publication and receipt replay. Ordinary batches remain synchronous. Direct SQL and trigger bypass are unsupported live repair procedures; full-installation recovery follows the separate recovery runbook. Same-value assignments create no cell event. A failed validation, conflict, uniqueness failure, or rollback creates no committed cell history, though a redacted operational rejection may be logged separately.

The ordinary application role retains read-only access to resource history. Repair completion uses a fixed database routine owned by the managed-table owner, which cannot log in or bypass organisation RLS. It accepts only organisation, job, lease and mutation identifiers, locks the matching live job, and derives the completion actor, context and bounded reason from the bound native mutation and admitted job. It cannot select an arbitrary audit operation, timestamp or before/after payload. The append runs in the same data transaction and preserves the server's current-authority checks; the routine does not replace authentication, resource grants or admission proof validation.

History storage is append-only for ordinary actors. Use partitions appropriate to measured volume, with organisation/table/row/field/time indexes. History remains accessible after row/field deletion under the retained table's permissions. Table/database deletion tombstones metadata and revokes normal data access; retained history requires the explicit history/archive grant. Account and organisation deletion follow the configured retention policy, including backup expiry.

History defaults to retained indefinitely, subject to explicit storage quotas and a configured archive/retention policy. Do not silently purge it to fit a row limit. Each table has an optional retention policy and can run a manual archive job. The worker snapshots a half-open UTC range, encrypts the cells and row events with their field metadata, verifies the uploaded object and checksum, publishes its manifest, and then purges hot events in resumable batches. The history API exposes the covered range and archive ID. Cold artifacts remain retained. Database backups materialise referenced cold events into the encrypted backup payload and fail verification if a required archive is missing; restoring a materialised archive does not report a false hot-history gap.

## Schema changes

Table/field definitions have a monotonic schema version. Every schema operation requires the expected version and has an idempotent journal entry. The schema executor locks the table definition, validates identifiers and data compatibility, executes or stages DDL, and records the committed metadata and schema audit. The system reconciles unfinished operations after a crash using actual PostgreSQL catalogue state and the journal.

Adding a nullable column, relabelling a field, and reordering presentation should have bounded foreground paths. Adding required/default values to populated data, tightening bounds, adding uniqueness, index construction, or changing a type needs a dry run and possibly a job. Changes must also recheck canonical row size: even adding a null cell adds its field-key bytes. A change that would create an oversized existing row cannot activate. Existing invalid rows must be reported, never silently coerced or removed. The user sees the pending operation and any maintenance/read-only state.

PostgreSQL DDL operations have different transaction/lock behavior. In particular, [concurrent index creation](https://www.postgresql.org/docs/current/sql-createindex.html) cannot be treated as ordinary transaction-scoped DDL. A job publishes an index only after catalogue validation, handles invalid leftovers, and does not leave a field/rule marked ready when physical enforcement failed.

A populated-table type conversion uses an explicit conversion plan. It captures the source schema/revision, places the table into a read-only maintenance state for the conversion, validates every value, writes a shadow physical generation in bounded batches, and stages per-cell conversion history where canonical values change. After verification, one cutover transaction publishes the new generation/schema and the committed conversion mutation. History queries exclude uncommitted staged events. A crash before cutover leaves the old generation authoritative; a crash after cutover can be reconciled without replaying cells. Failed conversions preserve the source. Cleanup of old generations follows the recovery retention policy.

Field deletion tombstones its definition and stages physical removal. A field used by a unique rule/index cannot be removed until the user approves removal of those dependencies. Schema removals preserve history and are included in backup manifests. The [PostgreSQL ALTER TABLE documentation](https://www.postgresql.org/docs/current/sql-altertable.html) is the reference for lock/rewrite planning; a load rehearsal is still required.

## Query model

One typed query AST drives API, MCP, UI, and exports. It contains target table, optional projection, bounded filter groups, sort, limit, and opaque cursor. Fields resolve by stable ID or API key through metadata. Values are bound parameters. SQL operators and identifiers come from compiler allowlists. Raw SQL is outside v1.

Text supports exact equality, prefix, contains, and explicit case-insensitive contains. Numeric/temporal types support equality, comparisons, and ranges. Boolean supports equality. JSON supports path existence, typed path equality, and containment; array traversal syntax is documented. All nullable fields support null tests. Bound filter depth to eight, predicates to 100, sorts to eight, and JSON path depth to 32. Invalid type/operator pairs fail before query execution.

Every field is queryable, but arbitrary scans have a ten-second budget. Exact/range indexes use B-tree where suitable; contains uses PostgreSQL trigram indexes when explicitly created; JSON path/containment uses appropriate JSONB indexes. Index the operators users actually need and show build state. A full-scan timeout returns a clear result; it must not freeze the API or silently return an incomplete page. JSON searchability means these structured JSON operators, not automatic substring search across a stringified document.

Default order is row ID ascending. A requested sort appends row ID as a unique tie-breaker. Cursors bind table, schema version, organisation/grant context, projection/filter/sort digest, last sort tuple, and expiry. Validate cursor signatures. Do not expose physical offsets or SQL. Live pagination is read-committed: changes to sort values can move rows between pages. Snapshot exports provide consistent whole-result traversal. Schema or grant changes invalidate incompatible cursors with an explicit restart response.

REST defaults to 5,000 rows, MCP to 200, and UI windows to 200. Requested sizes are 1-25,000. Stop at the earlier row or encoded-byte budget, return only complete rows, and supply `nextCursor`, `hasMore`, returned count, and the stopping reason. Fetch one extra row or maintain equivalent state to establish continuation. Do not perform an exact full-table count for every filtered page. Unfiltered cached/live table counts and asynchronous exact counts are distinguishable.

The spreadsheet uses a window/query-session adapter for bounded loading and jumping. An arbitrary scrollbar position is not implemented as an unlimited deep OFFSET query. The grid spike must prove anchor-based/window navigation and browser scroll-height handling. If a query cannot provide immediate arbitrary jumps, the UI exposes supported navigation and a loading state without changing the five-million-row storage promise.

## Imports and exports

CSV and JSONL import/export are v1 operations. Imports accept a schema/mapping and dry-run report. Preserve text codes and leading zeroes; do not infer identifiers as numbers after an explicit schema exists. Validate all types, UTC formats, bounds, uniqueness, row bytes, and capacity. Upsert requires a declared active unique rule or explicit row IDs; ambiguous matches fail.

Small synchronous batches are all-or-nothing. Large imports are durable jobs with committed batch checkpoints, exact rejected rows/reasons, and an explicit partial-completion state. Never label a partially committed import as wholly failed or succeeded. A cancelled import retains already committed changes and their history; undo is a separate audited operation. Retry resumes by job/batch identity and does not duplicate rows or history.

Exports record a snapshot, schema version, query/projection, row count, format, checksums, and authorised requester. Use the same coordinated schema barrier as backups, scoped to the exported table and held through extraction; concurrent row edits remain permitted. Date/time values use canonical contracts. CSV quoting is correct; any spreadsheet-safe export option is explicit and does not modify stored data. A download verifies current access and uses a short-lived bound URL or authenticated stream. Requests/URLs do not carry reusable API keys.

## Database backups and restores

One backup run captures a single MVCC snapshot across the logical database's table definitions, field/rule/index metadata, live rows, retained history, and pending-operation state needed for interpretation. Hold a coordinated database-level schema-change barrier through snapshot establishment and extraction, releasing it when snapshot readers finish rather than after upload or restore verification. Concurrent row edits remain permitted. An exported MVCC snapshot alone does not freeze PostgreSQL table definitions. Parallel readers import the same exported snapshot; schema jobs wait or report contention instead of changing its source layout. Do not create a backup by paging independent live queries. Avoid unbounded snapshot lifetimes; measure duration/WAL/vacuum effects.

The manifest has database/organisation identity, format version, app/control-schema versions, table/field IDs, schema versions, rules, row/history counts, snapshot time, object lengths/checksums, encryption-key reference, archive references, and completion/verification state. It excludes session secrets, password hashes, factors, API/OAuth token secrets, and unrelated organisation data. Installation disaster-recovery backup is a separate operator procedure covering control-plane credentials and PostgreSQL recovery.

Policy configuration includes an enabled flag, five-field cron, IANA schedule timezone, destination, retention days/count, encryption, maximum runtime, and failure notifications. UTC is the default schedule timezone. Define daylight-saving behavior: nonexistent local occurrences are skipped, repeated occurrences run once at the earlier instant. Persist the next UTC occurrence. A unique policy/scheduled-instant key prevents duplicate runs; default overlap policy skips and records a missed occurrence rather than starting another backup.

Store encrypted artifacts in S3-compatible storage. Credentials are encrypted in control storage and never returned. Retention deletes artifacts only after the newer run passes the configured verification stage, and does not erase the last verified recovery point by default. Credential denial, incomplete upload, checksum mismatch, restore failure, and notification failure remain separate states.

Backup states are queued, snapshotting, uploading, verifying, succeeded, failed, or cancelled. A succeeded run requires checksums and a successful restore/validation into an isolated temporary namespace; the restore compares schema, constraints, row/history counts, and canonical content checksums. Upload completion alone is not backup success. Clean up verification namespaces without touching the source, and record cleanup failures.

Default restore creates a new database within the authorised organisation. Reassign database/table IDs and physical names, preserve row IDs, and map historical field/table identities consistently. Rebuild uniqueness/index enforcement, validate values/counts/checksums, and expose the restored database only after validation. Preserve original audit attribution as historical information; add a restore provenance event. Cross-organisation migration requires an explicit authorised mapping and does not recreate memberships or keys.

Restore activates only rules and indexes that were active in the captured snapshot. Failed or unfinished definitions retain their source state and safe failure attribution as inactive definitions; they require an explicit rebuild and review. Restore cannot turn a previously failed uniqueness declaration into enforced production behavior. Verification compares the original definition attribution as well as the resulting active enforcement.

Discarding a temporary verification namespace removes its copied rows, cell/row history, schema definitions, rule/index metadata and mutation outcomes. Retain only a scrubbed database tombstone, minimal discard audit and restore provenance. An isolated validation copy must not silently accumulate a second retained copy of master data or historical values.

Replacement restore needs a bound step-up action, a current recovery backup, a write barrier, staged restore, verification, and atomic publication of the target generation/mappings. On failure, the existing database remains usable or is returned to its prior state. Document the recovery route for a crash on either side of cutover. Policy editing, manual backup, backup listing, restore, and job inspection have API/MCP equivalents.

## Verification references

Use checklist gates `DB-*`, `FLD-*`, `ROW-*`, `UNI-*`, `AUD-*`, `QRY-*`, `IO-*`, and `BKP-*`. They require database-level enforcement, cross-surface parity, boundary tests, digest-collision testing, actual five-million-row fixtures, interrupted-job recovery, and restore readback. Schema and backup success cannot be inferred from a queued job or a successful HTTP acknowledgement.
