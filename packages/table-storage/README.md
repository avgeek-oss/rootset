# Native table storage

`TableStorage` manages generated PostgreSQL schemas and native typed tables. The control schema stores definitions, schema journals, mutations, history and restore provenance. User rows remain native columns; JSON cells use `jsonb`.

The service accepts an authenticated `Actor` supplied by `@rootset/core`. Core performs scope, role and resource-grant checks. Every storage transaction binds the actor's organisation, and native/control RLS enforces that boundary. Runtime row operations use `rootset_app`; schema work uses `rootset_ddl`, which inherits the non-login, non-superuser managed owner. Migration credentials stay outside this package's runtime constructor.

```ts
import { TableStorage } from "@rootset/table-storage";

const storage = new TableStorage({ pool, ddlPool, cursorSecret, capacity });
const table = await storage.createTable(actor, databaseId, {
  name: "Airlines",
  fields: [{ apiKey: "CODE", label: "Code", type: "text", charLimit: 8 }],
});
const row = await storage.createRow(
  actor,
  table.id,
  { CODE: "AI" },
  {
    expectedSchemaVersion: table.schemaVersion,
    idempotencyKey: requestKey,
  },
);
await storage.updateRow(
  actor,
  table.id,
  row.id,
  { CODE: "UK" },
  {
    expectedVersion: row.version,
    expectedSchemaVersion: table.schemaVersion,
  },
);
```

## Transactions and growth admission

A native write commits values, revisions, row count, uniqueness participation, mutation outcome and cell history together. Equal assignments retain the revision and omit cell history. Batch limits, typed bounds, canonical row bytes and transport response bytes are checked before commit. Durable idempotency outcomes can be replayed after subsequent schema changes or deletion.

`mutateRows(actor, tableId, input, client?)` accepts a supplied organisation-bound transaction for imports. The import worker can commit the batch and its fenced progress checkpoint atomically. Capacity admission precedes table/row/uniqueness locks. Configured admissions refuse busy concurrent builds promptly; unconfigured writes use a shared policy fence and remain parallel. Native and control triggers require genuine transaction reservations when a storage policy applies.

Secondary indexes build with `CREATE INDEX CONCURRENTLY`. Capacity and database barriers use completed try-lock queries and bounded application polling so waiting transactions cannot retain a snapshot that prevents PostgreSQL's build from finishing. Publication verifies the native index, schema journal, current worker lease and current authority. Failed cleanup remains explicit and allocated space remains measurable.

Worker-only `MutationContext.jobFence` and `beforePublish` are checked immediately before schema or row publication. Restore namespace and copy transactions check the lease at their start and end. These private fields never enter hashes, audit context or retained definitions.

## Queries and spreadsheet windows

The query compiler accepts the shared typed AST, parameterises values and JSON paths, and supplies stable keyset ordering with a row-ID tie-breaker and nulls last. Signed cursors bind organisation, actor, grant, table, schema, query and projection. Server cursors fetch bounded chunks; response budgets include continuation metadata and keep complete rows.

Spreadsheet windows fetch at most 200 rows. Numeric position zero uses the first page without ranking the table. Deep navigation materialises sparse rank anchors for the actual filter and sort. A window session can reuse those anchors when only its projection changes; public row cursors retain projection binding. Filtered cardinality remains unknown until matching ranks are computed.

## Backup, restore and retained history

The jobs package establishes the repeatable-read snapshot and holds the shared schema barrier before extraction. `snapshotDatabase` exposes definitions plus bounded row/history iterators on that same supplied connection. Retained raw history preserves PostgreSQL timestamp precision, values, actor and context. Historical identifier remapping applies only to structural identifier keys, preserving user JSON and strings.

Restore writes into an invisible namespace and records provenance before copying. Row IDs, revisions and timestamps survive. Table, field, rule and index IDs map to the new namespace. Active rules and indexes rebuild native enforcement. Failed definitions remain inactive, and unfinished source definitions become failed with an explicit recreate/review message. Their original state and error remain available to snapshot verification.

Replacement publication preserves the target logical database ID and atomically swaps native/control mappings. A durable write barrier freezes the target before its recovery backup; each new barrier epoch invalidates an older recovery point. Publication and its durable result commit together and require the current uncancelled lease. Verification namespaces delete copied native rows, interpretation metadata, mutation outcomes and histories when discarded, leaving a small provenance/discard marker.

History retention is optional. `snapshotHistory` extracts a half-open UTC range; the jobs package encrypts and verifies its artifact. `publishHistoryArchive` binds the verified manifest to the range before `purgeArchivedHistory` removes hot cells and row events in bounded fenced transactions. Published gaps exclude that range from hot snapshots throughout an interrupted purge. Database snapshots require every referenced artifact, and jobs embed cold events in the backup. Restore materialises them as ordinary retained history and omits the superseded gap.

## Verification

The test environment requires PostgreSQL 18 and configured owner, application and DDL test URLs. Credentials are read from an ignored environment file. The regression suite creates and migrates a disposable database on a loopback service; it uses the real nonowner runtime roles and drops the database after closing its pools. This prevents long test snapshots from interfering with a separate scale fixture.

```sh
pnpm exec tsx --env-file=.env.test --test packages/table-storage/src/*.test.ts
pnpm exec tsx --env-file=.env.test packages/table-storage/src/spike.ts
pnpm --filter @rootset/table-storage typecheck
pnpm exec eslint packages/table-storage/src --max-warnings=0
```

The package tests cover typed query/keyset and byte boundaries, canonical finite-number parity, depth-32 JSON, atomic mutation rollback, schema idempotency paths, quota/native reservation boundaries, actual concurrent index retry and old-snapshot races, window anchor reuse, archive publication/purge, worker cancellation at publication, private token omission, verification cleanup, and inactive-schema restore attribution. The executable spike verifies all eight native types, UTC round trips, revisions, history, idempotency, native uniqueness and query/window behavior in a disposable installed database.

The independent verification package owns the broader concurrency, digest collision, role/access, five-million-row and ten-million-history checks. The implementation checklist records candidate evidence and reviewer sign-off separately; this package's tests alone do not constitute release acceptance.
