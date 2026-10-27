# Row comments

Row discussions use one shared `rootset_control.row_comments` table and the
same four catalog operations in the browser, REST and MCP. The spreadsheet
receives `hasComments` with each row page and fetches comment bodies only when
the discussion drawer opens. It renders at most one 50-comment page at a time.
The comment icon shares the row-number cell; browsing sends no comment-count
requests. Explicit count operations remain available to REST and MCP callers.

Comments have no edit operation, version or update timestamp. Deletion clears
the body and sets `deleted_at`, preserving author attribution and chronology.
The drawer displays a muted, italic `comment deleted` entry. A database trigger
prevents edits, restoration and changes to attribution or chronology; the user
foreign key can still clear when an account is removed.
The authenticated user or team key supplies attribution. Create receipts contain
only the comment ID; delete receipts contain only status. A replay cannot restore
a deleted body. Comments do not alter row revisions or schema versions and
are excluded from ordinary field definitions, row values and exports.

## Automated coverage

`apps/rootset-api/src/row-comments.test.ts` creates an isolated PostgreSQL
database and runs the real runtime. It covers:

- Current Admin/Member/Viewer access; own-comment deletion and admin moderation;
  forged attribution; wrong organisation, database, table and row; missing and
  maintenance targets; invalid bodies and request bounds.
- Chronological cursor pages, deletion of a cursor anchor, actor/query binding,
  and response byte budgets for heavily escaped text.
- Concurrent idempotent creation, conflicting retries, retained deletion logs, replay
  after deletion, and absence of comment bodies from receipts, audit outcomes
  and durable job metadata.
- Browser sessions, personal REST keys, MCP calls and team-key attribution.
  `runtime.test.ts` also exercises all four operations through an issued OAuth
  MCP token and checks the same author through REST.
- Forced RLS, composite parent integrity, guarded redaction updates, immutable
  deletion timestamps, and retained author name after the user foreign key
  becomes null.
- Both lock orderings of concurrent row deletion and comment creation, live
  role demotion while waiting for a row lock, and row/table/database cleanup.
  The races observe PostgreSQL lock waits before releasing their barriers.

Run the fixture with the repository test environment loaded:

```sh
pnpm exec tsx --test apps/rootset-api/src/row-comments.test.ts
```

`apps/rootset-web/tests/verify-row-comments.mjs` creates 260 synthetic aircraft
rows in a loopback-only installation. It checks row-page comment presence without
count requests, clipboard
and inline editing, keyboard opening and focus return, literal plain text,
creation/deletion logs, failed-request draft retention, pagination, Viewer controls,
and desktop/mobile light and dark layouts. It saves screenshots and private
fixture/session metadata under the ignored `verification/row-comments/` directory.
The Viewer check requires the dedicated disposable PostgreSQL endpoint on
`127.0.0.1:55468/rootset`; do not point it at an existing installation.

```sh
node --env-file=.env.test apps/rootset-web/tests/verify-row-comments.mjs
```

## Local observations on 2026-10-14

- The updated browser checks cover the comment drawer, secondary composer,
  extra-small avatar initials, non-future relative times and retained deletion
  logs. Desktop and mobile routes were reviewed in light and dark themes.
- Sheet review covers stable sorting layout, centered sort indicators, 100 blank
  placeholder rows, the merged no-results message, filter count badges and a
  two-second hover preview that does not flash when opening the filter editor.
- Row-count review covers the right-aligned sidebar total and filtered header
  count, estimates becoming exact on reaching the final page, zero matches,
  clearing filters and settings navigation. There are no separate count
  requests. Estimates use PostgreSQL planning without executing a count scan.
- The authenticated principal limit is 600 requests per minute. Admission tests
  verify that request 601 is rejected and the next minute resets the budget.
  Browser checks cover the compact account-context error with its Retry action.

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
acceptance checklist. Candidate image
builds and fresh Compose installation/restart are checked by the PR's existing
`CI` workflow; consult the run for its current result.

## Recovery boundary

The initial comment table changes the prelaunch fresh-install baseline.
Installations with another applied baseline digest remain intact and refuse
that incompatible schema. The additive `0003_comment_deletion_log.sql` migration
upgrades installations already using this PR's comment baseline and preserves
their existing comments. Native migration tests cover both an existing comment
and repeat application. There is no conversion from an incompatible baseline.

Comments belong in a consistent full PostgreSQL backup containing both control
and physical row schemas. Ordinary row exports do not include them. Application
content deletion does not rewrite historical provider backups; those retain their
own point-in-time contents and retention policy. See the installation recovery
procedure for restoring a separate target.
