# Operations runbooks

These runbooks describe operator work on Rootset-owned services. Follow them first
on an isolated installation with synthetic data. Record the candidate, image IDs,
migration digests, commands, expected outcome, actual result and reviewer. Written
steps become acceptance evidence only after a reviewer executes them.

| Runbook                                           | Purpose                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Installation](installation.md)                   | Non-root Compose, external services, HTTPS, prerequisites and readiness.           |
| [Upgrade and recovery](upgrade-and-recovery.md)   | Forward migrations, recovery copies, failed upgrades and installation restoration. |
| [Keys and account recovery](keys-and-recovery.md) | Encryption key ring, API/hash secrets, operator binding and lost factors.          |
| [Approved operator repair](operator-repair.md)    | Bound update-only repair through the normal typed write and history path.          |
| [Jobs and dependencies](jobs-and-dependencies.md) | Leases, retries, schema recovery, SMTP/S3 outages and capacity.                    |

The local Docker profile and CI are verification environments. Neither changes
`rootset.fyi` DNS nor deploys to production. Logical database backups and full
installation disaster recovery protect different state and require separate
rehearsals.
