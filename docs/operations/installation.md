# Installation

Use Node.js 24, pnpm 11.5.3, Docker Compose v2 with `depends_on.required` support
and PostgreSQL 18. Dependencies are public. Build from the committed lockfile;
a failed one-shot baseline migration must prevent API/worker startup.

## Local installation

```sh
pnpm install --frozen-lockfile
pnpm setup:env
docker compose --profile local up --build -d
docker compose --profile local ps
```

`setup:env` creates `.env` once with mode 0600. Keep it outside Git and retain an
encrypted recovery copy. Open `http://localhost:4300`, supply the bootstrap secret
privately and verify email to establish the first Admin and single organisation.
Mailpit at `http://localhost:8025` captures local email. There is no organisation
chooser or second-organisation setup.

The local profile supplies PostgreSQL, RustFS object storage and Mailpit. Named
volumes preserve data across `docker compose down`; `down --volumes` deletes them.
Changing `ROOTSET_COMPOSE_PROJECT` selects a different volume namespace. Confirm
which installation owns the volumes before interpreting an empty startup.

The only installation SQL is
[`0001_baseline.sql`](../../packages/database/migrations/0001_baseline.sql).
It is an editable fresh-install baseline before V1 release. Startup serialises
baseline application and checks the stored digest. An incompatible prelaunch
ledger must refuse startup without changing data and point to a fresh, separate
installation. Never clear its ledger or remove its original volumes to bypass
that refusal. Dynamic user-table jobs still have their own schema journals.

## Runtime boundaries and resources

Web/API/worker run as UID 10001 with dropped capabilities, read-only root
filesystems and narrow temporary/durable mounts. There is no Docker socket.
API/worker artifact spools are private durable directories under
`/var/lib/rootset/artifact-spool`; they are not unbounded heap buffers. Runtime
services do not receive `ROOTSET_MIGRATION_DATABASE_URL`; the one-shot migration
service receives deployment migration authority.

Application, identity and trusted DDL credentials have distinct SQL privileges.
The DDL service may alter managed tables and therefore must be protected as a
trusted service credential. An Admin membership does not expose SQL credentials.

The existing core memory caps are PostgreSQL 4 GiB, API 1 GiB, worker 2 GiB and
web 1 GiB, totalling 8 GiB. Each combined memory/swap cap equals its memory cap,
so swap adds no headroom. Node heap limits leave native/buffer room. Record CPU,
disk, PostgreSQL settings and host contention for benchmarks. Local object/mail
services are separate test fixtures, and browser memory is measured separately.
The [performance profile](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md#performance-profile)
retains the full five-million-row workload and latency/cache targets.

## External services and HTTPS

Configure the declared PostgreSQL application/identity/DDL/migration URLs,
S3-compatible endpoint/bucket/credentials and SMTP endpoint/TLS/sender in the installation `.env` file. These settings have no UI/API override.
Optional SMTP authentication uses `ROOTSET_SMTP_USER` and
`ROOTSET_SMTP_PASSWORD`. Restart API and worker after changing their environment.
Installation health is read-only; no test-email action is provided. Do not copy a migration-owner URL into runtime settings. Keep
persistent authentication, key-hash, cursor and encryption secrets across restarts.
Test artifact encryption/readback and actual email delivery before relying on
backups or account recovery.

Serve the browser and API through the configured origin. Remote installations
require HTTPS; plain HTTP is a loopback development exception. Configure the
public base URL, trusted origins, secure cookies and OAuth discovery/redirect
URLs together. Do not expose the internal API listener or local SMTP/object
administration interfaces as public product endpoints.

## Confirm startup

Check Compose terminal status, actual API readiness and a fresh worker heartbeat.
A running process or image build alone does not establish readiness. Review
redacted dependency/migration errors, then exercise setup, sign-in, a typed edit
and its history. Verify the configured volume namespace and object endpoint.
Record missing prerequisites rather than treating them as passing checks.

Use [jobs and dependencies](jobs-and-dependencies.md) for failures and
[recovery](upgrade-and-recovery.md) before storing irreplaceable data. Current
fresh-install, native browser and recovery verification remains pending until
those procedures run against the revised candidate.
