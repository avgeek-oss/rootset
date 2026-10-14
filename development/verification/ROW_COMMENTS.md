# Row comments

Row discussions use one shared `rootset_control.row_comments` table and the
same four catalog operations in the browser, REST and MCP. The spreadsheet
loads counts for the visible window, then fetches comment bodies only when a
discussion opens. It renders at most one 50-comment page at a time.

Comments have no edit operation, version, update timestamp or deletion marker.
The authenticated user or team key supplies attribution. Create receipts contain
only the comment ID; delete receipts contain only status. A replay cannot restore
a hard-deleted body. Comments do not alter row revisions or schema versions and
are excluded from ordinary field definitions, row values and exports.

## Automated coverage

`apps/rootset-api/src/row-comments.test.ts` creates an isolated PostgreSQL
database and runs the real runtime. It covers:

- Current Admin/Member/Viewer access; own-comment deletion and admin moderation;
  forged attribution; wrong organisation, database, table and row; missing and
  maintenance targets; invalid bodies and request bounds.
- Chronological cursor pages, deletion of a cursor anchor, actor/query binding,
  and response byte budgets for heavily escaped text.
- Concurrent idempotent creation, conflicting retries, hard deletion, replay
  after deletion, and absence of comment bodies from receipts, audit outcomes
  and durable job metadata.
- Browser sessions, personal REST keys, MCP calls and team-key attribution.
  `runtime.test.ts` also exercises all four operations through an issued OAuth
  MCP token and checks the same author through REST.
- Forced RLS, composite parent integrity, lack of an update policy, and retained
  author name after the user foreign key becomes null.
- Both lock orderings of concurrent row deletion and comment creation, live
  role demotion while waiting for a row lock, and row/table/database cleanup.
  The races observe PostgreSQL lock waits before releasing their barriers.

Run the fixture with the repository test environment loaded:

```sh
pnpm exec tsx --test apps/rootset-api/src/row-comments.test.ts
```

`apps/rootset-web/tests/verify-row-comments.mjs` creates 260 synthetic aircraft
rows in a loopback-only installation. It checks bounded lazy counts, clipboard
and inline editing, keyboard opening and focus return, literal plain text,
creation/deletion, failed-request draft retention, pagination, Viewer controls,
and desktop/mobile light and dark layouts. It saves screenshots and private
fixture/session metadata under the ignored `verification/row-comments/` directory.
The Viewer check requires the dedicated disposable PostgreSQL endpoint on
`127.0.0.1:55468/rootset`; do not point it at an existing installation.

```sh
node --env-file=.env.test apps/rootset-web/tests/verify-row-comments.mjs
```

## Local observations on 2026-10-14

- Frozen dependency installation, contract generation, documentation checks,
  formatting, lint, strict types, all unit/runtime tests and production builds
  passed through `pnpm verify`. The final UI focus change was followed by lint,
  web type checking, a production web build and the complete browser fixture.
- Native verification passed: `pnpm test:integration` (38 tests), the jobs
  integration runner (10 tests), and the row-comment fixture (8 tests including
  its parent suite). No tests were skipped in these runs.
- `pnpm audit --prod --audit-level high` passed. It reported one moderate
  dependency advisory and no high or critical advisories.
- A PostgreSQL 18 custom-format `pg_dump` was restored with `pg_restore` into a
  separate disposable database. All 273 comments across five tables matched a
  canonical content digest, every comment still linked to a physical row, all
  three foreign keys existed, and RLS remained enabled and forced. Only the
  temporary restore database was removed afterward. The redacted result is
  retained locally in `verification/row-comments/recovery.json`.
- The sample production web/API/worker environment returned healthy PostgreSQL,
  object storage, mail and worker readiness. Browser review used 1440×1000
  desktop and 390×844 mobile viewports.
- The first candidate CI run passed the comment fixtures but exposed the
  existing admission contention test's 150 ms pool-exhaustion deadline leaking
  into queued cleanup. The test now restores its original connection deadline
  after the intentional exhaustion phase; rejection assertions and the native
  statement/lock deadline are unchanged.

These observations cover this feature and its regression checks, not the full V1
acceptance checklist or a production-scale comment benchmark. Candidate image
builds and fresh Compose installation/restart are checked by the PR's existing
`Verify candidate` workflow; consult the run for its current result.

## Recovery boundary

This changes the prelaunch fresh-install baseline, following `CONTRIBUTING.md`.
Existing installations with another applied baseline digest must remain intact
and will refuse this schema. This PR does not provide an in-place upgrade.

Comments belong in a consistent full PostgreSQL backup containing both control
and physical row schemas. Ordinary row exports do not include them. Application
hard deletion does not rewrite historical provider backups; those retain their
own point-in-time contents and retention policy. See the installation recovery
procedure for restoring a separate target.
