# V1 verification

The [current checklist](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md)
contains 40 pending checks for the revised V1 of 5 October 2026. It replaces the
former 205-item multi-organisation checklist. The old candidate's reports remain
historical; current acceptance is false.

[Current local results](CURRENT_RESULTS.md) records the simplified implementation's
passing native, workspace and browser checks and the remaining sign-off work.

## Ordinary checks

```sh
pnpm contracts:generate
pnpm verify
pnpm test:integration
```

Review generated drift, run the affected integration cases with isolated
PostgreSQL/object/mail fixtures, and use real browser/native evidence for actual
user flows. Missing dependencies and skipped scenarios remain unresolved. A
passing unit suite does not establish installed readiness, encrypted recovery,
OAuth client interoperability or five-million-row performance.

Record the candidate/version, command or manual method, environment, date,
observed result and limitation for each completed checklist item. Keep ordinary
logs, screenshots, native SQL comparisons, job terminal reports and benchmark
percentiles. Protect any fixture credentials/data; share redacted reports. No
large provenance or extra approval packet is required to run these checks.

## Remaining whole-system work

- Fresh baseline/singleton enforcement and refusal of incompatible old ledgers.
- Three-role browser/REST/MCP behavior, live personal-key revocation, real OAuth
  operation consent, authentication/factors and Admin recovery.
- One field name, stable-ID rename, native typed storage, atomic revisions,
  uniqueness, retained cell history and crash-reconciled schema/jobs.
- Genuine dependency/process-failure rehearsals and separate-target recovery of
  identity/control/data, SQL privileges, a nonempty object set and retained keys.
- Actual phone/desktop, Safari/Chromium, keyboard/touch/screen-reader and typed
  editing/history/settings flows.
- Full five-million-row, near-byte-limit and ten-million-history fixtures with
  capped cold/warm transport, contention, viewport/cache/memory and latency checks.

The approved core caps remain PostgreSQL/API/worker/web 4/1/2/1 GiB, total 8 GiB,
with no extra swap. Object/mail test fixtures and browser memory are reported
separately. The [checklist performance profile](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md#performance-profile)
retains all original workload, network, percentile and frame/cache thresholds.

## Evidence and maintenance

[Development history](DEVELOPMENT_EVIDENCE.md) records the earlier scope and limits.
[Operation coverage](OPERATION_COVERAGE_REVIEW.md) explains what a genuine
cross-surface result must show. [Metrics and SQL roles](OPERATOR_METRICS_AND_ROLES.md)
records operational trust boundaries. [Current gaps](V1_GAP_AUDIT.md) is the short
pending-work summary.

Retain earlier files under `verification/` unchanged. Tools and JSON gate indexes
must be aligned with `V1-01`–`V1-40`; obsolete IDs/counts are not current acceptance
criteria. A source pointer, prepared fixture or old pass is not a current test
result. Final reporting must list unresolved checks and separate local results,
image publication, deployment and production health.
