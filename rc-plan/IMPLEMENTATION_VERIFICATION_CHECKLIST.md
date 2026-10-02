# Implementation and verification checklist

Baseline: 2026-10-02. Current state: implementation and development verification are in progress; final release-candidate gates remain unsigned. This is the complete v1 acceptance contract for the [architecture documents](README.md).

## Sign-off rule

Every required gate below needs working behavior and evidence against the same release candidate. A checked box means the evidence was reviewed, not merely that code exists. A gate is blocked when its evidence is absent, incomplete, stale, or failing. A scaffold, mock, compile, HTTP acknowledgement, researcher report, or single focused test cannot establish complete implementation.

A gate cannot be waived by renaming it deferred. Changing v1 scope requires a reviewed plan change. Deferred features explicitly listed in the plan index are outside these gates. Installation bootstrap and hardware/browser proof adapters are the documented transport exceptions; ordinary data/admin operations require API/MCP parity.

## Candidate and evidence register

Complete this register when verification begins. Do not replace pending entries with assumed values.

| Item                                                | Value   |
| --------------------------------------------------- | ------- |
| Candidate ID/source commit                          | Pending |
| Immutable image digests                             | Pending |
| Dependency lock/tool versions                       | Pending |
| Control schema/dynamic schema versions              | Pending |
| Public OpenAPI and operation-catalog digest         | Pending |
| MCP protocol/SDK/client versions                    | Pending |
| Installation/benchmark environment                  | Pending |
| Fixture counts, schemas, widths and checksums       | Pending |
| Storage/mail dependencies and versions              | Pending |
| CI run and integration/upgrade reports              | Pending |
| Browser screenshots/traces and accessibility report | Pending |
| Backup/restore manifests and content comparisons    | Pending |
| Implementation reviewer and UTC approval time       | Pending |
| Verification reviewer and UTC approval time         | Pending |
| Remaining failures/approved scope changes           | Pending |

For every gate, add a row in the evidence report with gate ID, test case IDs, artifact/link, command/manual method, tested digest, observed result, UTC timestamp, reviewer and remaining issue. The checked boxes alone are not the evidence report. Never include tokens or production personal/master data in reports.

## Required test matrix

Run typed field cases through the shared service, browser UI, REST and MCP. Run data access with Owner, Admin, Editor, Viewer, personal keys, team keys and OAuth grants. Cover allowed and denied organisation/database/table targets, revoked/expired credentials, and role changes between read and write. Record each case, not just a statement that permissions passed.

Run storage/recovery checks with actual PostgreSQL, not an in-memory substitute. Run artifact/mail checks against isolated compatible services, including permission failures. Browser evidence uses actual rendered routes. Cross-surface tests compare final PostgreSQL values, revisions, history, and job terminal results.

## Repository and development

- [ ] `DEV-01` Fresh clone installs with the documented toolchain and lockfile, without access to Towbar's checkout or private package registry.
- [ ] `DEV-02` Web, API, worker and shared packages build with explicit exports; client bundles contain no server storage/auth modules or secrets.
- [ ] `DEV-03` Format, lint, strict typecheck, relevant unit/integration tests, dependency checks, generated-contract checks and builds pass in CI for the candidate.
- [ ] `DEV-04` `.env.example`, configuration validation, setup instructions and failure messages cover every required runtime setting.
- [ ] `DEV-05` Blank PostgreSQL installs all forward control migrations, managed roles, extensions and readiness state correctly.
- [ ] `DEV-06` Towbar adaptations have source provenance, applicable notices, replaced branding/routes and regression coverage.
- [ ] `DEV-07` OpenAPI/client/MCP inventories are generated reproducibly; intentional changes and accidental drift are distinguishable.
- [ ] `DEV-08` Documented developer commands run on a clean supported environment and do not send production mail or mutate external accounts.

## Organisations and account maintenance

