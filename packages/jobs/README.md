# Jobs, imports, exports and history archives

`JobsService` runs the same operations called by REST, MCP and the browser. API processes enqueue work; the separate worker claims jobs using PostgreSQL leases. Run the worker with `pnpm --filter @rootset/worker start` after applying migrations and loading the installation environment.

Each claim has a fencing token. Heartbeats extend the lease, and every committed checkpoint checks ownership. Imports persist their batch plan before writing. The worker commits rows, cell history, batch outcomes and committed progress in one transaction. A resumed worker uses the existing plan and deterministic mutation keys. Cancellation preserves committed batches and returns their counts.

Cancellation, retry and asynchronous operation creation use shared mutation receipts. The receipt, operation effects and any consumed approval commit in the same organisation transaction. Receipts bind the current principal, credential, operation, input and an idempotency key of 8–255 characters using the installation's persistent key-hash secret. Current resource authority is checked before replay, including the original job target.

CSV imports use explicit field mappings. Text stays text, including leading zeroes. `\N` represents null; an empty string remains an empty text value. A text value beginning with a backslash has one additional leading backslash in the exported CSV, so literal `\N` becomes `\\N`. Exports quote empty strings, preserving a one-column empty-text row. Numeric cells use JSON number syntax, booleans use `true` or `false`, and time/date-time values use the UTC contract. JSONL rejects duplicate keys and malformed Unicode; a malformed individual JSONL record produces a record-level error while later valid records can commit. Integer fields and JSON numbers must remain lossless safe integers when integral; float fields accept finite values such as `1e100`. Dry-run results return `valid`, `examined`, `accepted`, `rejected`, bounded errors and a complete report artifact. They describe validation at that time; later writes still recheck revisions, uniqueness and capacity.

Artifacts use authenticated AES-256-GCM encryption and SHA-256 checksums. Upload preparation lasts ten minutes and declares the exact byte length and optional checksum. Uploaded files are converted to encrypted artifacts before parsing. Each worker lease writes a distinct immutable object key, so an expired uploader cannot overwrite its successor's artifact. Downloads authenticate the caller, recheck current target access, authenticate the encrypted object and verify checksums before serving plaintext. Temporary validation files contain ciphertext with mode `0600`; plaintext is streamed only after the complete object validates. The download URL never contains an API key.

Exports recheck the original requester's current authority and the job's lease and cancellation state between source batches and before artifact publication. A cancellation or loss of current role or OAuth authority prevents publication of a readable export. An expired worker cannot fail the job after losing its lease. A Viewer can cancel and retry their own export while their original row and export authority remains valid; other requesters cannot control it.

Installed browser/API uploads use an authenticated API-origin binary PUT route. The backend streams each attempt to a distinct staging object, checks declared bytes and checksum, then encrypts and publishes the readable artifact before returning the upload receipt. Both stages share the prepared upload's ten-minute deadline and recheck current import authority before publication. Exact replay compares the complete source hash; different content conflicts. This works when the S3 service is private to the installation network. Standalone storage verification can use a directly signed S3 URL when `uploadBaseURL` is absent. Prepared-upload responses declare the method, required headers and byte length. Neither transfer path writes plaintext to disk.

Validation spools ciphertext in `ArtifactConfig.tempDirectory` (the operating-system temporary directory if absent), with a one-GiB free-space reserve in addition to the object size. Production containers mount a writable disk-backed spool; the small `/tmp` mount is insufficient. The worker removes abandoned ciphertext validation directories after 48 hours, checking the directory name and operating-system ownership. Published history archives remain protected from temporary artifact cleanup.

Keep `ROOTSET_ENCRYPTION_KEY` with the installation recovery configuration. Replacing it makes existing encrypted artifacts unreadable. Rootset has no database backup or restore operations; operators use PostgreSQL/provider tools.

History stays hot indefinitely by default. An enabled table retention policy archives events strictly before its scheduled UTC cutoff into an encrypted, authenticated object, retaining field interpretations and original actors, contexts, values and revisions. The worker verifies counts and a SHA-512 multiset fingerprint before publishing a half-open covered range and deleting hot cell/row events in bounded, fenced transactions. An interrupted purge resumes from committed counters. Published archive objects remain pinned even if the purge job is later cancelled.

The queue exposes `queued`, `running`, `succeeded`, `failed`, `cancelled` and `partially_completed`, with a separate stage and committed progress. Locked reconciliation checks immutable committed outcomes before expiring the final attempt or cancelling queued work. A crash after committed success therefore reports that success without executing again with revoked authority. A queued response is an acknowledgement. Inspect the terminal job state before treating work as complete.

## Verification

Unit checks:

```sh
pnpm --filter @rootset/jobs test
```

The integration suite requires an actual PostgreSQL database with one owner credential and S3-compatible storage. From the repository root, load the fixture configuration and run:

```sh
pnpm exec tsx --env-file=.env.test --test packages/jobs/src/integration.ts
```

The suite creates and migrates a disposable PostgreSQL database, supplies its test URL to child workers, removes its own S3 objects and drops the database on completion. It exercises actual process `SIGKILL` recovery, partial and atomic imports, unique-rule upserts, encrypted exports, stale upload/lease fencing, corruption, and verified history archives with interrupted purge. Run it against each supported S3-compatible provider. Its passing result does not establish full-scale or browser verification.
