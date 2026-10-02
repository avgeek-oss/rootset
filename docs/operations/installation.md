# Installation

Use Docker Compose v2 with `depends_on.required` support, Node.js 24 and pnpm
11.5.3. The pinned PostgreSQL image is major 18. Build with the committed lockfile;
a migration-image failure must stop API/worker startup.

## Local services

```sh
pnpm install --frozen-lockfile
pnpm setup:env
docker compose --profile local up --build -d
docker compose --profile local ps
```

`.env` is created mode 0600 without overwrite. Keep it outside version control.
The default URL is `http://localhost:4300`; HTTP is accepted only on loopback.
Claim initial setup in the browser with `ROOTSET_BOOTSTRAP_SECRET`. Setup requires
email verification; Mailpit at `http://localhost:8025` captures local messages.

The local profile provides PostgreSQL, RustFS and Mailpit. Named volumes retain
PostgreSQL and object state across `docker compose down`; `down --volumes` removes
them and is inappropriate for an installation whose data must be kept. Changing
`ROOTSET_COMPOSE_PROJECT` changes the volume namespace. Do not mistake a new empty
namespace for lost original data.

Web/API/worker run as UID 10001 with dropped capabilities, read-only root
filesystems, bounded temporary directories and no privileged Docker socket.
PostgreSQL runs as its image's `postgres` user; RustFS and Mailpit run as UID 10001.
API/worker cannot receive `ROOTSET_MIGRATION_DATABASE_URL` through the
explicit Compose environment map. The migration service uses the owner URL once.

The approved four-service memory ceiling is 8 GiB: PostgreSQL 4 GiB, API 1 GiB,
worker 2 GiB and web 1 GiB. Compose enforces those cgroup limits and sets each
combined memory/swap limit to the same value, so swap cannot add hidden headroom.
Node heap limits
leave native/pool/buffer headroom: API 768 MiB, worker 1536 MiB and web 768 MiB.
CPU limits default to PostgreSQL 4, API 2, worker 2 and web 1; the services still
share the host's physical cores. An operator can set `ROOTSET_POSTGRES_CPUS` to a
positive CPU limit that does not exceed Docker's available CPU count. The other
service CPU limits require at least two CPUs on the Docker host. The CI
installation smoke explicitly limits PostgreSQL to `min(4, Docker CPU count)` on
its runner and records that functional-test override. The approved performance
profile keeps PostgreSQL at four CPUs and the combined 8 GiB memory ceiling.
Measure actual memory/CPU usage and latency on the declared host, including browser memory separately. S3 and SMTP are prerequisite services
with separate operating budgets. The local prerequisites are capped separately:
RustFS 1 GiB/one CPU and Mailpit 128 MiB/half a CPU, with no additional swap.
These prerequisite limits are outside the four-service allocation. Reserve durable disk and monitor
WAL/history/artifact growth.

Each API/worker runtime has lazy PostgreSQL pools with maxima of ten application
work connections, five DDL connections, ten identity connections and two separate
admission connections: 27 per process, or 54 across one API and one worker. The
admission pool keeps bounded admission decisions independent from a busy work
pool; it does not increase concurrent request or work quotas. The shipped local
PostgreSQL default is 100 connections, leaving room for the reporter, operator
and PostgreSQL maintenance. External installations must budget all replicas and
operator connections explicitly. Monitor actual active, idle and waiting pool
counts and database connection pressure within the same four-GiB PostgreSQL cap.

The migration job has a 1 GiB limit and 768 MiB Node heap. Stop web/API/worker before
an upgrade so migration does not add another active process to the eight-GiB
runtime allocation. During fresh installation it completes before those services
start. A normal service restart preserves the existing migration state.

API and worker each mount a separate disk-backed `artifact-spool` named volume
at `/var/lib/rootset/artifact-spool`, owned by UID 10001 with mode 0700.
`ROOTSET_ARTIFACT_TEMP_DIR` points artifact validation there. Allocate room for
the largest ciphertext artifact that each process can validate concurrently,
plus the one-GiB free-space reserve. These volumes use durable disk, not the
64-MiB `/tmp` tmpfs or the Node heap. Verified read-back uses ciphertext files
with mode 0600 and removes them after validation; API validation and worker
maintenance also remove their own abandoned validation directories after 48 hours.
Monitor both volume
capacity and filesystem growth. Separate volumes prevent one process's cleanup
from touching another process's active validation files.

The PostgreSQL health script measures free space on its actual data, WAL and
tablespace volumes after migrations. Its database role is the no-login
`rootset_capacity_reporter`, which can execute only the storage-path, admission
checkpoint and capacity-report functions. Measuring after the checkpoint preserves
headroom reserved by concurrent writes. The script is mounted read-only in the
PostgreSQL container; API and worker have no filesystem access to PostgreSQL data.

## External dependencies

Omit `--profile local` when PostgreSQL, S3-compatible storage and SMTP already
exist. Configure all role URLs, artifact credentials, sender and SMTP settings
in the protected `.env`. Prepare roles with the same names and privilege
boundaries as `infra/postgres-init.sh`; the migration role owns the database and
can create managed schemas/extensions. The DDL login must be NOSUPERUSER and
NOBYPASSRLS. Completed migrations bind its managed DDL authority to a separate
no-login owner without superuser or RLS-bypass privileges. Runtime DDL must not
inherit the installation's privileged migration owner. Do not start runtime
services before all ownership-hardening migrations complete.
App and identity logins have neither database-owner nor bypass privileges.
Use encrypted connections and service-network controls appropriate to that
deployment. Do not use a PostgreSQL owner URL for runtime roles.