- [ ] `ACC-01` One-time bootstrap creates exactly one initial organisation/Owner under simultaneous setup requests and rejects later unauthorised claims.
- [ ] `ACC-02` User identity and memberships are separate; organisation selection and parent-resource ownership are checked on every surface.
- [ ] `ACC-03` Owner/Admin/Editor/Viewer capabilities and resource inheritance/restriction match the documented matrix.
- [ ] `ACC-04` Role/resource denials cover read, mutate, history, export, schema, backups and member/key administration with each actor type.
- [ ] `ACC-05` Concurrent owner transfer/demotion/removal cannot eliminate the last enabled verified Owner.
- [ ] `ACC-06` Invitations bind email/organisation/role, verify email control, expire/cancel/replay correctly, and cannot escalate to Owner.
- [ ] `ACC-07` Membership/user disablement and grant restriction take effect on the next request, including existing sessions, keys and OAuth access.
- [ ] `ACC-08` Profile updates enforce display/email contracts; email-change verification handles uniqueness races, session/grant revocation and notifications.
- [ ] `ACC-09` Preferences persist timezone/locale/date/time/theme and do not modify rows or create cell audit events.
- [ ] `ACC-10` Account/organisation deletion jobs respect authority, confirmations, retention, source isolation, terminal states and recoverable failure.
- [ ] `ACC-11` Organisation audit has correct actor/client/credential attribution, redaction and restricted query access.
- [ ] `ACC-12` Account/team/settings operations appear in the complete UI/internal API/public API/MCP matrix with required interactive approval states.

## Authentication and emails

- [ ] `AUTH-01` Password login, logout, reset and verification work through real screens and API handlers with enumerations/rate limits controlled.
- [ ] `AUTH-02` An unverified or disabled account cannot bypass required onboarding or obtain a fully authenticated session.
- [ ] `AUTH-03` TOTP enrollment requires confirmation; password login requires the enabled second factor; invalid, expired and replayed proofs fail.
- [ ] `AUTH-04` Recovery codes are protected and single-use under concurrent attempts; password reset does not disable 2FA.
- [ ] `AUTH-05` Actual browser passkey registration/login requires the configured RP/origin and user verification and works with the session/factor policy.
- [ ] `AUTH-06` Wrong origin/RP, expired or replayed challenge, missing user verification and unrelated credential attachment fail.
- [ ] `AUTH-07` Sensitive changes require recent authentication or a client/user/action-bound approval; replay and changed payloads cannot reuse proof.
- [ ] `AUTH-08` Password/email/factor recovery, disablement, logout and sign-out-everywhere revoke the intended sessions/grants without leaving stale authority.
- [ ] `AUTH-09` Browser cookies are Secure/HttpOnly with correct same-origin/CSRF handling; key/token requests do not create sessions.
- [ ] `AUTH-10` Operator lost-factor/owner recovery is rehearsed, bounded, audited and notified without printing credentials.
- [ ] `AUTH-11` Login, invitation, reset, verification, reauthentication, TOTP, passkey and consent screens are reviewed at desktop/mobile in light/dark modes.
- [ ] `AUTH-12` Every account/security email renders correct Rootset branding, links, expiry/context and recipient behavior; plain-text delivery works.
- [ ] `AUTH-13` Transactional outbox retries survive SMTP denial/outage/restart and deduplicate one event without suppressing later distinct events.
- [ ] `AUTH-14` Logs, error output, screenshots and templates contain no unintended password/token/factor/backup-secret disclosure.

## API keys and delegated grants

- [ ] `KEY-01` Personal/team keys have secure secrets, hashed storage, one-time display, expiry, revocation and correct non-secret metadata.
- [ ] `KEY-02` Personal authority intersects current membership/resource/key grants; a role demotion immediately reduces existing-key access.
- [ ] `KEY-03` Team keys retain explicit organisation-owned authority when their creator leaves, and cannot impersonate a user.
- [ ] `KEY-04` Key management and credential delegation cannot mint broader scopes/targets than the caller; privileged changes use bound step-up.
- [ ] `KEY-05` Key rotation/overlap/expiry and revocation are visible and enforced on REST and MCP-supported access paths.
- [ ] `KEY-06` Lost key-creation responses replay metadata without re-displaying secrets; changed idempotent input conflicts.
- [ ] `KEY-07` Personal/team key settings are complete, correctly restricted and reachable through the documented API/MCP account actions.
- [ ] `KEY-08` OAuth grant list/revoke and administrator revocation enforce current ownership/organisation without exposing token material.
- [ ] `KEY-09` Installation hashing/encryption keys persist across restart; documented key rotation retains access to authorised encrypted data.

