# Historical development evidence

Earlier development records describe the 2–4 October 2026 candidate, including a
multi-organisation model, Owner/resource-grant checks and the former migration
sequence. The revised V1 replaces those requirements with one organisation,
Admin/Editor/Viewer, live-role personal keys, one field name and one fresh SQL
baseline. Earlier reports are retained under `verification/` and are historical.
They do not establish current acceptance.

## Recorded earlier observations

The prior development record reported local storage/access/collision and SQL
ownership/observability checks, HTTP/MCP/OAuth cases, typed data/history comparisons
and separate delivery/recovery work. Those narrow results established only their
observed cases and environments. Obsolete lifecycle/grant/upgrade cases are no
longer acceptance requirements; retained behavior needs current relevant checks.

The scale fixture had five million physical rows, 24 fields across all eight types,
ten million retained cell changes, and a separate 200-field table with rows at
65,536 canonical bytes. Its 1,000-row sample averaged 958.175 canonical bytes.
Normal benchmark edits changed baseline checksums and were recorded separately.
These fixtures cannot be assumed compatible with the regenerated baseline.

| Earlier warm service measurement    | Requests | Recorded p95 |
| ----------------------------------- | -------: | -----------: |
| Indexed 200-row query               |    1,000 |     16.60 ms |
| 200-event cell history              |    1,000 |      6.61 ms |
| 5,000-row query/serialization       |    1,000 |    230.07 ms |
| Requested 25,000 rows, byte-capped  |    1,000 |    474.36 ms |
| Committed edits through ten clients |    1,000 |     60.77 ms |

Those measurements used shared uncapped development services and warm caches.
They are not current REST/browser measurements under the approved 8 GiB core
caps. Later retained-copy/source-review records also have their own narrower
boundaries; review their exact reports before describing them. Neither a source
review nor API-only readiness establishes whole-system recovery or acceptance.

## Failures and limits remain evidence

The prior record preserved temporary-disk pressure, an interrupted checksum sort,
explicit cancellation, capacity/VM constraints and incomplete native/browser
work. It reported source-preserving bounded checksum finalisation rather than
pruning other products or changing limits. Keep failed attempts and their stated
limitations; do not relabel old results as current successful checks.

Current passing local checks and remaining work are recorded in
[current results](CURRENT_RESULTS.md); complete grouped sign-off remains open in
the [revised checklist](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md). The
core allocation is PostgreSQL/API/worker/web 4/1/2/1 GiB with no extra swap;
object/mail fixtures and browser memory are separate observations. Complete only
items supported by genuine results for the revised candidate.
