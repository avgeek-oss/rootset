# Contributing to Rootset

Use Node.js 24 and pnpm 11.5.3. Install with `pnpm install --frozen-lockfile` and
read the [current V1 scope](rc-plan/README.md) before changing a domain contract.

Keep browser, REST and MCP operations on the same validated domain service.
Resolve the installation's single organisation and the person's current
Admin/Editor/Viewer role on each request. Admin includes installation management.
Personal keys inherit that role; OAuth additionally checks operation consent.
Use generated internal IDs for SQL identifiers and bound parameters for values.

Field definitions have one `name` property: 1–64 ASCII letters or underscores,
matching `/^[A-Za-z_]+$/`. The UI label and JSON row key are the same name. Renames
preserve the internal field ID and its history.

## Checks

Run `pnpm contracts:generate` after catalog changes, then review generated drift.
Use narrow checks while iterating and `pnpm verify` before review. Run affected
native integration and browser checks in disposable fixtures. Permission,
concurrency, crash recovery, backup restore and full-scale behavior need real
observations when they change; a unit test alone cannot establish them.

Record what ran, its result and any remaining limitation. Keep secrets and private
fixture evidence outside Git. The [short V1 checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md)
starts unchecked for the revised scope; do not carry old pass marks forward.

## Schema changes before V1

Maintain exactly one fresh-install migration,
`packages/database/migrations/0001_baseline.sql`. Edit/regenerate that baseline
as the pre-release schema changes and verify a new empty installation. The normal
migration runner must verify its digest and refuse incompatible prelaunch ledgers
without altering their data. Preserve old installations and recovery copies.

There is no supported upgrade from the retired migration sequence. An upgrade
or data conversion procedure needs its own implementation and evidence before it
can be documented as supported.

Review real desktop/mobile routes in light and dark themes after UI changes.
Include keyboard use, drafts, conflicts, loading and failure states. Report
security defects through [SECURITY.md](SECURITY.md). Publication, deployment and
DNS changes require separate authorization.