## Databases and schema lifecycle

- [ ] `DB-01` Database create/list/get/rename/delete work through UI, REST and MCP and preserve organisation isolation.
- [ ] `DB-02` User tables create real PostgreSQL tables with stable generated names; metadata, physical columns and versions match after readback.
- [ ] `DB-03` Internal row IDs are alphanumeric, non-autoincrementing, immutable and absent from visible user grid columns.
- [ ] `DB-04` Field IDs/API keys remain stable across relabelling/order changes; recreating a field gives new identity and retains old history.
- [ ] `DB-05` RLS, role ownership, transaction-local context and restricted DDL prevent cross-organisation access and pooled-session context leakage.
- [ ] `DB-06` Schema journal recovers a process failure before/after DDL without orphan ready metadata, missing triggers or unsafe cleanup.
- [ ] `DB-07` Schema concurrency rejects stale versions and serialises incompatible changes while preserving authorised readers.
- [ ] `DB-08` Field/default/required/bounds changes on populated tables validate existing data and canonical row bytes, including newly added null cells, and report failures without silent coercion/loss.
- [ ] `DB-09` Populated type conversion validates/stages/cuts over with complete history; crashes on either side reconcile to one authoritative generation.
- [ ] `DB-10` Field/rule/index removal resolves dependencies, records schema events and preserves retained cell interpretation.
- [ ] `DB-11` Concurrent/failed index builds check catalogue validity, clean invalid remnants and do not advertise inactive enforcement as ready.
- [ ] `DB-12` Database/table deletion tombstones and access/retention handling are verified across worker interruption and retry.

## Field contract and boundaries

- [ ] `FLD-01` Text round-trips empty, Unicode and multiline input; exact character bound passes and bound+1 fails through all surfaces; unsupported NUL/invalid Unicode reject explicitly.
- [ ] `FLD-02` Text characters versus UTF-8 row bytes are independently correct for ASCII, multibyte characters and astral Unicode.
- [ ] `FLD-03` Integer zero/negative/min/max/safe-JSON extrema round-trip; fractions, overflow and string coercion fail.
- [ ] `FLD-04` Float finite values and inclusive bounds round-trip; NaN/infinities/invalid strings fail and approximate representation is documented.
- [ ] `FLD-05` Boolean true/false/null remain distinct and string/number coercion fails.
- [ ] `FLD-06` Date validates leap years/invalid dates/year range and inclusive bounds, with no timezone shift.
- [ ] `FLD-07` Time accepts/normalises allowed UTC precision and rejects missing Z, offsets, 24:00, leap seconds and excess precision.
- [ ] `FLD-08` Date-time accepts UTC instants/bounds, emits canonical milliseconds, and rejects missing Z/non-Z offsets/invalid dates/excess precision.
- [ ] `FLD-09` Date-time UI viewing/editing uses user timezone; daylight-saving ambiguity is resolved explicitly and nonexistent local times reject.
- [ ] `FLD-10` Time-only cells stay labelled UTC and date-only cells remain unchanged under all preference changes.
- [ ] `FLD-11` JSON object/array/scalar/nested-null round-trip; top-level null clears; malformed/deep/oversized JSON, NUL strings and unsafe/nonfinite numbers fail.
- [ ] `FLD-12` Equivalent JSON key order/numeric spelling is a no-op; changed arrays or values create the expected event.
- [ ] `FLD-13` Required/default/omitted/explicit-null semantics are consistent for every type on create, patch, import, API and MCP.
- [ ] `FLD-14` Invalid bounds/defaults/field keys/duplicate names/system-field writes fail before schema or data mutation.
- [ ] `FLD-15` All field schemas, serializers, OpenAPI examples, MCP outputs and UI editors share the same accepted/rejected case matrix.

## Rows, capacity and concurrency

