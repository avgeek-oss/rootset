# Development verification record

This record describes local development evidence on 2 October 2026. The working tree was changing during implementation. It is not an immutable candidate audit, a reviewer approval or a declaration that the 205 acceptance gates are complete. The gate index preserves each exact requirement, partial source pointers and additional evidence still required.

The independent storage/access/collision suite completed **33 passing cases, zero failures and zero skips**, including its owned disposable-database teardown. The earlier cleanup timeout occurred during physical-backup I/O and is retained as a failed development attempt. Only fixture database administration now has a sixty-second timeout; application query limits remain unchanged. Parent is rerunning the expanded independent suite against the current migrations before candidate freeze.

The two earlier database-creation failures are corrected. Actual Core tests now deny creation outside a restricted personal key's database targets and allow an Editor with an explicit organisation-level manage grant to create, read and enumerate a database. All six access cases passed, including next-request personal/team credential authority changes. These service actor fixtures are explicitly separate from real password/cookie/OAuth transport proofs.

The separate ownership/observability suite passed **six cases** on a real disposable PostgreSQL cluster. It covers populated ownership upgrades with physically dropped schemas/tables and retained metadata/history, simultaneous two-database upgrades, protected role/function denial, reporter upgrades, actual pool saturation and SMTP socket failure, and migration 035 identity-role job-control permissions. Same-org identity INSERT/SELECT/UPDATE works; peer reads/updates are invisible, peer insert/reassignment rejects, and DELETE is denied for all four control tables. Three bounded logging tests also passed. The DDL credential is a trusted schema service with managed-table ownership; these tests do not claim hostile table-owner RLS protection.

The new deletion lifecycle case passed after strict output-schema validation was added. Real setup, email verification and password login produce a current Owner. An unapproved bound deletion fails; approval admits exactly one durable job with replay, and the actual worker reaches deleted organisation/database/table state with one durable outcome and audit. The current session and API key become unusable, while native data, two cell events, an actual verified encrypted backup and peer organisation data remain under the default indefinite retention policy. Fixture-owned S3 objects are removed during teardown. Its latest protected development report is `verification/working-2026-10-02T15-18-07-248Z/88765-integration.json`.

API/OAuth, identity, capacity, jobs, browser and delivery agents maintain separate real-service reports. The API's typed matrix exercises accepted/rejected values through REST and actual MCP with native PostgreSQL/history/export oracles. The catalog has 104 entries; discovery and invalid-credential sweeps are distinct from successful handler execution. [OPERATION_COVERAGE_REVIEW.md](OPERATION_COVERAGE_REVIEW.md) records that distinction and remaining semantic cases. No suite count implies all 205 requirements passed.

```sh
pnpm exec tsx --test tools/verification/*.test.ts
node --env-file=.env.test --import tsx --test apps/rootset-api/src/*.test.ts packages/oauth/src/oauth.test.ts
pnpm exec tsc -p tools/verification/tsconfig.json
pnpm exec eslint tools/verification --max-warnings 0
```

The large fixture contains exactly five million physical rows with 24 fields, three of each supported type. Its measured 1,000-row canonical UTF-8 sample ranges from 945 to 960 bytes, averaging 958.175 bytes. It initially contains ten million retained cell changes across 1,000 repeatedly edited rows. A separate 200-field table has 20 rows at exactly 65,536 canonical bytes. The complete seed manifest records schemas, distributions, physical counts, ordered row and history checksums, and relation sizes. Normal benchmark mutations are recorded separately and change those baseline checksums.

| Local warm service scenario                               | Requests | 95th percentile | Observed errors |
| --------------------------------------------------------- | -------: | --------------: | --------------: |
| Indexed typed 200-row query                               |    1,000 |        16.60 ms |               0 |
| 200-event cell history within ten million events          |    1,000 |         6.61 ms |               0 |
| Normal-width 5,000-row query and serialization            |    1,000 |       230.07 ms |               0 |
| Requested 25,000 rows, stopped at 8 MiB on whole rows     |    1,000 |       474.36 ms |               0 |
| 1,000 committed cell edits through ten concurrent clients |    1,000 |        60.77 ms |               0 |

The edit scenario checks each of the ten rows gained exactly 100 revisions and 100 corresponding history events. It identifies the actual client actor and revision interval, verifies 100 distinct mutation IDs and compares the complete expected revision sequence. This checks the committed edits rather than sampling older seed events.

At the real five-million-row boundary, a normal application-role create was rejected. Deleting one row freed a slot; ten simultaneous application-role creates then produced one commit and nine capacity rejections. Physical row count and the committed metadata counter both returned to five million, with the enforcement trigger enabled. This is a write-enforcement test after performance seeding, rather than a claim based on a manually assigned count.

The measured host has an Apple M5 Pro, 15 logical CPUs and 24 GiB RAM. The original Docker engine reports 8 CPUs and 16,733,794,304 bytes of memory. The earlier warm measurements above ran on shared uncapped development services. They remain historical observations.

The user approved an **8 GiB combined server budget** on 2 October 2026: PostgreSQL 4 GiB, API 1 GiB, worker 2 GiB and web 1 GiB, with the same fixtures and latency/cache/memory thresholds. Final measurements must inspect enforced cgroups and shipped image digests for all four services. Browser memory and dedicated S3/SMTP prerequisite resources are reported separately. The old 32 GiB PostgreSQL/500 GiB SSD profile is not required for this accepted v1 run.

The dedicated performance copy on port 55461 preserves the five-million-row fixture and is forward-migrated through 037. Target-only encrypted settings point to a dedicated RustFS bucket and Mailpit instance; copied pending jobs/policies are quarantined. The actual rendered benchmark key was copied only into its existing verified current Owner membership, explicitly as QA setup rather than authentication issuance or disaster-recovery proof. Original source 55448 and retained recovery 55460 are preserved.

Final capped cold/warm HTTP, API-to-PostgreSQL/client RTT, selective/nonselective scans, background work, repeated switching and restart measurements remain pending. Cold methodology evicts and verifies relevant PostgreSQL shared buffers before each request; it does not claim cold OS page cache. Native Safari and VoiceOver are blocked while the Mac is locked. Automated WebKit-engine evidence is recorded separately and cannot substitute for native Safari or screen-reader review.

The Docker filesystem had about 3.1 GiB available while the source PostgreSQL database occupied about 13 GiB. One attempted global history checksum sort failed with PostgreSQL `53100` because of temporary disk pressure; an earlier inefficient checksum query was explicitly cancelled with `57014`. The source fixture was preserved. Finalization succeeded with bounded checksum groups using the existing history lookup index. No unrelated Docker data was pruned, no migration checksums were bypassed, and no data was moved to change measured performance.

Remaining acceptance work includes complete role/credential/resource combinations through the public transports, same-candidate browser and accessibility artifacts, final capped cold/warm scale measurements, foreground health under scans and background jobs, genuine process termination/restart recovery, installation/upgrade/disaster recovery, exact image/config/contract/migration digests and named implementation/verification reviewers. The successful focused checks above do not remove these requirements or sign off whole gates.
