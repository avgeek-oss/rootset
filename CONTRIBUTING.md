# Contributing to Rootset

Use Node.js 24 and pnpm 11.5.3. Install with `pnpm install --frozen-lockfile` and
read [rc-plan](rc-plan/README.md) before changing a domain contract.

Every operation belongs in the shared catalog and must retain browser, REST and
MCP parity. Keep organisation authority separate from installation authority.
The API runs with a non-owner role; dynamic SQL names come from internal IDs.
Schema/value/history changes must preserve their transactional guarantees.

Run `pnpm contracts:generate` after catalog changes and review the generated
OpenAPI/client/MCP inventory. Run `pnpm verify` and the affected real-service
integration suites. A passing unit test is not a substitute for row-lock,
schema-recovery, rendered-browser or restore evidence when those behaviors change.

Write migration additions; do not edit a migration that has been applied to a
reviewed installation. Record the upgrade and recovery procedure with the change.
Keep `.env`, test credentials and machine evidence out of Git. Use synthetic data.

The [verification checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md)
contains the acceptance gates. Evidence identifies the exact source/build and
environment; do not mark gates complete from scaffolding or an unexecuted plan.
Source/image publication, production deployment and DNS changes require separate
authorization. Public-distribution licensing remains a release decision.