- [ ] `ROW-01` Row create/get/update/delete and atomic batches work on all surfaces with canonical values, revisions and complete mutation IDs.
- [ ] `ROW-02` Row ID/system metadata cannot be assigned or changed by ordinary input; parent ownership is checked.
- [ ] `ROW-03` Exactly 65,536 canonical user bytes pass and +1 fails for creates, patches, defaults and imports; byte definition is identical at enforcement layers.
- [ ] `ROW-04` A table accepts the 5,000,000th live row and rejects the next; deletes release capacity after commit.
- [ ] `ROW-05` Simultaneous/bulk/import insertions at the capacity boundary cannot exceed it; aborted reservations do not leak count.
- [ ] `ROW-06` Concurrent same-row updates reject a stale revision instead of losing a value; UI retains drafts and exposes current state.
- [ ] `ROW-07` No-op writes retain revision/history; successful writes advance them exactly once.
- [ ] `ROW-08` Equivalent idempotent retries do not duplicate values, rows, history, counters or jobs; changed requests fail.
- [ ] `ROW-09` Invalid batch member, uniqueness failure or stale version rolls back the complete synchronous batch and its history/count changes.
- [ ] `ROW-10` Server restart or network loss around commit returns a reconcilable mutation outcome without falsely claiming failure or success.
- [ ] `ROW-11` Request/batch/field/count/storage admission limits produce documented errors and leave existing records readable.

## Uniqueness

- [ ] `UNI-01` No user column is unique by default; scalar single/composite rules enforce the complete declared tuple.
- [ ] `UNI-02` Case-sensitive text, untrimmed text, null participation and float zero equality match the contract.
- [ ] `UNI-03` Simultaneous insert/update/import conflicts allow only a valid committed tuple under each applicable rule.
- [ ] `UNI-04` Update/delete releases previous participation atomically; rollback restores it and does not block later valid writes.
- [ ] `UNI-05` Long text/composite keys use the verified wide-value strategy; forced digest collision does not confuse different tuples with duplicates.
- [ ] `UNI-06` Rule creation on existing duplicate data reports exact conflicts and cannot become active without installed enforcement.
- [ ] `UNI-07` Rule/index count budgets, build failure, cancellation and restart leave prior rules valid and explain pending maintenance state.
- [ ] `UNI-08` Cross-rule bucket lock order and repeated concurrent mutations do not leave unresolved deadlocks or orphan registry entries.
- [ ] `UNI-09` JSON uniqueness and unsupported custom-normalisation requests reject explicitly rather than providing approximate enforcement.

## Cell and resource history

- [ ] `AUD-01` A changed cell saves old/new typed values, row/field IDs, revisions, actor, request/mutation/source and UTC time atomically.
- [ ] `AUD-02` Create/delete/clear/no-op cases have the documented row and cell events and are distinguishable.
- [ ] `AUD-03` Service, import, schema conversion, restore and approved repair paths preserve attribution and committed history.
- [ ] `AUD-04` Database rollback or failed validation creates no committed cell event; ordinary actors cannot disable or rewrite history enforcement.
- [ ] `AUD-05` Cell lookup by row/field works through API and MCP after row deletion and field rename/removal, with retained-type interpretation.
- [ ] `AUD-06` History reads/export obey resource grants and do not leak inaccessible row values or credential material.
- [ ] `AUD-07` Schema/database/table/rule/index changes have resource audit separate from cell changes.
- [ ] `AUD-08` Staged conversion events remain invisible before cutover and visible exactly once after commit/recovery.
- [ ] `AUD-09` Retention/archive jobs preserve required manifests, report gaps and respect backup/organisation deletion policies.
- [ ] `AUD-10` History lookup/index/partition behavior is measured at the declared accumulated-history scale.

## Query and pagination

