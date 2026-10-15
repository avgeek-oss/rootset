# Native table storage

`TableStorage` manages generated PostgreSQL schemas and native typed tables. The control schema stores definitions, schema journals, mutations, history. User rows remain native columns; JSON cells use `jsonb`.

The service accepts an authenticated `Actor` supplied by `@rootset/core`. Core performs scope and current-role checks. Every storage transaction binds the actor's organisation, and native/control RLS enforces that boundary. Runtime row and schema operations share one ordinary database owner and connection pool. Forced row-level security still applies to native tables; API/MCP callers use the current product role and typed storage operations.

```ts
import { TableStorage } from "@rootset/table-storage";

const storage = new TableStorage({ pool, ddlPool, cursorSecret });
const table = await storage.createTable(actor, databaseId, {
  name: "Airlines",
  fields: [{ name: "CODE", type: "text", charLimit: 8 }],
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

## Transactions and schema work

A native write commits values, revisions, row count, uniqueness participation, mutation outcome and cell history together. Equal assignments retain the revision and omit cell history. Batch limits, typed bounds, canonical row bytes and transport response bytes are checked before commit. Durable idempotency outcomes can be replayed after subsequent schema changes or deletion.

`mutateRows(actor, tableId, input, client?)` accepts a supplied organisation-bound transaction so callers can commit row changes and their durable operation receipt atomically.

Worker-only `MutationContext.jobFence` and `beforePublish` are checked immediately before schema or row publication. These private fields never enter hashes, audit context or retained definitions.

## Conditional uniqueness

Unique rules may include one validated scalar `where` predicate, stored with a stable field ID. Native rules compile it to a partial unique index; wide-key registry rules filter backfill and trigger participation with the same equality/null semantics. The condition is immutable for the rule's lifetime. NULL key parts remain excluded. A field set may have different conditions, but duplicate definitions are rejected.

Rule creation holds the database schema barrier and table metadata lock through conflict scanning, registry/index build, worker publication fencing and commit. The existing transaction protects every writer and rolls failed activation back. Registry writes acquire digest buckets for participating old/new tuples, remove prior participation, and check exact tuples before insertion. Renames retain IDs; deletion and conversion check both key and condition dependencies. Unrelated conversions preserve partial index predicates when rebuilding native tables.

Migration `0004_field_constraints.sql` adds nullable condition metadata and replaces the row trigger function. The same trigger checks text allowed-value membership for every audited native write. Field changes validate defaults and scan existing rows under the table lock before replacing the definition; failed changes retain values, history and schema version. Existing unconditional indexes, registry entries and NULL semantics are preserved. Only the ordinary service owner may perform storage writes with audited mutation context; this is not a public SQL execution interface.

## Queries and spreadsheet windows

The query compiler accepts the shared typed AST, parameterises values and JSON paths, and supplies stable keyset ordering with a row-ID tie-breaker and nulls last. Signed cursors bind organisation, actor, live authority, table, schema, query and projection. Server cursors fetch bounded chunks; response budgets include continuation metadata and keep complete rows.

Spreadsheet windows fetch at most 200 rows. Numeric position zero uses the first page without ranking the table. Deep navigation materialises sparse rank anchors for the actual filter and sort. A window session can reuse those anchors when only its projection changes; public row cursors retain projection binding. Filtered cardinality remains unknown until matching ranks are computed.

## Retained history

Rootset automatically retains the latest 200 saved changes for each cell. Each entry records its previous value, new value, actor, source and UTC timestamp. Older entries are deleted in the same transaction as the next change; there is no retention policy, archive job or cold storage. Equal assignments and rolled-back writes do not add history. Deleting a row, field, table, or database removes the corresponding cell history in the same transaction. Administrators cannot retrieve deleted-cell changelogs.

The PostgreSQL history trigger covers native row writes and field conversions. API and MCP history operations read the same retained entries as the dashboard cell changelog. Pagination preserves complete entries within the response byte budget.

## Verification

The test environment requires PostgreSQL 18 and one configured test database URL. Credentials are read from an ignored environment file. The regression suite creates and migrates a disposable database on a loopback service; it uses the ordinary non-superuser database owner and drops the database after closing its pools. This prevents long test snapshots from interfering with a separate scale fixture.

```sh
pnpm exec tsx --env-file=.env.test --test packages/table-storage/src/*.test.ts
pnpm exec tsx --env-file=.env.test packages/table-storage/src/spike.ts
pnpm --filter @rootset/table-storage typecheck
pnpm exec eslint packages/table-storage/src --max-warnings=0
```

The package tests cover typed query/keyset and byte boundaries, canonical finite-number parity, depth-32 JSON, atomic mutation rollback, schema idempotency paths, actual concurrent index retry and old-snapshot races, window anchor reuse, per-cell retention, worker cancellation at publication, private token omission and artifact verification. The executable spike verifies all eight native types, UTC round trips, revisions, history, idempotency, native uniqueness and query/window behavior in a disposable installed database.

The independent verification package owns the broader concurrency, digest collision, role/access, five-million-row and ten-million-history checks. The implementation checklist records candidate evidence and reviewer sign-off separately; this package's tests alone do not constitute release acceptance.
