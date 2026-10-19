# Verification

Run checks against the exact version or commit under review. Record the command
or manual method, environment, date, observed result and remaining limitations.
Historical reports describe their own versions and do not certify later releases.

## Workspace checks

```sh
pnpm contracts:generate
pnpm verify
pnpm test:integration
```

Review generated drift and run affected integration cases with isolated
PostgreSQL, object storage and mail fixtures. Use real browser and native evidence
for user flows. Missing dependencies and skipped scenarios remain unresolved.
A passing unit suite does not establish installed readiness, encrypted recovery,
OAuth client interoperability or full-scale performance.

## Whole-system checks

- Verify fresh installation, supported upgrades, concurrent migration startup and
  refusal of incompatible prelaunch ledgers.
- Exercise Admin, Member and Viewer through the browser, REST and MCP, including
  credential revocation and OAuth operation consent.
- Compare typed records, revisions, uniqueness and cell history with native data.
  Rehearse interrupted schema changes and worker recovery.
- Restore database and object data to a separate target using retained keys.
  Compare results without altering the source installation.
- Review phone and desktop routes, light and dark themes, keyboard and touch
  interactions, screen readers, loading states and failures.
- Measure scale, contention, scrolling and memory against the
  [performance profile](performance.md). Report targets and observed results separately.

## Evidence tools

The machine-readable [verification requirements](../../tools/verification/requirements.json)
retain stable `V1-01` through `V1-40` IDs used by the integration suites. These IDs
are evidence references, not a version or acceptance claim. Update requirements
and their independent review clauses when supported behavior changes.

`tools/verification/gate-audit.ts` produces test-source pointers for these
requirements. `pnpm verify:signoff <report.json> <candidate-version>` validates
reported results and artifact hashes. Neither tool turns source pointers or
complete metadata into product acceptance. Keep credentials and private fixture
data outside Git; share redacted logs, native comparisons and captures.

## Historical results

[Development history](DEVELOPMENT_EVIDENCE.md) and the
[earlier gap audit](V1_GAP_AUDIT.md) are historical development records. For
current review, use the operation catalog, CI results and observations from the
version under test. [Operation coverage](OPERATION_COVERAGE_REVIEW.md) describes
cross-surface checks; [metrics and SQL roles](OPERATOR_METRICS_AND_ROLES.md)
describes operational trust boundaries.

Keep local verification, image publication, deployment and production health
separate in reports.
