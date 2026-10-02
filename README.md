# Rootset

Rootset is simple MDM structured storage: organisations own logical databases,
each database contains typed tables, and people or API/MCP clients maintain the
same records with validation and cell history. The project domain is
`rootset.fyi`; this repository does not configure production hosting or DNS.

The v1 implementation includes PostgreSQL tables, bounded queries and spreadsheet
windows, row revisions, uniqueness rules, durable jobs, encrypted artifacts,
account administration, API keys and OAuth-protected MCP. The architecture and
[205-gate verification checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md)
remain the acceptance contract. Features and verification are reviewed separately;
an installed development instance does not establish release readiness.

## Run a local installation

Use Node.js 24, pnpm 11.5.3, Docker and Docker Compose v2. Installation uses public
dependencies and does not require Towbar registry credentials.

```sh
pnpm install --frozen-lockfile
pnpm setup:env
docker compose --profile local up --build -d
docker compose --profile local ps
```

`setup:env` creates `.env` once with independent random credentials and persistent
keys; it refuses to overwrite an existing file. Protect a recovery copy before
storing data. Visit `http://localhost:4300` and claim setup with the bootstrap
secret from your protected `.env`. Local email appears at
`http://localhost:8025`. Mailpit captures development email; configure a real
SMTP service for an operational installation.

The local profile creates non-root PostgreSQL 18, RustFS artifact storage and
Mailpit containers. Web, API and worker run as UID 10001. PostgreSQL owner
credentials are passed only to the one-shot migration service; runtime services
receive separate application, identity and DDL role credentials. Rootset data and
objects use named volumes scoped to the Compose project.

Read the [installation runbook](docs/operations/installation.md) for external
PostgreSQL/S3/SMTP, HTTPS routing, resource budgets and startup diagnosis.

## Develop and verify

```sh
pnpm contracts:generate
pnpm verify
pnpm test:integration
```

The integration command requires an isolated PostgreSQL 18 fixture with the four
documented test URLs and finalized migrations. It fails when prerequisites are
missing. Configure test SMTP and S3 for outbox/job/artifact scenarios; do not use
customer data. The [verification guide](docs/verification/README.md) describes
evidence collection and the acceptance profile. Generated OpenAPI 3.1.2,
TypeScript client and MCP inventory live in `packages/contracts/generated`.

`pnpm build` emits Next.js standalone output and bundled Node.js production entry
points under `dist`; Docker copies those artifacts into non-root images. Candidate
CI checks generated drift, formatting, lint, strict types, tests, production builds,
real-service integration, dependency vulnerabilities and image construction.

## Architecture and operations

| Document                                                                   | Covers                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Account architecture](rc-plan/ACCOUNT_ARCHITECTURE.md)                    | Organisation membership, roles, keys, factors, preferences and recovery.    |
| [Database architecture](rc-plan/MDM_DATABASE_ARCHITECTURE.md)              | Typed PostgreSQL tables, limits, history, uniqueness, querying and backups. |
| [API and MCP architecture](rc-plan/API_AND_MCP_ARCHITECTURE.md)            | Shared operations, OpenAPI, OAuth, tools and transport contracts.           |
| [Stack architecture](rc-plan/STACK_ARCHITECTURE.md)                        | Runtime boundaries, storage, frontend, packaging and observability.         |
| [Implementation plan](rc-plan/IMPLEMENTATION_PLAN.md)                      | Implementation work packages and evidence requirements.                     |
| [Verification checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md) | Complete v1 implementation and verification sign-off.                       |
| [Operations runbooks](docs/operations/README.md)                           | Installation, upgrades, recovery, key rotation and failures.                |

This initial repository is private. Public source licensing, image publication,
production deployment and production health are separate release records. Adapted
Towbar material retains its applicable licence and source notices.
