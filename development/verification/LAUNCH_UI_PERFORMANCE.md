# Launch UI performance review

Reviewed on 10 October 2026 against Rootset candidate `2582bf4` plus the
loading changes in this PR. This is a focused frontend comparison, not a
whole-system or large-dataset launch sign-off.

## Findings addressed

- Rootset eagerly imported its spreadsheet, settings, authentication flows and
  consent reauthentication dialog into the initial application bundle. These
  now use Next's supported dynamic imports, following Mill's deferred sections
  and Towbar/Vitalog's route-level splitting. Loading does not add visible text
  or replace the persistent application shell.
- Account and team settings subscribed to database and table queries even when
  they did not use them. Those queries are now enabled only on resource pages.
- Rootset omitted the shared theme bootstrap script. It now applies the saved
  theme before hydration, matching the other applications.
- The private app now supplies the same no-index/no-follow metadata pattern as
  Towbar and Vitalog. This does not change public documentation indexing.

The initial scripts in Rootset's login HTML fell from 2,105,908 to 1,677,544
uncompressed bytes, or from 610,858 to 485,127 bytes when individually compressed
with gzip level 9: a 20.6% reduction. Deferred chunks still load when their
features are opened. This is a download-size improvement, not a measured 20.6%
reduction in time to usability.

## Local reference measurements

Twenty sequential warm HTTP requests followed one discarded warm-up per route.
Times include only the HTML response; they exclude JavaScript download,
hydration, authenticated data and browser rendering. Script size includes each
distinct `script src` in the HTML, with gzip level 9 applied separately. Lazy
chunks and module preloads are excluded, and deployment compression may differ.

| App / reference route | Initial scripts, estimated gzip | Median HTML response | p95 HTML response |
| --------------------- | ------------------------------: | -------------------: | ----------------: |
| Rootset `/login`      |                          485 KB |              3.24 ms |           4.55 ms |
| Towbar `/demo`        |                          720 KB |              3.05 ms |           6.56 ms |
| Mill static entry     |                          247 KB |              0.51 ms |           0.59 ms |
| Vitalog `/login`      |                          274 KB |              3.20 ms |           3.62 ms |

These are reference costs, not a ranking of product responsiveness:

- Rootset used the current production standalone build on the host at port 4300.
- Towbar used the existing production demo welcome page through Docker and Caddy
  at port 4880. This is not its authenticated control plane.
- Mill used a fresh production build of the local working tree at `aab8ef3`,
  including its existing uncommitted work, served temporarily
  by Python at port 4393. It is static HTML rather than server-rendered HTML.
- Vitalog used its existing 7 October production build at temporary port 4391.
  This is an older reference snapshot, not current-release acceptance.

Both temporary servers were stopped after measurement. Other product source and
deployments were not changed. Machine-readable results and per-script sizes are
preserved locally in `verification/ui-review-01c99fa/launch-speed-review.json`.

## Rootset data and interaction checks

Ten sequential read requests after one warm-up used the current API container,
the current baseline and the existing synthetic 30-row Sample records table.

| Read                                      | Median response | p95 response | Response size |
| ----------------------------------------- | --------------: | -----------: | ------------: |
| Table schema                              |        23.49 ms |     25.32 ms |   4,304 bytes |
| Grid window, limit 200, returning 30 rows |        27.69 ms |     43.19 ms |  10,768 bytes |

No rows, fields, filters or settings were changed. The former Scroll records
fixture was unavailable in the current preview, so these figures make no
large-table claim. Warm loopback service timings are not internet latency.

Browser review verified spreadsheet/settings loading, a field edit modal opened
and cancelled, profile loading, logo navigation home and persistent sidebar state
across page changes. The grid exposed 31 total ARIA rows including its header,
while rendering 25 rows and 168 cells in the current viewport, confirming that
off-screen rows and columns were omitted. Dark theme remained applied.

Source review confirms:

- One persistent Next layout and one persistent React Query client.
- Shared shell, account menu, navbar, theme control, ResourceTable, Chip, modal,
  confirmation, toast and backend-unavailable primitives.
- Main/account queries deduplicate reads and retain fresh results for 30 seconds.
- Grid requests use 200-row windows, cancellation and signed cursors, with a
  1,000-row/32 MiB active-window bound and virtualized rendering.
- Column widths save through a debounced, serialized queue. Off-screen image
  cells are lazy and have explicit dimensions.
- Product CSS has no `transition: all`; reduced-motion and theme-swap transition
  suppression are present.

## Limits and remaining opportunities

Rootset's initial script cost remains larger than the Mill and Vitalog reference
entries. The resource settings loader still rereads schema on remount, and
returning to a table fetches its first row window again; the row cache is scoped
to the mounted spreadsheet. Account settings already use the shared query cache.
Cross-route caching could make repeated table visits faster, but it must preserve
schema revisions, live permissions, deletion and session boundaries.

This pass did not measure cold-browser time to usability, mobile CPU/throttled
network performance or a current five-million-row workload. Historical scale
measurements do not establish acceptance for the simplified baseline.

Formatting, focused lint, web TypeScript checks, all 223 web tests and the
production web build passed. These checks establish the focused UI change;
publication, deployment and full release gates remain separate.
