# Upgrade and recovery

Upgrade and recovery are installation-operator actions. Record source commit,
image IDs, current migration names/digests, key IDs and the recovery artifact
checksums. Use a protected directory with `umask 077`; dumps, object copies and
configuration contain sensitive data.

## Before an upgrade

1. Review the candidate's forward migrations and dynamic schema-journal changes.
   Retain the old image IDs and migration report. Do not replace an applied SQL
   file: Rootset verifies its digest and rejects an altered migration.
2. Confirm each logical database's latest backup reached verified success and
   rehearse its isolated restore. A scheduled or uploaded backup is insufficient.
3. Prepare a full installation recovery copy using the procedure below. Protect
   the encryption-key ring separately and confirm the selected copy restores on
   an isolated installation with the same PostgreSQL major version.
4. Stop new changes and let active jobs reach safe checkpoints. Preserve their
   persisted lease/checkpoint/journal state. Stop API and worker for the
   installation snapshot; leave PostgreSQL and object storage running.

## Apply forward migrations

Build reviewed images from the candidate, then run the one-shot migration service
before starting its API/worker:

```sh
docker compose --profile local stop web api worker
docker compose --profile local build
docker compose --profile local run --rm migrate
docker compose --profile local up -d worker api web
docker compose --profile local ps
```

For external services omit `--profile local`. The migration process takes an
advisory lock, verifies existing digests and commits each new migration
transactionally. A failed migration rolls back its transaction. Previously
committed migrations remain applied; inspect the persisted migration report.

Check actual API readiness, the current worker's fresh heartbeat and redacted
installation status. Reconcile dynamic journals through their persisted jobs;
verify a representative existing table's schema, values, row versions, unique
rules and cell history. Verify restored backups and newly produced backups after
the upgrade. These checks also catch an accidental switch to new empty volumes.

There is no general down-migration promise. Code rollback is safe only if the
candidate explicitly documents compatibility with the resulting schema. If it
does not, stop writers and restore the pre-upgrade installation copy into an
isolated environment before a reviewed cutover. Do not guess at reverse DDL.

## Full installation recovery copy

A logical database backup does not contain all organisations, identities, grants,
OAuth/key state, control jobs, installation credentials or outbox state. Full
recovery needs PostgreSQL state, the referenced object set and the protected
configuration/key ring.

After stopping API and worker, write a custom-format dump into a protected
directory. Use the configured migration-owner service role only for this
operator-controlled action:

```sh
umask 077
mkdir -p recovery-copy
docker compose --profile local exec -T postgres pg_dump --username rootset_owner --dbname rootset --format custom > recovery-copy/rootset.dump
```

A database dump does not include PostgreSQL's cluster-global roles or their
memberships. Retain the definitions and membership graph of every Rootset login,
managed owner, fixed-function owner and capacity reporter, including the
NOSUPERUSER/NOBYPASSRLS boundaries and any narrowly scoped fixed-function
exception. Restore that role graph before replaying dump ownership and grants;
the initial application/DDL/identity logins alone are insufficient. Protect
login credentials separately in the retained configuration. For a dedicated
Rootset PostgreSQL cluster, a supported physical backup with streamed WAL and a
verified manifest preserves the role graph together with database state. For a
shared cluster, use the provider's reviewed backup and role export process
without copying unrelated customer credentials.

Use the storage provider's supported snapshot/export tooling to copy the complete
Rootset bucket while writers remain stopped. Record the bucket inventory and
checksums. Copy `.env` and all active/retained encryption keys into the separately
protected recovery store. Encrypt the recovery set using the organisation's
reviewed recovery tooling and preserve access to the decryption key separately.
Do not place unencrypted recovery copies in the repository or a public bucket.

Check that the dump is nonempty and readable with `pg_restore --list`, and that
the object inventory and protected key IDs were recorded. Restart services only
after the recovery set is complete. An interrupted copy must be labeled failed.

## Restore on an isolated installation

1. Use a new Compose project, new named volumes and a separate browser origin.
   Prepare PostgreSQL 18 roles with the same role names. Keep the source
   installation and its objects intact. Recreate the complete retained Rootset
   role graph, including managed/fixed-function owners and the reporter, before
   restoring ownership or grants.
2. Keep API/worker stopped. Restore the dump with PostgreSQL `pg_restore` as the
   prepared owner; include ownership and grants, and stop on error. On the new
   empty target, use `--clean --if-exists --exit-on-error` as appropriate. Do not
   run a clean restore against an unconfirmed source or populated destination.
3. Restore the bucket into a separate target bucket and configure its endpoint.
   Restore retained encryption keys and installation credentials separately.
   Keep source session/OAuth origins in mind: use a reviewed isolated-origin
   configuration and reconnect clients/factors where origin binding requires it.
4. Compare organisations, membership/grants, jobs, schemas, typed values,
   revisions, uniqueness rules, cell/control history and artifact digests. Verify
   decryption and an isolated logical restore, then start the worker and verify
   lease/checkpoint recovery without duplicate committed effects.
5. Record the actual recovery time and data cutoff. Cutover to a real service
   requires separate deployment authorization and final dependency checks.

The v1 checklist requires a populated forward-upgrade fixture and a forced failed
upgrade/recovery rehearsal in addition to clean installation. Evidence from one
scenario cannot sign off the others.

## Repository verification helpers

The recovery helpers deliberately accept only the dedicated local Rootset v1
fixture, its `com.rootset.fixture=v1` Docker label and loopback PostgreSQL port 55448. They are rehearsal tools, not general commands for a customer installation.
Coordinate their I/O with performance verification before running them.

```sh
pnpm exec tsx --env-file=.env.test tools/recovery-fixture.mjs
node tools/recovery-rehearsal.mjs --run
node tools/recovery-objects.mjs verification/delivery/physical-recovery-TIMESTAMP
```

The fixture creates a separate synthetic organisation, typed row, persisted
encrypted control payload and encrypted artifact under the retained fixture key.
The physical backup uses `pg_basebackup`, streamed WAL and SHA-256 manifests,
then runs `pg_verifybackup` before starting isolated PostgreSQL 18. The host copy
has a protected 0700 parent; retained keys and reports are mode 0600. Existing
containers, databases and original fixture volumes are preserved.

The restored test server defaults to port 55460. For a separate subsequent
rehearsal, set `ROOTSET_RECOVERY_TARGET_NAME` to a name beginning
`rootset-delivery-physical-recovery-` and `ROOTSET_RECOVERY_TARGET_PORT` to another
unused loopback port in 55000–55999. Existing recovery containers are never
overwritten. The report records actual target name/port and image digest.

Metadata comparisons distinguish objects unchanged across the online copy from
objects legitimately changed by concurrent verification. Record the consistent
WAL cutoff and compare the complete stable scale rows/history separately; a
wall-clock global row count is not a snapshot-equivalence test. Object recovery
copies every ready artifact referenced by the restored metadata, verifies
ciphertext and plaintext hashes/lengths and authentication tags with the retained
keys, and discards decrypted bytes without writing another plaintext copy.

An empty set of ciphertext/artifacts does not prove nonempty key/object recovery.
Use the dedicated encrypted fixture and record its successful decryption,
matching content hashes and restored control/data relationships before signing
off that scenario. The original fixture can be removed only after review accepts
the recovered state and retained evidence.