- [ ] `QRY-01` Whole-table and selected-column queries expose canonical rows and system IDs/revisions with the same API/MCP field semantics.
- [ ] `QRY-02` Every field type supports its documented operators; null, ranges, text case/prefix/contains and JSON path/containment are covered.
- [ ] `QRY-03` Typed AND/OR groups, predicates, sorting and projections work; unknown fields/invalid type operators fail.
- [ ] `QRY-04` AST/JSON path/depth/predicate/sort caps and parameterised compilation prevent SQL/identifier injection and unbounded expressions.
- [ ] `QRY-05` REST default 5,000, MCP default 200 and sizes 1/1,000/5,000/25,000 work; zero/negative/25,001 reject.
- [ ] `QRY-06` 8 MiB REST and 1 MiB MCP result caps stop on whole rows, report byte-limit reason and resume with no boundary loss for an unchanged result set.
- [ ] `QRY-07` Cursor signing, expiry, query/parent/grant binding and schema incompatibility reject tampering or stale authority.
- [ ] `QRY-08` Stable sort tie-breakers avoid duplicates/skips on unchanged data; live edits have documented behavior and snapshot exports remain consistent.
- [ ] `QRY-09` Empty/last/single-row pages and exact boundary pages report continuation/count accurately without counting the whole table each time.
- [ ] `QRY-10` Indexed and scanning queries have recorded plans/latency; timeouts cancel work and do not return misleading partial success.
- [ ] `QRY-11` Five-million-row grid window navigation avoids unbounded deep OFFSET and proves first/middle/last range behavior.
- [ ] `QRY-12` Count/statistics distinguish approximate/cached/live/exact results; expensive exact counts use authorised jobs.

## API contract

- [ ] `API-01` Every public operation is described in OpenAPI 3.1.2 with inputs, outputs, auth/scopes, errors, headers, examples and job behavior.
- [ ] `API-02` Internal browser/public REST/MCP coverage inventory covers the full catalog, including admin actions and documented interactive adapters.
- [ ] `API-03` Generated client compiles and exercises real endpoints; request/response/media-type/status/nullability conform to schemas.
- [ ] `API-04` Runtime table schema discovery matches actual metadata/storage and does not require unsafe installation-wide spec regeneration.
- [ ] `API-05` Read-only credentials can run read-classified POST queries and cannot invoke mutation/schema/admin operations.
- [ ] `API-06` Bearer-only auth, audience separation, current membership/resource checks and nested-target isolation hold for all routes; organisation roles cannot acquire installation-operator authority.
- [ ] `API-07` Body budgets, malformed/duplicate inputs and unknown envelope keys fail before expensive work with redacted typed errors.
- [ ] `API-08` Rate/concurrency/job admission limits return Retry-After or actionable admission errors and preserve API availability.
- [ ] `API-09` Concurrency/idempotency headers and mutation outcomes conform across creates, patches, deletes, schema and jobs.
- [ ] `API-10` OpenAPI publication and health/status responses expose no credentials, SQL/stack traces or private installation configuration.
- [ ] `API-11` One-time credential results cannot be redisplayed through replay/outcome/report endpoints.
- [ ] `API-12` Unknown and denied resource disclosure policy is consistent across all parent paths and operation classes.

## MCP and OAuth

- [ ] `MCP-01` Real supported MCP clients initialise, discover and call Rootset over the pinned Streamable HTTP version.
- [ ] `MCP-02` Protected-resource and authorisation-server discovery support the configured origin/resource and client compatibility modes.
- [ ] `MCP-03` PKCE, exact redirects, issuer/state/resource binding and single-use codes reject mismatch/replay/concurrent exchange.
- [ ] `MCP-04` Client metadata fetching rejects unsafe network/redirect/size/time behavior and consent correctly identifies provenance/trust.
- [ ] `MCP-05` Consent binds user/organisation/scopes/targets and cannot exceed current authority; deny and revoke paths work.
- [ ] `MCP-06` Access expiry and refresh rotation/inactivity/absolute expiry work; concurrent refresh/reuse revokes correctly.
- [ ] `MCP-07` REST tokens fail at MCP and MCP tokens fail at ordinary REST; documented artifact-bound binary upload/download handoffs validate the MCP credential and original source/target authority. Transport session IDs cannot replace token verification.
- [ ] `MCP-08` Every catalogued data/admin task has typed input/output, correct annotations, permission gates and useful error results.
- [ ] `MCP-09` Structured outputs meet the 1 MiB budget without duplicated row dumps; projection/pagination/export resources preserve current access.
- [ ] `MCP-10` Long tasks return queued job state and inspection/cancel/retry access; terminal success requires domain verification.
- [ ] `MCP-11` Sensitive account/admin tasks return actionable bound browser approval and complete only the approved action.
- [ ] `MCP-12` Tools/resources/discovery do not leak hidden resources, tokens, keys or cross-organisation data.
- [ ] `MCP-13` 401/insufficient-scope challenges, OAuth errors, protocol errors and domain errors are compatible with real clients.

