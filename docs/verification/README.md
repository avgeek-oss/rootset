# Verification evidence

The acceptance contract is the 205 gates in [the checklist](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md). All gates start pending. A test can prove a part of a gate; its annotation does not sign off the entire gate.

Run integration checks with the documented isolated PostgreSQL 18, SMTP and object-storage services. Prepare `.env.test` with the owner, API, DDL and identity role URLs and local keys. These credentials are read by the harness and never written to evidence. Apply finalized migrations before testing; immutable migration checksums must not be bypassed while source is being changed.

```sh
pnpm exec tsx --test tools/verification/*.test.ts
pnpm exec tsx tools/verification/gate-audit.ts verification/<run-id>
```

Each instrumented case records its ID, exact gates, the behavior actually checked, UTC times, duration and observed result. Reports under `verification/` are ignored by Git. They record the source commit and working tree digests before and after execution. A dirty or changing working tree is development evidence and cannot establish an immutable release candidate.

Keep the final candidate manifest outside the frozen source tree. It binds the exact commit, PostgreSQL/API/worker/web image digests and all 205 literal requirements to named test cases, hashed artifacts, reviewed covered clauses, explicitly empty remaining clauses and a named reviewer with a UTC review time. API, worker and web images must carry that commit in their OCI revision label. The checklist is the baseline contract; the manifest records acceptance for a particular candidate without creating a circular commit-hash reference in its source.

```sh
pnpm verify:signoff verification/<candidate>/manifest.json
```

The auditor rejects dirty or mismatched source, missing or mismatched local images, changed evidence bytes and incomplete whole-requirement reviews. Its metadata checks cannot establish that a test ran or that a reviewer assessed every clause; those observations must be present in the linked artifacts.

The gate audit lists missing evidence explicitly. It does not infer complete implementation from a green test, mark checklist boxes, invent reviewer approval or treat upload acknowledgement as backup success. Browser reviews, real MCP clients, hardware measurements, five-million-row admission and scrolling, ten-million-event history, upgrade/disaster recovery, and named final reviewers require their own evidence artifacts.

The committed `gate-evidence-plan.json` is generated from the exact checklist. It preserves every requirement and records the additional kinds of evidence required. Regenerate it when an approved architecture change modifies the acceptance contract. A change in gate count requires review.

[V1_GAP_AUDIT.md](V1_GAP_AUDIT.md) distinguishes prioritized implementation findings from broader verification gaps. Its `gate-gap-audit.json` inventories all 205 unchanged requirements with open acceptance status. Regenerate that development triage with `pnpm exec tsx tools/verification/gap-audit.ts`; it does not infer positive implementation completion or reviewer approval.

Source pointers come from explicit gate IDs in test titles or instrumented case annotations, with curated suite pointers for the actual HTTP/MCP/OAuth workflows and scale scenarios. A pointer records intended partial coverage; it is neither an observed passing result nor proof that every test in that suite covers every linked gate. Gates without a named source stay visible as gaps. Review the individual assertions and machine result artifacts before relying on a source pointer.

The scale harness creates a dedicated local organisation, a five-million-row table with 24 fields covering all eight native types, ten million retained cell changes, and a 200-field table with rows at the 65,536-byte limit. Canonical payload sizes are measured from actual values. Seeding uses the owner role with a temporary maintenance state and disabled enforcement trigger; this makes a performance fixture and is never evidence of normal write enforcement. The harness re-enables enforcement before final counts, checksums and benchmarks. Capacity and edit checks then use the ordinary application database role and real committed transactions.

```sh
pnpm exec tsx tools/verification/scale-fixture.ts verification/scale-v1
pnpm exec tsx tools/verification/scale-fixture.ts verification/scale-v1/scale-fixture.json --finalize
pnpm exec tsx tools/verification/scale-benchmark.ts verification/scale-v1/scale-fixture.json indexed 200
```

The first command creates a new fixture; use it once. The second resumes finalization only when the recorded fixture exists and its manifest remains incomplete. It checks the physical count, schema and active enforcement trigger before proceeding. It neither reseeds rows nor replaces an already complete checksum manifest. Row checksums cover ordered native PostgreSQL row JSON in bounded chunks. History checksums cover each ordered event in bounded row groups using the existing organisation/table/row index, avoiding a global external sort of ten million records. The manifest records both algorithms and chunk digests.

The benchmark accepts `capacity`, `indexed 200`, `result 5000`, `result 25000`, `history 200`, `edit 10`, `navigation`, `timeout`, `scanText`, `scanJson` or `scanRange`. Omitting the scenario runs all of them sequentially. Each timed read scenario performs 1,000 requests and records percentiles, error counts and an actual query plan where appropriate. The capacity scenario deletes one fixture row and lets ten concurrent writes compete for the released slot; it records the audited mutation rather than replacing the baseline checksums. Edit scenarios also modify fixture rows and retain their resulting history.

These timings cover the shared storage service and actual PostgreSQL application role. REST transport, OAuth, MCP, browser rendering and network timings require separate measurements. The harness records host resources, Docker engine CPU and memory, and individual container caps. The accepted server budget is 8 GiB total (PostgreSQL 4/API 1/worker 2/web 1 GiB), enforced by individual cgroups; the earlier 32 GiB PostgreSQL profile is superseded. Unconstrained development containers do not establish this budget. Seeded caches are warm; cold results remain pending until an explicit restart/cache procedure has been measured. Disk pressure and failed attempts remain recorded as limitations, without pruning unrelated containers or changing the declared acceptance targets.

For browser scale review, `scale-browser-access.ts <scale-manifest> <browser-fixture-manifest> [verified-fixture-email]` grants the existing verified local browser fixture owner access to the dedicated scale organisation. An explicit email selects one verified active Owner/Admin in the source browser fixture and grants that account only Admin access for a separate browser. It validates the named scale fixture, refuses remote database URLs, preserves the original fixture actor and records each grant separately. This is local QA setup and does not prove the product invitation flow. Select that organisation through the real account chooser before reviewing the grid.

`scale-restore-check.ts <scale-manifest> <loopback-restored-port>` compares repeatable-read source and restored PostgreSQL snapshots. It checks complete native rows in bounded actual-row-ID keyset chunks, all retained event fields in indexed row groups, exact physical counts, field metadata and the enabled history trigger. Connections are read-only and close before subsequent recovery/build/benchmark I/O. The protected local report remains development evidence and does not sign off artifact/key/authentication recovery.

The dedicated performance copy is prepared separately from disaster-recovery evidence. `scale-target-upgrade.ts <manifest> <loopback-port> <explicit-recovery-container>` applies immutable forward migrations without changing its object/SMTP settings or copied-work quarantine. `scale-http-profile.ts <manifest> <port> <container> <actual-capped-base-url> <scenario>` runs cold/warm/scans/edit 10/network requests through the shipped API using the actual scoped benchmark key. The key remains in a protected ignored file and is never printed. Cold results identify PostgreSQL shared-buffer eviction separately from OS cache state. Original source and the first retained recovery copy remain preserved.

The 205-row gap inventory now includes a manually specified `positiveReviewOracle` for each whole requirement and `wholeRequirementReviewed:false`. It is a concrete review plan, not an observed assertion or approval. Review each required condition against actual results and the exact candidate; source associations and an empty known-failure list cannot establish completion.
