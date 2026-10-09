# Jobs and exports

`JobsService` runs the same operations called by REST, MCP and the browser. API processes enqueue work; the separate worker claims jobs using PostgreSQL leases. Run the worker with `pnpm --filter @rootset/worker start` after applying migrations and loading the installation environment.

Each claim has a fencing token. Heartbeats extend the lease, and every committed checkpoint checks ownership.

Cancellation, retry and asynchronous operation creation use shared mutation receipts. The receipt, operation effects and any consumed approval commit in the same organisation transaction. Receipts bind the current principal, credential, operation, input and an idempotency key of 8–255 characters using the installation's persistent key-hash secret. Current resource authority is checked before replay, including the original job target.

Export Requests list retained requests with their format, status, row count and download action. Each request exports the entire table; API and MCP inputs accept only the file format, without field selection or row filters.

CSV and JSONL exports preserve typed values, leading-zero text, UTC timestamps and nulls. CSV uses `\N` for null, quotes empty text and escapes leading backslashes.

Artifacts use authenticated AES-256-GCM encryption and SHA-256 checksums. Each worker lease writes a distinct immutable object key, so an expired worker cannot overwrite its successor's artifact. Downloads authenticate the caller, recheck current target access, authenticate the encrypted object and verify checksums before serving plaintext. Temporary verification files contain ciphertext with mode `0600`; plaintext is streamed only after the complete object validates. The download URL never contains an API key.

Exports recheck the original requester's current authority and the job's lease and cancellation state between source batches and before artifact publication. A cancellation or loss of current role or OAuth authority prevents publication of a readable export. An expired worker cannot fail the job after losing its lease. A Viewer can cancel and retry their own export while their original row and export authority remains valid; other requesters cannot control it.

Validation spools ciphertext in `ArtifactConfig.tempDirectory` (the operating-system temporary directory if absent), with a one-GiB free-space reserve in addition to the object size. Production containers mount a writable disk-backed spool; the small `/tmp` mount is insufficient. The worker removes abandoned ciphertext validation directories after 48 hours, checking the directory name and operating-system ownership.

Keep `ROOTSET_ENCRYPTION_KEY` with the installation recovery configuration. Replacing it makes existing encrypted artifacts unreadable. Rootset has no database backup or restore operations; operators use PostgreSQL/provider tools.

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

The suite creates and migrates a disposable PostgreSQL database, supplies its test URL to child workers, removes its own S3 objects and drops the database on completion. It exercises encrypted exports, CSV value preservation, cancellation, current authority checks, stale worker fencing, metadata cursors and durable admission replay. Run it against each supported S3-compatible provider. Its passing result does not establish full-scale or browser verification.