## Spreadsheet and settings

- [ ] `UI-01` Database main sidebar, table secondary sidebar and spreadsheet content match the intended Towbar-style layout in light/dark modes.
- [ ] `UI-02` The viewport renders only visible rows/columns with bounded overscan/cache; scrolling across five million rows does not accumulate all data.
- [ ] `UI-03` Logical long-range scrolling/window anchors work at first/middle/last rows despite browser scroll-height limits.
- [ ] `UI-04` Each of eight types has single-tap editing, keyboard editing/commit/cancel and appropriate validation feedback.
- [ ] `UI-05` Keyboard-only and screen-reader navigation, focus announcements, touch controls, high zoom and reduced-motion paths are reviewed.
- [ ] `UI-06` Pending/saved/error/conflict states are truthful; rejected edits preserve drafts and do not display uncommitted values as saved.
- [ ] `UI-07` Date/time/locale preference viewing and editing obey the canonical storage contract and expose UTC time-only labels.
- [ ] `UI-08` Search/filter/sort/projection changes cancel stale fetches, evict old windows and preserve active drafts safely.
- [ ] `UI-09` Selection/copy/paste validates rectangular batches; small pastes are atomic and large pastes use visible import preview/jobs.
- [ ] `UI-10` Column resize/reorder/freeze and per-user view preferences preserve API keys and data/history.
- [ ] `UI-11` Cell history opens for the intended row/field and shows before/after/actor/time without leaking inaccessible records.
- [ ] `UI-12` Table/field/rule/index configuration shows existing-data conflicts, schema jobs and read-only maintenance state.
- [ ] `UI-13` Backup/import/export/job screens show progress, partial outcomes, terminal verification and actionable failures.
- [ ] `UI-14` Profile/team/key/factor/passkey/connected-app/preference settings implement their permission and step-up contracts.
- [ ] `UI-15` Empty/loading/error/offline/revoked-access states recover predictably and do not freeze or discard drafts.
- [ ] `UI-16` Safari and Chromium desktop plus 390x844 touch/mobile rendered routes have screenshots/traces and no blocking clipping/focus regressions.
- [ ] `UI-17` Large JSON values have bounded previews and lazy editor work; rendering a wide row does not parse/format every offscreen cell.

## Imports, exports and artifacts

- [ ] `IO-01` CSV/JSONL mapping and dry run preserve leading-zero text identifiers and validate every field/type/null/default rule.
- [ ] `IO-02` Import checks row bytes/capacity/uniqueness/revisions and reports exact rejected records with bounded reports.
- [ ] `IO-03` Upsert requires a declared active unique rule or explicit row IDs and rejects ambiguous matches.
- [ ] `IO-04` Large imports checkpoint with committed data/history; retries/restarts do not duplicate rows or events.
- [ ] `IO-05` Cancelled/partially committed imports report partial outcomes; atomic small batches roll back completely on failure.
- [ ] `IO-06` Snapshot exports keep schema/query/data consistent during simultaneous edits and emit canonical date/time/number/JSON values.
- [ ] `IO-07` CSV quoting and optional spreadsheet-safe output do not silently rewrite stored values.
- [ ] `IO-08` Artifacts have exact counts/checksums/expiry and authenticated short-lived retrieval with current resource checks.
- [ ] `IO-09` Oversized/expired/tampered upload/download and lost-response retries fail or reconcile without exposing secrets.

## Backups and restores