Configure the external PostgreSQL host's capacity reporter when enabling a
minimum-free-space policy. Create `rootset_capacity_reporter` as NOLOGIN,
NOSUPERUSER, NOBYPASSRLS before migrations. A separate NOSUPERUSER, NOBYPASSRLS
login can inherit only that reporter role. Keep its connection string in the
database host's protected `ROOTSET_CAPACITY_DATABASE_URL` environment and run
the shipped `dist/capacity-reporter.mjs` with Node24 on that host, or adapt
`infra/postgres-capacity-health.sh` to its local database login. Schedule at least
every ten seconds while writes are active. The Node reporter checks the local
PostgreSQL version and server-start marker against the connected server before
measuring its paths; an API host's own free disk cannot satisfy that check. Missing
or stale reports cause configured free-space admission to fail explicitly.

Create the artifact bucket with provider tooling and grant the Rootset credential
only the required bucket/object permissions. Existing services do not run the
local bucket-initialization job. Keep the endpoint separate from a database's
backup policy. Test writes, encrypted read-back and isolated restore validation
before trusting a successful backup state. Maintain durable object storage;
an export/import upload is not a recovery copy of PostgreSQL control state.

```sh
docker compose up --build -d
docker compose ps
```

The web service receives `ROOTSET_API_INTERNAL_URL=http://api:4310` at runtime.
Its server-side routing validates and uses that fixed upstream for API, OAuth
and MCP requests. An alternative service name requires updating this protected
runtime setting. Frontend runtime configuration contains no secrets.

## HTTPS and same-origin routing

Set `ROOTSET_BASE_URL` to the final HTTPS origin before setup/passkey enrollment.
Use `infra/Caddyfile` with `ROOTSET_HOST_NAME` and `ROOTSET_WEB_UPSTREAM`, or an
equivalent reverse proxy, forwarding to web port 4300. Web routes API, OAuth
discovery, authentication and `/mcp` to the API service. Keep browser cookies,
OAuth resource identifiers and passkey origins on that same configured origin.
Changing it later affects existing passkey bindings and OAuth clients.

Sorted GET cursors can produce URLs above 80 KiB when a permitted text value is
wide. API and Next use a bounded 192-KiB HTTP header/request-line budget; the
shipped Caddyfile sets `max_header_size 192KiB` through its
[server options](https://caddyserver.com/docs/caddyfile/options#max_header_size).
Keep that budget through any outer proxy as well. For Nginx, a single request
line must [fit one buffer](https://nginx.org/en/docs/http/ngx_http_core_module.html#large_client_header_buffers): `large_client_header_buffers 4 192k` provides bounded
buffers large enough for this case. Do not replace the ordinary 8-MiB JSON body
limit with a larger body allowance to accommodate a long URL. Verify a wide
sorted cursor through the complete deployed proxy/web/API path. Ordinary input
bodies have a ten-second receive deadline. The independently authenticated raw
artifact upload path streams up to 128 MiB and retains its own byte/deadline
checks; JSON limits do not cap a legitimate raw upload.

Keep PostgreSQL, SMTP and S3 administration endpoints off the public listener.
The example Compose binds web and local mail UI to loopback. A remote proxy may
join the Compose network rather than publish the backend API directly.

## Startup checks

```sh
docker compose --profile local logs --tail 100 migrate
docker compose --profile local logs --tail 100 api worker
curl --fail http://localhost:4300/v1/setup
docker compose exec api node -e "fetch('http://127.0.0.1:4310/health/ready').then(async r=>{console.log(await r.text());process.exitCode=r.ok?0:1})"
docker compose exec worker node dist/worker-health.mjs
```

The API liveness endpoint is `/health/live`; readiness is `/health/ready` on the
internal API listener. Worker health checks its own persisted heartbeat ID,
ready state and freshness; a different healthy worker cannot satisfy it.
Installation status exposes redacted dependency health to authorized operators.
A delivery outage can degrade email without invalidating authorized row reads.

The PostgreSQL health check verifies connection readiness and, after migrations,
reports storage capacity. Migration completion and application behavior remain
separate checks. Diagnose
bootstrap, permission, migration, bucket and SMTP failures with redacted error
codes; do not paste full Compose configuration or `.env` in an issue.

## Repository installation verification

After building the runtime and web images, run the CI installation helper against
those exact tags:

```sh
ROOTSET_SMOKE_RUNTIME_IMAGE=rootset-runtime:local ROOTSET_SMOKE_WEB_IMAGE=rootset-web:local node .github/scripts/verify-installation.mjs
```

It creates a unique Compose project, independent random keys and credentials,
new volumes and unused loopback ports. It verifies shipped non-root/read-only
containers, restricted runtime roles, absent owner credentials, own-worker
identity health, JavaScript delivery, email-verified setup, operator binding and
audit, and restart with preserved control state. The redacted report is
`verification/ci/installation.json`; its generated environment stays protected
and excluded from evidence upload. CI uploads only the explicitly selected
redacted report/manifest files, rather than the entire verification directory.
It removes only its own disposable project
and volumes at the end. Set `ROOTSET_SMOKE_KEEP=1` to preserve that synthetic
fixture for local inspection. This smoke test does not establish complete typed
data, upgrade, recovery or performance acceptance.
