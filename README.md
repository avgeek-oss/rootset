<img src="design/brand/rootset-logo.png" alt="Rootset logo" width="96" height="96" />

# Rootset

Rootset is self-hosted structured storage for one organisation. Create logical
databases and typed tables, edit records in a spreadsheet, and use the same data
through REST or OAuth-protected MCP. PostgreSQL stores values, revisions and
the latest 200 changes per existing cell. Deleting a row, field, table, or database removes its cell changelogs. The project domain is `rootset.fyi`.

V1 uses Admin, Member and Viewer roles. Admins manage people, schema and recovery with deployment readiness checked separately.
SMTP and S3-compatible storage use `.env`. Create rows through REST/MCP; the UI edits existing rows. Database backup and restore use your PostgreSQL provider’s tooling.
There is no standalone Background Jobs page, storage admission policy or search-index management. Table filtering and unique rules are supported without search-index setup.
Personal API keys inherit the person's current role; OAuth connections add
approved operations to that current authority. Field definitions have one `name`
property, used both as the UI label and the JSON row key. Required is the only
nullability setting: optional fields allow null and default to null unless a
literal default is supplied. The field editor requires a valid non-null literal
default for required fields; new rows must receive a valid value or use that
default.

Fields support text, URI, URL, image, integer, float, boolean, date, time, date-time and JSON. URI, URL and image values are stored as plain strings without address-format validation or custom constraints. Image cells display a compact thumbnail and edit the stored URL inline; unavailable images show a muted image icon.

The [current V1 plan](rc-plan/README.md) and its
[verification checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md) define
the revised scope. Implementation and verification are being aligned with it.
Earlier candidate receipts and the former checklist are historical; acceptance
remains false until the current checks have genuine evidence.

## Install locally

Use Node.js 24, pnpm 11.5.3, Docker and Docker Compose v2. The published
`@avgeek-oss/design-system` package is hosted on GitHub Packages. Authenticate
with a GitHub token that has `read:packages`; another Avgeek checkout is not needed.
See [registry and build setup](docs/operations/installation.md#package-registry).

```sh
pnpm install --frozen-lockfile
pnpm setup:env
docker compose --profile local up --build -d
docker compose --profile local ps
```

`setup:env` creates the protected `.env` once. Keep it outside Git and retain an
encrypted recovery copy. Open `http://localhost:4300`, claim setup with the
value of `ROOTSET_SECRET`, and establish the first Admin and the installation's single
organisation. Local email is captured at `http://localhost:8025`.

The API and worker use one `ROOTSET_DATABASE_URL`, one `ROOTSET_SECRET` and one
`ROOTSET_ENCRYPTION_KEY`. The database URL also applies the installation baseline.
For external PostgreSQL, use an ordinary database owner without superuser or
BYPASSRLS access. Retain the secret and encryption key across restart and backup.
See the [environment reference](docs/operations/installation.md#external-services-and-https)
for S3 and SMTP settings.

The browser calls `http://localhost:4310` directly for authentication, REST,
OAuth, MCP and artifact transfer. For HTTPS routing, configure
`ROOTSET_WEB_URL=https://rootset.avgeek.ltd` and
`ROOTSET_API_URL=https://rootset-api.avgeek.ltd`. The API owns the host-only
browser session cookie and accepts credentialed requests from the exact UI
origin.

V1 has one fresh-install schema, [0001_baseline.sql](packages/database/migrations/0001_baseline.sql).
It can be regenerated before V1 release. An earlier prelaunch database is not an
upgrade target: startup must refuse its incompatible ledger without changing data.
Preserve that installation and use an empty, separate installation for the new
baseline. Do not clear its ledger or delete its volumes to bypass the refusal.

See [installation](docs/operations/installation.md) for external PostgreSQL,
S3-compatible storage, SMTP and HTTPS, and [recovery](docs/operations/upgrade-and-recovery.md)
for protecting and restoring an installation.

## Develop and verify

```sh
pnpm contracts:generate
pnpm verify
pnpm test:integration
```

Use isolated PostgreSQL fixtures and synthetic data for integration checks.
Configure test object storage and SMTP where the scenario needs them. Missing
prerequisites must fail visibly. Generated OpenAPI, client and MCP contracts live
in `packages/contracts/generated`; regenerate them when an operation changes.

The performance target remains a five-million-row table under combined
PostgreSQL/API/worker/web memory caps of 8 GiB, with no additional swap. Ordinary
checks, real recovery rehearsals and browser evidence establish different facts.
Record remaining full-scale work in the [verification guide](docs/verification/README.md).

## Documentation

- [Accounts and roles](rc-plan/ACCOUNT_ARCHITECTURE.md)
- [Tables, fields and history](rc-plan/MDM_DATABASE_ARCHITECTURE.md)
- [REST and MCP](rc-plan/API_AND_MCP_ARCHITECTURE.md)
- [Runtime and frontend](rc-plan/STACK_ARCHITECTURE.md)
- [Implementation plan](rc-plan/IMPLEMENTATION_PLAN.md)
- [Operations](docs/operations/README.md)
- [Contributing](CONTRIBUTING.md) and [security reports](SECURITY.md)

Source/image publication, production deployment and production health are
separate release decisions. Adapted material retains its applicable licence and
source notices.

The table UI loads 200 rows initially and requests more as you scroll. It keeps at most 1,000 loaded rows (and a 32 MiB active window), fetching earlier batches again when you scroll back. React Data Grid renders only visible rows. Resource pages use `/databases/:id` and `/databases/:id/tables/:id`; filters and sorts stay part of the data query. Invalid or failed cell saves show a toast and restore the committed value.

Press Command-Z (Control-Z on Windows/Linux) while the grid is focused to undo
saved cell edits, null changes and pastes, one action at a time. The current table
session retains up to 200 undo actions; leaving the table or reloading clears them.
A paste is undone atomically. Undo uses normal API revision checks and records
the restored values in cell history. A toast confirms success or explains a
failure. Text inputs retain their normal unsaved-text undo. Redo and undoing
deletions or schema changes are not supported.
