# Installation

Use Node.js 24, pnpm 11.5.3, Docker Compose v2 with `depends_on.required` support
and PostgreSQL 18. Build from the committed lockfile;
a failed one-shot baseline migration must prevent API/worker startup.

## Package registry

Rootset consumes `@avgeek-oss/design-system@1.2.7` from GitHub Packages through its
public package exports. Authenticate before installing:

```sh
npm login --scope=@avgeek-oss --auth-type=legacy --registry=https://npm.pkg.github.com
```

Use your GitHub username and a personal access token (classic) with
`read:packages` as the password. GitHub requires registry authentication even
for public packages. Keep the token in your user npm configuration, outside Git.

Docker builds receive an authenticated npm configuration only as a BuildKit
secret. Compose uses `$HOME/.npmrc` by default; set `ROOTSET_NPM_CONFIG_FILE` to
another protected file when needed. A build configuration must contain the
registry and an authentication token, rather than an unresolved environment
placeholder. Registry credentials are not build arguments or runtime variables.

For a direct build, pass the same secret:

```sh
docker build --secret id=npmrc,src="$HOME/.npmrc" --target web --tag rootset-web:local .
```

GitHub Actions grants `packages: read` and uses its job token for dependency
installation and the BuildKit secret. Grant Rootset access in the package's
Manage Actions access settings if the registry rejects that token.

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
Deployment readiness checks dependencies without exposing an account settings page. Do not copy a migration-owner URL into runtime settings. Keep
persistent authentication, key-hash, cursor and encryption secrets across restarts.
Test artifact encryption/readback and actual email delivery before relying on
backups or account recovery.

Password policy uses `ROOTSET_PASSWORD_BREACH_CHECK=true` by default. New
passwords need access to the padded breached-password range service; unavailable
checks reject the change with a retryable error. `ROOTSET_PASSWORD_VERIFY_CONCURRENCY`
(default 2) and `ROOTSET_PASSWORD_VERIFY_QUEUE_LIMIT` (default 16) bound expensive
password work. Synthetic offline CI/browser fixtures set breach checking to
`false` explicitly; that fixture exception is not a production recommendation.

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
