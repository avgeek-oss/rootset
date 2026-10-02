// These are review instructions, never inferred outcomes. A reviewer must
// inspect the linked assertions and retained results for every named condition.
const source = `
DEV-01|Fresh exported clone: install frozen lock without sibling Towbar/private registry; record toolchain and successful install log.
DEV-02|Build all four services/packages; inspect actual browser chunks for server-only imports and seeded secret sentinels; verify exported imports resolve.
DEV-03|Retain candidate CI job results for format/lint/strict types/tests/dependency/generated drift/build; match every log to source and lock digest.
DEV-04|Compare Config schema and shipped example/docs; omit or invalidate each required setting and verify bounded useful startup error without values.
DEV-05|Migrate a blank real cluster with restricted runtime logins; inspect extensions, objects, ownership, reporter and readiness; compare ledger checksums.
DEV-06|Trace each copied Towbar source and applicable notice; inspect replaced branding/routes and its actual regression behavior.
DEV-07|Generate spec/client/tools twice from the same catalog; compare bytes/digests; introduce controlled drift and require check failure.
DEV-08|Run every documented developer command from clean export with dedicated dependencies; inspect destination allowlist and no external mail/account mutation.
ACC-01|Race actual bootstrap claims: exactly one org/Owner/setup receipt; later unauthorized claims denied; email verification activates that one membership.
ACC-02|One user in two orgs: persist selection, exercise each surface, reject wrong-parent paths and prevent selection from granting peer resources.
ACC-03|Enumerate Owner/Admin/Editor/Viewer plus org/database/table grants; verify inherited allow and narrower restrictions at each operation ceiling.
ACC-04|For session/personal/team/OAuth actors, execute positive and negative read/mutate/history/export/schema/backup/member/key cases and verify no denied side effects.
ACC-05|Race transfer, demotion, removal and disablement; committed metadata always retains at least one enabled verified Owner.
ACC-06|Invite exact email/org/role; accept only verified matching user; expire/cancel/replay/race acceptance; Owner invitation and authority escalation fail.
ACC-07|Keep issued sessions/keys/OAuth alive while disabling user/member or narrowing grants; next read/write must reflect current authority on each surface.
ACC-08|Exercise name/email bounds, duplicate email races and verified change completion; inspect exact revoked sessions/grants and delivered security notifications.
ACC-09|Persist all preference fields then read via UI/API/MCP; native rows/revisions/cell-event count remain unchanged.
ACC-10|Approve account/org deletion as current authorized identity; inspect durable admission, confirmations, terminal outcome, retained data/backup policy, peer preservation and retry failure recovery.
ACC-11|Query real account audit as allowed/denied actors; match actor/client/credential IDs to operation and ensure password/token/key/factor material absent.
ACC-12|Review every account/team/settings catalog branch and rendered route; execute adapter approvals and parity outcomes, including personal/operator exceptions.
AUTH-01|Use actual login/logout/reset/verification screens and protocol handlers; compare generic unknown-user responses and actual rate rejection; session lifecycle changes persist.
AUTH-02|Unverified and disabled users attempt session acquisition and protected routes; verify onboarding boundary and absence of fully active authority.
AUTH-03|Begin/confirm TOTP, password-login pending factor then proof; invalid/expired/replayed code denies; native factor remains disabled before confirmation.
AUTH-04|Race one recovery code through two pending sessions: exactly one succeeds; ciphertext/hashed persistence and password reset preserving factor verified.
AUTH-05|Actual browser WebAuthn create/get with configured RP/origin and user verification; confirm returned session satisfies existing factor policy.
AUTH-06|Actual WebAuthn negative origin/RP/challenge-expiry/replay/no-UV/unrelated credential cases reject without attaching or logging a credential.
AUTH-07|Stale recent-auth and delegated callers require bound action; wrong user/client/action/input, replay and concurrent consume cannot broaden approval.
AUTH-08|Password/email/factor recovery, disablement, logout and all-session revocation: inspect intended session/token families and prove next-request denial.
AUTH-09|Inspect HTTPS cookie flags and actual same-origin/CSRF negatives; bearer-only requests never create browser-session cookies/rows.
AUTH-10|Follow written operator factor/Owner recovery steps; inspect scope, audit and actual notification; no credential material printed.
AUTH-11|Capture actual auth/invite/reset/verify/reauth/TOTP/passkey/consent routes in light/dark desktop/mobile and review form/focus/validation behavior.
AUTH-12|Render every email template in HTML/text; inspect Rootset links/expiry/context/recipient and actual SMTP delivered message content.
AUTH-13|Deny SMTP, restart delivery process and restore mail service; same event delivers once, a distinct later event still delivers, pending differs from sent.
AUTH-14|Inspect actual failure logs/traces/screenshots/templates with secret sentinels; exclude auth/factor/key/encryption material without deleting required domain errors.
KEY-01|Issue personal/team keys through service and UI; compare one-time secret with hashed-only storage, exact metadata, expiry and next-request revocation.
KEY-02|Use issued personal key before/after membership demotion/resource narrowing; resulting scopes/targets are the live intersection, no cached authority.
KEY-03|Issue scoped team key, remove/disable creator then use it; explicit team access survives, user profile/factor/operator impersonation remains denied.
KEY-04|Attempt wider scope/target key creation/rotation as each actor; denied requests create no credential; bound step-up permits only exact authorized request.
KEY-05|Rotate with declared overlap then expire/revoke old/new key; test REST and documented MCP-mediated management paths with exact time boundaries.
KEY-06|Lose issuance response, replay same key then change input; replay has metadata without secret and changed request conflicts with one persisted key.
KEY-07|Render personal/team key lists, issuance, one-time dismissal, rotation/revoke and restrictions; execute corresponding API/MCP action approvals.
KEY-08|List/revoke own OAuth grants and administrator-authorized grants; wrong user/org denied; resulting token families unusable and token material absent.
KEY-09|Restart with retained hash/encryption keys; rotate active encryption key while old key remains; remove required old key and observe explicit recovery failure.
DB-01|Create/list/get/rename/delete database via actual UI/REST/MCP; native metadata and wrong-org absence agree, including retained tombstone policy.
DB-02|Read metadata and pg_catalog after table creation: stable generated namespace/name, physical eight types, fields and schema version match.
DB-03|Create many rows and inspect IDs/defaults: ULID alphanumeric immutable, no serial integer sequence; UI user-column headers exclude system ID.
DB-04|Rename/reorder field then recreate it; stable original IDs/API keys, new recreated ID and old history interpretation must agree in native storage.
DB-05|Restricted real logins, concurrent pool reuse and peer org queries; verify forced RLS/current context/reset plus protected-role denial, documenting trusted DDL-owner boundary.
DB-06|Kill schema process before/after actual DDL, restart reconciliation; metadata generation/catalog/triggers and owned remnants reach one authoritative state.
DB-07|Race incompatible changes and stale expected schema versions with authorized reads; exactly permitted serialization, no stale publication or stranded reader.
DB-08|Alter required/default/bounds/add-null field on populated near-byte-limit data; preflight/execution agree and invalid changes preserve schema/data/history.
DB-09|Convert populated type with valid/invalid values; inspect staging invisibility/history, terminate either side of cutover and reconcile single authoritative generation.
DB-10|Remove field with dependent rules/indexes; explicit dependency resolution and schema audit persist, old cell values retain their original field definition.
DB-11|Actual concurrent index build validity and failed/invalid catalog remnants; retry/cancel/restart never labels unenforced index ready.
DB-12|Delete table/database through durable worker, interrupt/retry; inspect tombstone, current access and configured retained native/history/backup state.
FLD-01|Same ASCII/Unicode/multiline/empty and exact/over-limit cases through service/editor/REST/MCP; reject NUL/lone surrogate before any write.
FLD-02|Measure code points and canonical UTF 8 independently for ASCII/multibyte/astral input at character and row-byte boundaries.
FLD-03|Zero/negative/min/max/safe extrema create+patch accepted; fractions/overflow/string lexemes rejected with native values/revisions/history unchanged.
FLD-04|Finite floats including large/exponent/inclusive bounds round-trip; nonfinite and string coercion reject; compare documented approximation behavior.
FLD-05|True/false/null native values remain distinct on every surface; strings/numbers rejected with no revision/event.
FLD-06|Leap dates, invalid month/day and year bounds; accepted values unchanged by user timezone, inclusive min/max enforcement identical.
FLD-07|Allowed UTC time precision normalizes; missing Z/offset/24:00/leap second/excess precision rejects at every write adapter.
FLD-08|Valid UTC instants/inclusive bounds emit milliseconds; wrong offset, missing Z, invalid date and excess precision reject without stored coercion.
FLD-09|Render/view/edit date-time in user timezone; DST repeated time requires explicit choice and nonexistent wall time rejects, native UTC oracle agrees.
FLD-10|Switch timezone/locale/date formats and inspect time-only UTC labels and date-only unchanged values; save emits canonical UTC/date contract.
FLD-11|JSON all shapes/nested null/top-level clear; malformed/depth/byte/NUL/unsafe/nonfinite negatives; native/history and export preserve own prototype-like keys.
FLD-12|Equivalent object key order/numeric spellings preserve revision/history; array order and changed values advance once with exact old/new JSON.
FLD-13|For each of eight types, create/patch/import via all adapters exercises default/required/omitted/explicit-null with exact native and event oracle.
FLD-14|Invalid field bounds/defaults/API keys/duplicates and system writes fail before catalog, native schema or data/history changes.
FLD-15|Use the same accepted/rejected case IDs in validators/serializers/OpenAPI examples/MCP/UI; compare actual canonical outputs and rejected-write no-op oracle.
ROW-01|CRUD and synchronous atomic batch through UI/REST/MCP; compare native canonical values, revisions, complete mutation IDs and deletion events.
ROW-02|Attempt row ID/version/org/system assignment and wrong parent; deny before mutation, immutable ID unchanged.
ROW-03|Exactly 65536/+1 canonical bytes for create/patch/default/import including null fields; SQL enforcement and shared validator agree at commit.
ROW-04|Actual physical 4999999 to 5000000 succeeds; next rejects; committed deletion releases one slot and aborted deletion does not.
ROW-05|Race single/bulk/import insertions for actual released capacity; count never exceeds 5M, rollback/retry leaves exact counter/native count and no reservation leak.
ROW-06|Two clients save same revision; one 409 preserving native winning value and history, rendered losing draft retained with explicit review.
ROW-07|Equivalent/no-op writes preserve revision/history; successful change increments revision and cell/row events exactly once.
ROW-08|Replay create/update/delete/batch/schema/job after lost response; native rows/revisions/history/counters/jobs single, changed input conflicts.
ROW-09|Late invalid/stale/unique batch member rolls back all earlier writes, cell events, mutation receipts and row counters.
ROW-10|Real process restart/network response loss around commit; reconcile using mutation identity to exact committed or absent outcome, never duplicate write/history.
ROW-11|Request/batch/field/count/quota/disk admission boundary errors are typed/actionable and rejected work leaves authorized existing records readable.
UNI-01|Duplicate user columns accepted before rule; scalar and composite rules inspect complete tuples, not hash or single-part approximation.
UNI-02|Case/space distinctions, multiple nulls and positive/negative float zero follow exact contract on create/update/import.
UNI-03|Race insert/update/import conflicts under each rule; only valid tuple commits, native rows and registry buckets agree.
UNI-04|Update/delete/rollback releases or restores old tuple participation atomically; subsequent valid insertion is not falsely blocked.
UNI-05|Near-limit long/composite values use wide registry; force actual SQL digest collision and prove different tuples coexist while true duplicate rejects.
UNI-06|Build on existing duplicates returns exact conflict rows; no active rule/enforcement until actual validated installation succeeds.
UNI-07|Rule/index budgets and actual cancellation/failure/restart retain prior valid enforcement and expose pending/failed maintenance truthfully.
UNI-08|Repeated simultaneous cross-rule mutations exercise stable bucket locking; inspect timeout/deadlock counts and no orphan registry ownership.
UNI-09|JSON/custom-normalization uniqueness requests reject explicitly before installing metadata or approximate enforcement.
AUD-01|Native committed changed-cell event matches exact typed old/new, IDs/revisions/actor/request/mutation/source and UTC timestamp with same transaction.
AUD-02|Create/delete/clear/no-op produce exact documented row/cell event counts and semantics; null clear and row deletion distinguishable.
AUD-03|Service/import/conversion/restore/repair attribution compares actor/context/mutation with native committed changes and retained original provenance.
AUD-04|Validation/transaction rollback leaves zero events; actual ordinary runtime login cannot disable trigger or rewrite/delete retained history.
AUD-05|REST/MCP cell lookup after row delete/field rename/remove yields original type/ID/value interpretation under current grants.
AUD-06|Denied history and exports reveal no inaccessible values or credentials; permitted history has exact attribution and redacted security material.
AUD-07|Database/table/field/rule/index changes create distinct resource/schema events without misreporting unchanged cells as edits.
AUD-08|Inspect staged conversion events before/after publication and interruption; invisible staging then exactly one committed interpretation sequence.
AUD-09|Archive policy yields verified encrypted manifests/ranges before fenced purge; query gaps/restore/backup/delete retention never imply continuous history after removal.
AUD-10|Actual 10M+ event fixture: record lookup plan/partition/index sizes,1,000 timed 200-event pages, high-edit rows and bounded bytes.
QRY-01|Whole/selected queries through REST/MCP return same canonical values plus IDs/revisions, projection excludes only requested user fields.
QRY-02|Every operator/type pair including null/range/case/prefix/contains/JSON path/containment has positive and invalid-type native-backed query oracle.
QRY-03|Nested AND/OR, ties/sorts/projections and unknown fields/operators; accepted result rows exact and invalid AST denied before execution.
QRY-04|Boundary AST/JSON path/depth/predicate/sort inputs and SQL/identifier injection strings compile parametrically, reject unbounded expressions.
QRY-05|Actual REST 5,000/MCP 200 defaults and 1/1000/5000/25000 pages;0/negative/25001 reject through each adapter.
QRY-06|Actual 8MiB REST/1MiB MCP byte-boundary pages stop on whole rows with reason/cursor; traverse unchanged data without missing/duplicating boundary.
QRY-07|Tamper/expire cursor, change query/projection/parent/credential grants/schema; verify exact refusal and no stale authorized result.
QRY-08|Traverse unchanged tied sorts with exact complete ID set; compare documented live edit semantics; concurrent export snapshot remains coherent.
QRY-09|Empty/single/last/exact-boundary pages have truthful continuation/count; inspect plans to avoid unconditional whole-table count.
QRY-10|Capture actual indexed and selective/nonselective scan plans and 1000 timings; real 10s cancellation returns typed timeout and healthy foreground probe.
QRY-11|Navigate actual 5M first/middle/last with logical anchors, query plans and bounded windows; no proportional deep OFFSET/materialized entire table.
QRY-12|Compare cached/live/approximate/exact count and statistics metadata to native oracle; filtered/expensive exact count must complete authorized durable job.
API-01|Validate generated OpenAPI 3.1.2 for every route schema/auth/scope/error/header/example/status/job and the documented binary/protocol exceptions.
API-02|For all 104 operations, inspect actual named handler and authorized/denied execution record on browser/REST/MCP; inventory every interactive/bootstrap exception.
API-03|Compile generated client and use real endpoints; assert actual media/status/body/nullability against schemas, not mocked response shapes.
API-04|After native schema edits, runtime table discovery fields/constraints/operators match metadata/storage; global spec digest remains safe/stable.
API-05|Read-only credential succeeds at POST query and fails create/update/schema/member/key/backup writes with zero side effects.
API-06|Every nested path authenticates correct audience and current org/parent grants; browser bearer, REST cookie-only and org-to-operator escalation reject.
API-07|Malformed/duplicate/unknown/over-budget input rejected before expensive handler; response is typed/redacted without SQL/input/token echoes.
API-08|Real principal/org rate and simultaneous read/write/job admission overflow gives Retry-After/actionable code while allowed health/read survives.
API-09|Across CRUD/batch/schema/job, require concurrency/idempotency headers; exact replay/changed-input/output mutation IDs match durable native outcome.
API-10|Publish specs and actual health/status under each dependency failure; no credentials/private configuration/SQL/stack paths exposed.
API-11|Initial one-time secret then all replay/outcome/job/report access; metadata only after issuance and no secret redisplay, even concurrent retry.
API-12|Unknown versus denied resources have uniform 404/disclosure behavior for org/database/table/field/rule/index/job/backup/artifact and action classes.
MCP-01|Pinned real client initializes, negotiates supported Streamable HTTP version, lists and calls actual tools; record SDK/protocol/client versions.
MCP-02|Actual native client discovers issuer/protected resource at configured origin/resource for supported preregistration/metadata modes.
MCP-03|Exact PKCE/redirect/issuer/state/resource positive flow and mismatch/replay/concurrent code exchange negatives inspect real persisted tokens/grants.
MCP-04|Actual metadata policy exercises private DNS/rebinding/redirect/size/deadline/cert negative paths; consent renders source provenance and trust accurately.
MCP-05|Current user's org/scopes/targets bound to consent; broader grant denied, deny finality and owned/admin revoke invalidate family.
MCP-06|Token access/inactivity/absolute expiry boundaries plus refresh rotation and concurrent reuse; persisted family revocation and next-call 401.
MCP-07|REST/MCP audience cross-use denied; originating MCP binary upload/download requires original target/purpose/current authority; session ID alone fails.
MCP-08|Each of the 104 actual tool handlers has success/error output validation, annotations, allowed/denied authority and useful typed domain failure.
MCP-09|Measure encoded 1MiB structured outputs without duplicate row text; projection/cursor/export resource still rechecks current credential grants.
MCP-10|Real long operation returns queued ID, authorized get/list/cancel/retry and verified terminal result; failed upload/verification never success.
MCP-11|Delegated sensitive task returns exact bound browser approval; wrong user/client/payload/replay denies; only approved action completes.
MCP-12|List/discover/resource/tool results for hidden and peer targets never expose data/token/key; one-time issuance exception remains protected.
MCP-13|Real client handles 401 challenge/minimum scope/OAuth/protocol/domain errors; inspect usable redacted code/retry details rather than raw stack.
UI-01|Review rendered database/table sidebars and spreadsheet hierarchy against the layout brief in desktop light/dark.
UI-02|During five-million-row scrolling inspect bounded DOM rows/columns, overscan, cache and requested windows; confirm eviction prevents cumulative retention.
UI-03|Match actual first/middle/last five-million-row ranges to native IDs and logical positions despite browser height limits.
UI-04|For every type use tap and keyboard edit, commit, cancel, validation and focus return; native value agrees and rejected draft remains.
UI-05|Review keyboard-only and actual screen-reader navigation, focus announcements, touch, high zoom and reduced motion; axe alone is insufficient.
UI-06|Delay or deny real saves and provoke revision conflict; pending/saved/error states match commit and retain the losing draft.
UI-07|Persist date/time/locale preferences and edit real cells; native UTC/date values, time-only labels and DST decisions agree.
UI-08|Change search/filter/sort/projection with competing delayed fetches and an active draft; old windows cancel/evict and the draft remains protected.
UI-09|Copy/paste valid and invalid rectangles; small failure rolls back all cells, large preview/upload/job/rejections match native rows/history.
UI-10|Resize/reorder/freeze/hide and reload each user's view; preferences persist without altering API keys, data, revisions or history.
UI-11|Open intended row/field history including removed fields; exact before/after/actor/time and current denied-resource privacy agree.
UI-12|Render actual duplicate/schema conflicts, index/rule/conversion jobs and maintenance states; stale drafts require explicit current-schema review.
UI-13|Run actual backup/import/export jobs; committed progress, partial rejection, verification, cancellation, retry and failure match native/artifact oracles.
UI-14|Every profile/team/key/factor/passkey/connection/preference control exercises real allowed/denied and recent-auth/approval behavior with persisted reload.
UI-15|Real empty/loading/offline/revoked-access transitions recover without frozen controls or discarded drafts; retry reports truthful commit state.
UI-16|Native Safari and Chromium real routes at desktop and 390x 844 touch, light/dark, with screenshots/traces; manually inspect clipping/focus and browser versions.
UI-17|Near-limit JSON and 200-field viewport measure bounded previews and lazy editors; offscreen cells avoid eager parsing/formatting.
IO-01|CSV/JSONL dry run and mapping preserve leading-zero text and all type/default/null semantics; exact rejected record numbers precede mutation.
IO-02|Import byte/capacity/unique/revision failures produce bounded exact rejected-record reports; committed progress matches native rows/history.
IO-03|Upsert by active declared unique rule or explicit ID yields one match; missing/inactive/ambiguous keys reject without approximate updates.
IO-04|SIGKILL after actual batch commit then restart from durable checkpoint; complete row IDs, revisions and history prove no duplicate or lost batch.
IO-05|Cancel after committed batch reports partial counts; separate invalid small atomic batch rolls back all data/history/counters.
IO-06|Concurrent edits/schema work during actual snapshot export preserve coherent schema/query/data and canonical values with exact checksums.
IO-07|CSV quotes/newlines/delimiters and spreadsheet-safe opt-in round-trip; output protection leaves stored values unchanged.
IO-08|Authenticated artifact bytes/count/checksum/expiry match manifest; foreign purpose/target and revoked credentials deny retrieval.
IO-09|Oversized/expired/tampered/truncated transfers and lost-response retries return exact recovery outcomes without secrets or duplicate imports.
BKP-01|Set/read policy through UI/API/MCP validates cron/timezone/destination/retention/encryption/runtime; credentials absent from returned policy.
BKP-02|Compare preview with actual UTC scheduler occurrences across DST and restart; occurrence ledger proves duplicate/overlap suppression.
BKP-03|Run concurrent row edits and DDL behind extraction barrier; all schemas/rows/rules/history share one snapshot, DDL resumes safely.
BKP-04|Inspect actual manifest versions/mappings/time/counts/checksums/archive references and recursively exclude authentication secrets.
BKP-05|Upload remains unverified until actual isolated restore compares schema/data/history and cleans temporary state; deliberate mismatch fails.
BKP-06|Actual object permission, incomplete upload, checksum and verification failures have distinct states/codes without verified timestamps.
BKP-07|Exercise policy expiry/count, last verified recovery point, deleted-org default indefinite/configured retention and unrelated-object preservation.
BKP-08|New restore remaps structural IDs only; business JSON, row IDs, values/history remain exact; rules/indexes rebuild before visibility.
BKP-09|Replacement requires bound approval and recovery point; leased freeze/staging/cutover failures preserve or recover the prior database.
BKP-10|Genuine process termination at snapshot/upload/verification/cutover boundaries reconciles one run/artifact/publication without source damage.
BKP-11|Fresh installation restore uses nonempty encrypted artifacts and retained keys; full schema/value/history comparisons establish readable data.
BKP-12|Missing old keys, rotated active keys and incompatible formats yield explicit recovery errors; retained old key reads real encrypted content.
BKP-13|Cleanup denial/process loss is observable; bounded owned-namespace/object retries preserve all source/peer/key resources.
BKP-14|Enabled/disabled/current-recipient notifications, actual SMTP sent state, job polling and runbook report verification age and failures truthfully.
JOB-01|Two actual workers claim one job; heartbeats, lease fencing and SIGKILL recovery permit one authoritative publisher.
JOB-02|Retry each DDL/upload/import/delete job using durable identity; reconcile external state before replay and compare all side effects.
JOB-03|Progress equals committed checkpoints; cancellation at plan/commit/publication boundaries reports committed work and partial outcomes.
JOB-04|Get/list/cancel/retry/artifact requests recheck current requester/target/grants; foreign jobs hide and lost original authority denies.
JOB-05|Restart worker, duplicate scheduler, queue backlog and real external outages preserve jobs while foreground pool/read health stays bounded.
JOB-06|Enumerate every job kind and verify terminal or recoverable state, bounded attempts and redacted failure; no indefinite uninspectable acceptance.
PERF-01|Retain actual 5M/24-field/958-byte and 200-field/65536-byte counts/distributions/full checksums plus 10M history, host/cgroup/buffer/disk profile.
PERF-02|Enforce PG 4/API 1/worker 2/web 1 GiB; measure 1000 requests each for indexed cold/warm,5000 and byte-capped 25000 pages with plans/percentiles/errors.
PERF-03|Measure 1000 text/JSON/range interactive cases with selective/nonselective distributions, actual 10-second timeouts and foreground probes; deep navigation bounded.
PERF-04|Ten actual simultaneous HTTP editing clients commit 100 edits each; p 95<=500ms and exact revisions/history/distinct mutations prove no loss.
PERF-05|Final capped Native Safari/Chromium cold/warm viewport and five-minute scrolling meet FPS/frame/freeze/cache/memory targets on actual routes.
PERF-06|Actual import/index/rule/conversion/backup and isolated verification overlap 5M foreground reads; record durations, pools, worker memory, temp/disk/WAL.
PERF-07|Actual 5M capacity race and near-byte JSON, wide schema, many nulls/high-history cases under caps reject overflow without UI/API hang.
PERF-08|Repeated table/query switching and long-running capped services with actual API/worker/PG restart/network loss show bounded resources and observable failures.
OPS-01|Fresh documented non-root Compose starts all four services with durable PostgreSQL/spool and external dependencies; status/data survive restart.
OPS-02|Migration checksum/missing version, stale worker, PostgreSQL, SMTP/S3 and admission failures match actual live/ready/degraded behavior and data availability.
OPS-03|Populate prior control/native/history schema then forward-upgrade and reconcile dynamic journals; exact data, roles, partitions/deleted metadata preserved.
OPS-04|Fail upgrade at durable boundary then follow documented no-rollback limitation and restore recovery; prior backup restores operable data/configuration.
OPS-05|Inspect correlated request IDs/operations/status/duration and query/row/history/storage/index/job/backup health; secret sentinels absent from logs.
OPS-06|Actual disk/quota/pool/SMTP/S3/stale-lease/failed-schema probes yield actionable status; unavailable metrics remain unknown and foreground reads survive.
OPS-07|Whole physical control/native restore plus separately retained hash/encryption keys and nonempty S3 objects restores authentication/data operations.
OPS-08|A named reviewer follows written backup/restore/Owner/factor/key-rotation/migration/failed-job steps; retain commands/outcomes/time without credentials.
OPS-09|Every final artifact matches immutable source/image/contract/migration/lock/tool/dependency digests and environment; changing tree cannot qualify.
REL-01|Review every complete requirement against positive candidate evidence; retain unresolved failures and leave every incomplete gate unsigned.
REL-02|One candidate completes setup/invitation/factors/schema/every editor/scoped REST/MCP/history/backup/new and replacement restore/restart rehearsal with native oracles.
REL-03|Independent reviewer checks 104 operations and all protocol/bootstrap/interactive exceptions with allowed/denied/approval/replay/terminal execution evidence.
REL-04|Actual implementation and verification reviewers approve exact source/image/contract/profile digests with identity/UTC; approvals cannot be inferred.
REL-05|Final report separates implementation/verification from private PR, image publication, DNS/production deployment/health and reports only observed outcomes.
`;

export const gateReviewOracles = new Map(
  source
    .trim()
    .split("\n")
    .map((line) => {
      const split = line.indexOf("|");
      if (split < 0) throw new Error("Invalid gate review oracle.");
      return [line.slice(0, split), line.slice(split + 1)] as const;
    }),
);
