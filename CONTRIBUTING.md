# Development notes

These are the maintainers' development notes. Rootset does not accept
contributions from public sources; feedback and issues are welcome in
[GitHub issues](https://github.com/avgeek-oss/rootset/issues).

Use Node.js 26 and pnpm 11.5.3. Install dependencies with
`pnpm install --frozen-lockfile`; they are available from the public npm registry.
Follow the [development installation guide](development/operations/installation.md)
to start a local instance.

Report a bug or suggest a change in an issue. Include the Rootset version,
reproduction steps and expected behavior for bugs. Maintainer pull requests explain
what changed, why and how it was verified, and keep unrelated changes separate.

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
fixture evidence outside Git. See [verification guidance](development/verification/README.md)
for integration, recovery and performance checks.

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

## License

Rootset is licensed under the [Apache License 2.0](LICENSE). Preserve existing copyright and third-party attribution notices, and include the
license and source attribution for any adapted code or assets.