- [ ] `BKP-01` Policy UI/API/MCP validates cron/timezone/destination/retention/encryption/runtime and redacts credentials on reads.
- [ ] `BKP-02` Cron preview/runtime agree on UTC occurrences, daylight-saving skip/repeat, scheduler restart and duplicate/overlap handling.
- [ ] `BKP-03` One backup captures one consistent snapshot across all table definitions, rows, rules and retained history during concurrent row edits; schema jobs wait behind the extraction barrier and resume safely after it releases.
- [ ] `BKP-04` Manifest records schema/app/format versions, mappings, snapshot time, counts, object checksums and archive references without auth secrets.
- [ ] `BKP-05` Successful backup requires upload checksums and isolated restore/schema/data/history validation; upload alone stays unverified.
- [ ] `BKP-06` Object permission denial, incomplete upload, checksum corruption and verification failure have distinct visible failure states.
- [ ] `BKP-07` Retention honors policy, preserves the last verified recovery point by default and never deletes unrelated database objects.
- [ ] `BKP-08` New-database restore maps IDs safely, preserves row identity/content/history, rebuilds rules/indexes and exposes data only after validation.
- [ ] `BKP-09` Replacement restore requires approved step-up and a recovery point, stages/cuts over safely, and preserves/recovers the prior database after failure.
- [ ] `BKP-10` Crashes before/after snapshot/upload/verification/cutover resume idempotently with no duplicate runs or source damage.
- [ ] `BKP-11` Restore into a fresh installation is rehearsed with schema/value/history comparisons and encrypted-artifact key recovery.
- [ ] `BKP-12` Missing/rotated encryption keys and incompatible backup formats have explicit recovery/error paths without false success.
- [ ] `BKP-13` Verification/restore temporary namespaces and objects are cleaned safely; cleanup failure is observable.
- [ ] `BKP-14` Backup notifications, job polling and recovery runbook explain verified age and terminal state accurately.

## Jobs and recovery

- [ ] `JOB-01` Leases and heartbeats admit one active worker per job and recover expired leases after process failure.
- [ ] `JOB-02` Retries use durable operation/batch identities and reconcile external upload or DDL state before replay.
- [ ] `JOB-03` Progress is tied to committed checkpoints; cancellation and partial outcomes disclose already committed work.
- [ ] `JOB-04` Job get/list/cancel/retry/artifact access rechecks requester/target/current authority and hides unrelated jobs.
- [ ] `JOB-05` Worker restart, duplicate scheduler, queue backlog and external outage do not lose jobs or exhaust foreground connection capacity.
- [ ] `JOB-06` Every job kind reaches a reviewed terminal or recoverable state, with redacted error detail and bounded retry policy.

## Performance profile and scale gates

Engineering acceptance profile, updated by user review on 2026-10-02: an 8 GiB combined runtime budget, enforced as PostgreSQL 4 GiB, API 1 GiB, worker 2 GiB and web server 1 GiB. The local Docker host provides up to 8 CPUs and approximately 98 GiB of storage; record actual CPU allocations, available storage, PostgreSQL buffer settings and contention for each run. Browser memory is measured separately with the thresholds below. Browser-to-API RTT is at most 50 ms; API-to-PostgreSQL RTT is at most 10 ms. All dataset sizes and engineering thresholds remain unchanged. The earlier 32 GiB PostgreSQL / 500 GiB SSD profile described a larger deployment and is not required for this v1 acceptance run. A further changed profile requires a reviewed target update.

Use a five-million-live-row table with 24 fields spanning all eight types and average canonical row size 0.5-1 KiB. Add indexed/unindexed, selective/nonselective and sorted filters, a smaller 200-field near-limit dataset, null/duplicate edge cases, and retained history with at least ten million events including repeated edits to benchmark rows. Record how fixtures were seeded; performance seeding does not substitute for mutation/audit correctness tests. Cold and warm runs are separate. Use at least 1,000 timed requests per interactive scenario, with p50/p95/p99 and errors.

| Scenario                                       | Engineering target                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Indexed 200-row page on five-million-row table | Warm p95 <=500 ms server time; cold p95 <=1.5 s.                                                                           |
| Normal-width REST 5,000-row page               | Warm p95 <=2 s, byte cap respected.                                                                                        |
| Single-cell committed update including history | p95 <=500 ms end-to-end on declared network.                                                                               |
| Cell-history lookup with 200-event page        | Warm p95 <=500 ms server time.                                                                                             |
| First usable spreadsheet viewport              | <=2.5 s cold and <=1 s warm on declared profile.                                                                           |
| Sustained grid scroll                          | At least 50 FPS median, p95 frame time <=32 ms, no >=1 s main-thread freeze.                                               |
| Five-minute wide-range scroll                  | Row-data cache <=50 MiB, total browser memory increase <=150 MiB after warmup and eviction, no monotonic unbounded growth. |
| Expensive unindexed query                      | Cancel/return actionable timeout within 10 s plus bounded transport overhead; service remains usable.                      |

