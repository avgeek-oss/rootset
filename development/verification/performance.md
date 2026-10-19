# Performance verification

These are benchmark targets, not a claim that every release has passed them.
Record the exact version, environment and observed results.

Keep combined memory caps at PostgreSQL 4 GiB, API 1 GiB, worker 2 GiB and web
1 GiB, totalling 8 GiB with no additional swap. Record actual CPU/disk/PostgreSQL
settings and contention. Local object/mail dependencies are separate test
fixtures; measure browser memory separately. Browser-to-API RTT is at most 50 ms
and API-to-PostgreSQL RTT at most 10 ms.

Use five million live rows, 24 fields spanning all eleven types and average
canonical row size 0.5–1 KiB. Add indexed/unindexed, selective/nonselective and
sorted queries, a 200-field near-limit fixture, null/duplicate cases and at least
ten million retained history events. Cold and warm are separate. Collect at least
1,000 timed requests per interactive scenario with p50/p95/p99 and errors.

| Scenario                                     | Target                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Indexed 200-row page                         | Warm server p95 ≤500 ms; cold p95 ≤1.5 s                                                   |
| Normal-width REST 5,000-row page             | Warm server p95 ≤2 s with byte cap                                                         |
| Single-cell committed edit including history | End-to-end p95 ≤500 ms on declared network                                                 |
| Cell-history lookup, 200-event page          | Warm server p95 ≤500 ms                                                                    |
| First usable spreadsheet viewport            | Cold ≤2.5 s; warm ≤1 s                                                                     |
| Sustained grid scroll                        | Median ≥50 FPS; frame-time p95 ≤32 ms; no ≥1 s main-thread freeze                          |
| Five-minute wide-range scroll                | Row cache ≤50 MiB; browser growth after warmup/eviction ≤150 MiB; no unbounded growth      |
| Expensive unindexed query                    | Actionable timeout within 10 s plus bounded transport cleanup; peer service remains usable |
