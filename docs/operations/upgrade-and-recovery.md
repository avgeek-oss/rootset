# Fresh baseline and recovery

V1 is still prelaunch. It has one fresh-install baseline,
[`0001_baseline.sql`](../../packages/database/migrations/0001_baseline.sql), which
may be regenerated before release. There is no supported upgrade from the former
migration sequence. An earlier ledger or a changed applied digest must refuse
startup; preserve its data and use a separate empty installation. Do not edit the
ledger, run reverse DDL or replace old volumes to make the refusal disappear.

Recover an older installation with its matching source/images/schema and retained
keys. A recovery copy is not a conversion into the new baseline. Any future data
transfer needs its own reviewed, tested procedure.

The current baseline calls the former `editor` role `member`; permissions are
unchanged. Fresh installations accept only `admin`, `member` and `viewer`.
An older installation is recovered with its matching schema and original role
values. A future reviewed transfer into a fresh installation must map membership
and pending-invitation `editor` values to `member`, preserve identities and
last-Admin protection, and reissue origin-bound credentials through supported
flows. This repository does not automatically rewrite an older schema, its digest
or live memberships to perform that conversion.

## Prepare an installation recovery copy

A logical database backup includes table data and history, but excludes account
credentials and much installation state. Full recovery needs PostgreSQL state
and SQL privileges, referenced objects, protected configuration and retained keys.

1. Identify the installation/project, source version, PostgreSQL major, baseline
   digest, object bucket and key IDs. Retain the existing images and configuration.
2. Verify a recent logical backup by encrypted readback and isolated restore.
   Record its data cutoff and validation result; uploaded is not verified.
3. Stop new changes and let jobs reach safe checkpoints. Stop this installation's
   web/API/worker while keeping PostgreSQL/object storage available for copying.
   Preserve lease, checkpoint and schema-journal state.
4. Use the PostgreSQL/provider's supported backup procedure in a protected
   directory (`umask 077`). A database-only `pg_dump` omits cluster roles: retain
   the complete Rootset login/owner/fixed-function role membership and grant graph.
   A dedicated-cluster physical backup with WAL preserves that graph together
   with database state. Shared-cluster procedures must not copy unrelated data
   or credentials.
5. Copy the complete referenced Rootset object set with provider tooling while
   writers remain stopped. Record nonempty inventory, lengths and checksums.
   Retain protected configuration and every encryption key referenced by data,
   objects or recovery copies. Encrypt the recovery set and protect its recovery
   key separately.
6. Validate the PostgreSQL backup/manifest and object inventory. Mark an interrupted
   copy failed; restart the source only after its copy is complete or safely
   abandoned. Keep source volumes and original objects intact.

Never store plaintext recovery copies in Git or public buckets. A role definition
file, database dump and encrypted artifact can all contain sensitive material.
Record only redacted metadata in a shared incident report.

## Restore on a separate target

1. Create a separate installation/project with new volumes, bucket and browser
   origin. Match the recorded PostgreSQL major and Rootset source/schema. Keep
   target web/API/worker stopped and confirm the destination is not the source.
2. Restore the retained SQL role graph before ownership/grants and database state.
   Use PostgreSQL's supported restore/physical recovery procedure, stop on errors
   and preserve the failed target for diagnosis. Do not issue a clean restore
   against an unconfirmed or populated source.
3. Restore objects into the separate bucket and configure retained keys/secrets.
   Check OAuth/passkey/session origin bindings and use the supported reconnect/
   sign-in procedures where the target origin differs.
4. Compare the single organisation, memberships/roles, identity/control records,
   jobs/journals, schemas, typed values, revisions, uniqueness, row/cell history
   and artifact counts/checksums. Decrypt a nonempty object set and verify a
   logical restore; an empty bucket proves neither object nor key recovery.
5. Start target services, check readiness and resume leases/checkpoints without
   duplicate effects. Exercise authentication, live key authority and a new edit
   with history. Record actual recovery duration, snapshot/WAL cutoff and any
   divergence caused by source changes after the copy.

Keep the original available until the recovered state is reviewed. A real cutover
or deployment requires the user's authorization. Source-preserving recovery,
failed restore/cutover and fresh installation are distinct checklist checks.

## Logical restore

Admins may restore a verified database backup as a new logical database. Validate
schema, values, history, constraints and manifests before exposure. Failed or
unfinished captured indexes/rules remain inactive. Replacement restore needs
explicit approval, a recovery point, staged validation and atomic cutover; failure
preserves the existing generation. See the
[storage contract](../../rc-plan/MDM_DATABASE_ARCHITECTURE.md#imports-exports-and-backups).

Repository recovery helpers use isolated synthetic fixtures. Check their current
arguments and target restrictions before running them; a historical retained
fixture from the former schema is not automatically compatible with this baseline.
The [verification guide](../verification/README.md) records remaining rehearsals.