- [ ] `PERF-01` Five-million-row and 200-field/near-byte-limit fixtures exist with schemas, distributions, counts/checksums and actual hardware recorded.
- [ ] `PERF-02` Indexed query, 5,000-row result and byte-capped 25,000-row request meet targets with plans, percentiles and error rates.
- [ ] `PERF-03` Unindexed text/JSON/range scans and deep navigation remain bounded and preserve foreground health under timeout/cancellation.
- [ ] `PERF-04` Committed edit/history latency meets targets under ten simultaneous active editing clients, with no loss or duplicate history.
- [ ] `PERF-05` Safari/Chromium viewport, scrolling, main-thread responsiveness, cache eviction and memory meet targets on real routes.
- [ ] `PERF-06` Import, index/rule build, schema conversion, backup and verification run alongside reads with bounded pool/worker/disk/WAL effects; timings are recorded.
- [ ] `PERF-07` Near-capacity concurrent admission, large JSON, wide schemas, many nulls and high-history rows do not escape budgets or hang UI/API.
- [ ] `PERF-08` Long-running restart/recovery and repeated table/query switching show no growing resource leaks; failure modes are observable.

## Installation, operations and release candidate

- [ ] `OPS-01` Non-root Docker Compose installation starts web/API/worker/PostgreSQL with durable volumes and documented external-storage configuration.
- [ ] `OPS-02` Liveness/readiness/degraded dependency status accurately reflect migrations, worker heartbeat, database access and service behavior.
- [ ] `OPS-03` Upgrade from the prior supported schema/representative populated fixture uses forward migrations and dynamic-journal reconciliation.
- [ ] `OPS-04` Upgrade failure/rollback limitations and restore-based recovery are rehearsed; clean install is not the sole upgrade evidence.
- [ ] `OPS-05` Metrics/logs cover query/row/history/storage/index/job/backup health with correlation IDs and no secrets.
- [ ] `OPS-06` Disk pressure, connection saturation, SMTP/object outage, stale worker leases and failed schema jobs give actionable operator signals.
- [ ] `OPS-07` Installation disaster recovery restores control-plane/data state and required encryption keys separately from logical database backup.
- [ ] `OPS-08` Backup/restore, owner/factor recovery, key rotation, migration and failed-job runbooks are tested by a reviewer following the written steps.
- [ ] `OPS-09` Build/image/contract/migration/dependency digests are recorded and match every final evidence artifact.
- [ ] `REL-01` All required gates have reviewed passing evidence for the candidate; no unresolved failure is presented as complete.
- [ ] `REL-02` End-to-end rehearsal covers setup, invitation, factors, database/table creation, every typed editor, scoped REST/MCP use, history, backup, restore and restart recovery.
- [ ] `REL-03` A reviewer validates the complete operation coverage matrix and every explicit bootstrap/interactive exception.
- [ ] `REL-04` Implementation reviewer and verification reviewer sign the exact source/image/contract digests and acceptance profile.
- [ ] `REL-05` Release report states implementation and verification outcomes separately from image/source publication and production deployment/health.

## Separate publication and production record

These entries are not implied by implementation acceptance. Complete them only if that work is authorised and performed.

| State                                      | Evidence                                           |
| ------------------------------------------ | -------------------------------------------------- |
| Public source distribution/licence         | Not requested for this initial private repository. |
| Versioned image/package publication        | Pending separate release work.                     |
| rootset.fyi DNS/hosting/TLS                | Pending separate deployment work.                  |
| Production deployment terminal result      | Pending separate deployment work.                  |
| Production health/data/backup verification | Pending separate operating evidence.               |

The approved completion statement identifies the candidate and says which required checks passed, where the evidence is stored, who reviewed it, and whether publication/deployment occurred. If any required gate remains open, report the remaining implementation or verification gap explicitly.
