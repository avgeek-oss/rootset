# Deploy Rootset with Towbar

These manifests deploy the public Rootset **0.1.0** API, worker and UI images to the Platform Services server (`13.206.149.158`, Linux ARM64). All three images are pinned to the immutable multi-platform digests in the [release image manifest](https://github.com/avgeek-oss/rootset/releases/download/v0.1.0/rootset-images.json). There is no source build. `autoDeploy: false` keeps each deployment manual.

The application is served at `https://rootset.avgeek.ltd`; authentication, REST, MCP and downloads use `https://rootset-api.avgeek.ltd`. The documentation site is separate, at `https://www.rootset.app`. The worker and PostgreSQL have no public domains. All four workloads share the private `rootset` Docker network on one server.

## Before deployment

Use Towbar **2.0.36 or later**. Register and prepare the target server in Towbar, connect this repository, map `production` to `main`, and sync. Configure Towbar's Cloudflare DNS integration for `avgeek.ltd` before deploying the two public services.

The limits match the published Compose installation: PostgreSQL 4 GiB, API 1 GiB, worker 2 GiB and UI 1 GiB. Check available capacity alongside existing services before deployment; allow additional host headroom. Named volumes preserve PostgreSQL data and the API/worker artifact spools across redeployments.

`rootset-postgres` is a managed PostgreSQL 18 Datastore declared in `.towbar/datastores/rootset-postgres.datastore.yml`. Its image is pinned to an immutable digest, with the PostgreSQL 18 data volume mounted at `/var/lib/postgresql`. Towbar manages its deployment, health checks and persistent volume. The API and worker continue to connect to `rootset-postgres:5432` on the private network.

Use PostgreSQL-native backups and restores for recovery. Towbar’s current datastore restore flow does not replay this repository’s initialization script, so it does not recreate Rootset’s ordinary database-owner role and ownership setup. No automatic backup schedule is configured by these manifests.

The bundled PostgreSQL datastore is for a **fresh installation**. Save these values in its production runtime secrets:

| Key                 | Value                                                                            |
| ------------------- | -------------------------------------------------------------------------------- |
| `POSTGRES_USER`     | `postgres`                                                                       |
| `POSTGRES_DB`       | `rootset`                                                                        |
| `POSTGRES_PASSWORD` | A generated URL-safe password, for example the output of `openssl rand -hex 32`. |

The repository-backed initialization script creates an ordinary `rootset` database owner without superuser or `BYPASSRLS`, and removes password login for the bootstrap `postgres` role. It runs only on an empty PostgreSQL data volume. Do not reuse a prelaunch database or delete an existing volume to force initialization. With external PostgreSQL, remove the PostgreSQL datastore manifest before syncing and supply an ordinary database-owner URL with permission to create schemas and `pgcrypto`.

## API and worker runtime values

Save the following production runtime values **on both services**, using the same database URL, origins, application secret, encryption key and storage settings. Towbar does not copy secrets between services.

| Key                      | Value                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `ROOTSET_DATABASE_URL`   | `postgres://rootset:<POSTGRES_PASSWORD>@rootset-postgres:5432/rootset`, or your external PostgreSQL URL. |
| `ROOTSET_API_URL`        | `https://rootset-api.avgeek.ltd`                                                                         |
| `ROOTSET_WEB_URL`        | `https://rootset.avgeek.ltd`                                                                             |
| `ROOTSET_SECRET`         | A persistent secret of at least 32 characters. Generate with `openssl rand -hex 32`.                     |
| `ROOTSET_ENCRYPTION_KEY` | A separately generated 64-character hex key. Generate with `openssl rand -hex 32`.                       |
| `ROOTSET_S3_ENDPOINT`    | Your S3-compatible storage endpoint.                                                                     |
| `ROOTSET_S3_BUCKET`      | An existing private bucket for export artifacts.                                                         |
| `ROOTSET_S3_ACCESS_KEY`  | Its object-access credential.                                                                            |
| `ROOTSET_S3_SECRET_KEY`  | Its matching secret credential.                                                                          |
| `ROOTSET_SMTP_HOST`      | Your SMTP hostname.                                                                                      |
| `ROOTSET_EMAIL_FROM`     | Your verified sender email address.                                                                      |

Save `ROOTSET_DATABASE_URL` separately in the API's **pre-deploy secrets** as well; the hook runs `node dist/migrate.mjs` from the selected API image before startup. Keep the hook URL identical to the runtime URL.

If required by your providers, also set `ROOTSET_S3_REGION` (default `us-east-1`), `ROOTSET_SMTP_PORT` (default `587`), `ROOTSET_SMTP_SECURE` (default `true`), `ROOTSET_SMTP_USER` and `ROOTSET_SMTP_PASSWORD` in both services' runtime secrets. `ROOTSET_SMTP_SECURE=false` uses SMTP/STARTTLS, commonly on port 587; `true` uses implicit TLS. Optional provider values are not listed as required manifest secrets. Configure their actual TLS mode before deployment.

On the UI, save only `ROOTSET_PUBLIC_API_ORIGIN=https://rootset-api.avgeek.ltd` in production runtime secrets. Browser requests go directly to this public API; the UI does not proxy them.

## Deploy in order

1. Deploy PostgreSQL and wait for readiness, or verify your external database connection.
2. Deploy the API. Its migration hook must succeed and `/health/ready` must pass.
3. Deploy the worker. Its command health check verifies its own fresh database heartbeat; a running process alone is insufficient.
4. Deploy the UI and check both HTTPS origins.
5. Open the UI, privately supply `ROOTSET_SECRET` to claim the installation, verify your email and create the first administrator. Verify sign-in, a saved cell edit, and a completed export request with a download.

Towbar does not order independent workloads. For upgrades, select one published release and update all three image digests together, then deploy API, worker and UI in order. The API hook migrates before replacement; image rollback does not undo database migrations. Keep the persistent secret and encryption key stable.

The worker has no HTTP listener. Its manifest port is required by Towbar's Service schema and is not an API endpoint; no public domain is configured. The command check uses `dist/worker-health.mjs` from the published image.

These files prepare deployment; they do not provision external storage, send email, claim the installation, or deploy any workload by themselves.
