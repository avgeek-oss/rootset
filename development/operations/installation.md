# Installation

Use Node.js 24, pnpm 11.5.3, Docker Compose v2 with `depends_on.required` support
and PostgreSQL 18. Build from the committed lockfile;
a failed one-shot baseline migration must prevent API/worker startup.

## Package registry

Rootset consumes `@avgeek-oss/design-system` and `@avgeek-oss/mintlify-docs` from npmjs.org through their public exports. Source installation and Docker builds require no registry credential:

```sh
pnpm install --frozen-lockfile
docker build --target web --tag rootset-web:local .
```

The repository maps `@avgeek-oss` to `https://registry.npmjs.org`. Update that mapping and the dependency lockfile when migrating an older checkout. GitHub authentication remains separate for GHCR image publication.

## Local installation

```sh
pnpm install --frozen-lockfile
pnpm setup:env
docker compose --profile local up --build -d
docker compose --profile local ps
```

`setup:env` creates `.env` once with mode 0600. Keep it outside Git and retain an
encrypted recovery copy. Open `http://localhost:4300`, supply `ROOTSET_SECRET` as the setup secret
privately to establish the first Admin and single organisation. The first Admin
is email-verified automatically.
Mailpit at `http://localhost:8025` captures local email. There is no organisation
chooser or second-organisation setup.

The local profile supplies PostgreSQL, RustFS object storage and Mailpit. Named
volumes preserve data across `docker compose down`; `down --volumes` deletes them.
Changing `ROOTSET_COMPOSE_PROJECT` selects a different volume namespace. Confirm
which installation owns the volumes before interpreting an empty startup.

Installation starts with
[`0001_baseline.sql`](../../packages/database/migrations/0001_baseline.sql) and
applies the numbered forward migrations. Released migrations are immutable.
Startup serialises migration application and checks stored digests. An incompatible prelaunch
ledger must refuse startup without changing data and point to a fresh, separate
installation. Never clear its ledger or remove its original volumes to bypass
that refusal. Dynamic user-table jobs still have their own schema journals.

## Runtime boundaries and resources

Web/API/worker run as UID 10001 with dropped capabilities, read-only root
filesystems and narrow temporary/durable mounts. There is no Docker socket.
API/worker artifact spools are private durable directories under
`/var/lib/rootset/artifact-spool`; they are not unbounded heap buffers. Runtime
services and the one-shot migration service all use `ROOTSET_DATABASE_URL`.
Use one ordinary PostgreSQL database owner with permission to create schemas
and the trusted `pgcrypto` extension. It must not have superuser
or `BYPASSRLS` privileges. The local profile provisions this user automatically.
Rootset does not require separate application, identity or DDL credentials.
Organisation context and product permissions still apply to API and MCP calls.

The worker serves this installation's single organisation. One operation catalog
defines API, MCP and background-job permissions. Resource lookups validate the
requested database and table before access; there is no separate resource-grant
or access-level configuration. Preferences accept the date/time format IDs
listed by the API and shown in the UI, without older format aliases.

The existing core memory caps are PostgreSQL 4 GiB, API 1 GiB, worker 2 GiB and
web 1 GiB, totalling 8 GiB. Each combined memory/swap cap equals its memory cap,
so swap adds no headroom. Node heap limits leave native/buffer room. Record CPU,
disk, PostgreSQL settings and host contention for benchmarks. Local object/mail
services are separate test fixtures, and browser memory is measured separately.
The [performance profile](../verification/performance.md) defines the
five-million-row benchmark workload and latency/cache targets.

## External services and HTTPS

Set `ROOTSET_DATABASE_URL` to the database you want Rootset to use. With an
external PostgreSQL database, omit the local profile and its `POSTGRES_PASSWORD`
provisioning setting. Configure S3-compatible storage and SMTP for encrypted
artifacts, verification and recovery email. These services are not configured
through the UI.

| Variable                                                                                     | Purpose                                                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ROOTSET_DATABASE_URL`                                                                       | One PostgreSQL URL for migrations, API and worker.                                                |
| `ROOTSET_SECRET`                                                                             | Persistent application secret of at least 32 random characters; also used to claim initial setup. |
| `ROOTSET_ENCRYPTION_KEY`                                                                     | Persistent 32-byte encryption key encoded as 64 hexadecimal characters.                           |
| `ROOTSET_WEB_URL`, `ROOTSET_API_URL`                                                         | Public UI and API origins.                                                                        |
| `ROOTSET_S3_ENDPOINT`, `ROOTSET_S3_BUCKET`, `ROOTSET_S3_ACCESS_KEY`, `ROOTSET_S3_SECRET_KEY` | Private S3-compatible artifact storage.                                                           |
| `ROOTSET_SMTP_HOST`, `ROOTSET_EMAIL_FROM`                                                    | SMTP service and sender.                                                                          |

SMTP port defaults to 587 and TLS defaults to enabled. Set
`ROOTSET_SMTP_PORT` and `ROOTSET_SMTP_SECURE` to match your provider; set
`ROOTSET_SMTP_USER` and `ROOTSET_SMTP_PASSWORD` only if it needs authentication.
S3 region defaults to `us-east-1`; set `ROOTSET_S3_REGION` if your provider
requires a different region. Public OAuth client preregistration is optional
through `ROOTSET_OAUTH_CLIENTS`.

Retain the application secret and encryption key across restart, and include
both in protected recovery copies. Authentication and cursor signing keys are
derived internally from the application secret. There is no keyring or
installation-wide key-rotation selector. Export artifacts use this
single key without a key identifier or key-selection scheme. Passwords are hashed locally; sign-in
has fixed internal work limits and does not depend on a password breach-check
service. Restart API and worker after changing environment settings.

Set `ROOTSET_WEB_URL=https://rootset.avgeek.ltd` and
`ROOTSET_API_URL=https://rootset-api.avgeek.ltd` before passkey enrollment. The
web service receives `ROOTSET_PUBLIC_API_ORIGIN` at runtime and publishes the
API origin in rendered HTML. Browser authentication, REST, OAuth, MCP and
artifact traffic go directly to the API host. Route the two hostnames to web
port 4300 and API port 4310 respectively; the shipped Caddyfile has separate
host blocks. Remote origins require HTTPS; plain HTTP is limited to loopback.
API sessions are host-only Secure HttpOnly cookies, credentialed CORS accepts
the exact UI origin, passkeys bind to the UI host, and OAuth issuer/resource
URLs use the API host. The web service starts and serves its shell even while
the API is unavailable. Keep local SMTP/object administration interfaces off
public listeners.

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
