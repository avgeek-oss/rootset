# Contributing to Rootset

Use Node.js 24 and pnpm 11.5.3. Configure [GitHub Packages authentication](development/operations/installation.md#package-registry), then install with `pnpm install --frozen-lockfile` and
read the [current V1 scope](rc-plan/README.md) before changing a domain contract.

Keep browser, REST and MCP operations on the same validated domain service.
Resolve the installation's single organisation and the person's current
Admin/Member/Viewer role on each request. Admin includes installation management.
Personal keys inherit that role; OAuth additionally checks operation consent.
Use generated internal IDs for SQL identifiers and bound parameters for values.

Field definitions have one `name` property: 1–64 ASCII letters or underscores,
matching `/^[A-Za-z_]+$/`. The UI label and JSON row key are the same name. Renames
preserve the internal field ID and its history.

## Shared UI

Import the published `@avgeek-oss/design-system` package root or documented public
subpaths. Import `styles.css` once through Tailwind 4 and keep application source
scanning enabled. Do not copy shared components or import package `src`/`dist`
paths. Reusable component extensions belong in the design-system repository.
Rootset owns data fetching, callbacks, routes, role policy and credential
ceremonies. Use semantic tokens and native HeroUI sizing/interaction behavior.

## Checks

Run `pnpm contracts:generate` after catalog changes, then review generated drift.
Use narrow checks while iterating and `pnpm verify` before review. Run affected
native integration and browser checks in disposable fixtures. Permission,
concurrency, crash recovery, backup restore and full-scale behavior need real
observations when they change; a unit test alone cannot establish them.

Record what ran, its result and any remaining limitation. Keep secrets and private
fixture evidence outside Git. The [short V1 checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md)
starts unchecked for the revised scope; do not carry old pass marks forward.

## Schema migrations

Keep released migrations unchanged and add the next numbered SQL migration in
`packages/database/migrations`. Verify both an empty installation and upgrades
from the supported released ledgers, preserving existing data and enforcement.
The runner verifies migration digests and refuses unknown prelaunch ledgers.
Preserve those installations rather than clearing their ledger or volumes.

Review real desktop/mobile routes in light and dark themes after UI changes.
Include keyboard use, drafts, conflicts, loading and failure states. Report
security defects through [SECURITY.md](SECURITY.md). Publication, deployment and
DNS changes require separate authorization.
