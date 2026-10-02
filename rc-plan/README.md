# Rootset v1 plan

Baseline date: 2026-10-02. Status: accepted product and architecture direction; implementation and verification are pending.

## Reading order

1. [Account architecture](ACCOUNT_ARCHITECTURE.md).
2. [MDM database architecture](MDM_DATABASE_ARCHITECTURE.md).
3. [API and MCP architecture](API_AND_MCP_ARCHITECTURE.md).
4. [Stack architecture](STACK_ARCHITECTURE.md).
5. [Implementation plan](IMPLEMENTATION_PLAN.md).
6. [Implementation and verification checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md).

## Decision status

"Accepted" means the user approved the product requirement or architectural direction. "Engineering default" means this plan specifies an implementation value so work can proceed. A changed default needs a reviewed explanation and updates to affected contracts and checks. "Candidate" means a library or technique needs an implementation spike before adoption. "Deferred" means the item is outside v1 and is not a missing implementation check.

| Decision                 | Status              | Contract                                                                                                          |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Name, domain, repository | Accepted            | Rootset, rootset.fyi, private avgeek-inc/rootset.                                                                 |
| Primary storage          | Accepted            | PostgreSQL for metadata, rows, and atomic history; ClickHouse deferred.                                           |
| Table representation     | Accepted            | Physical PostgreSQL table per logical table, stable storage identifiers.                                          |
| Namespace                | Accepted direction  | Managed PostgreSQL schema per logical database.                                                                   |
| Field list               | Accepted            | Eight types, bounded text and optional inclusive bounds on integer, float, date, and date-time.                   |
| Row capacity             | Accepted            | 5,000,000 live rows per table.                                                                                    |
| Row size                 | Engineering default | 65,536 bytes of canonical user-cell values; system metadata and history are measured separately.                  |
| Field count              | Engineering default | 200 active fields per table.                                                                                      |
| JSON depth               | Engineering default | 32 nested object/array levels.                                                                                    |
| Date/time                | Accepted            | UTC API and storage; localise date-time only; time-only display remains UTC.                                      |
| Uniqueness               | Accepted direction  | Optional single/composite scalar rules; JSON uniqueness deferred. Case-sensitive text and distinct nulls.         |
| Pagination               | Accepted            | REST default 5,000, MCP default 200, UI fetch window 200; requested size 1-25,000.                                |
| Payload budgets          | Engineering default | 8 MiB public/browser JSON request and response budget; 1 MiB MCP result budget.                                   |
| Mutations                | Engineering default | At most 1,000 rows per synchronous batch, within the request budget.                                              |
| Grid                     | Candidate           | Glide Data Grid; adoption depends on the grid spike and accessibility checks.                                     |
| Account structure        | Accepted direction  | Organisation-scoped model; initial self-hosted onboarding creates one organisation.                               |
| Roles                    | Accepted direction  | Owner, Admin, Editor, Viewer; inherited database/table grants.                                                    |
| API contract             | Accepted direction  | OpenAPI 3.1.2, JSON Schema 2020-12, shared operation definitions.                                                 |
| OAuth                    | Accepted direction  | PKCE, resource-bound grants, discoverable remote MCP, short access tokens, rotating refresh tokens.               |
| Backups                  | Accepted            | Database-wide consistent snapshot, cron/timezone configuration, retention, restore validation.                    |
| Reference stack          | Engineering default | Node.js 24 LTS, TypeScript, Hono, PostgreSQL 18, Drizzle, Next.js/React, HeroUI, Tailwind, S3-compatible storage. |

## Scope

V1 includes setup, organisation/account maintenance, authentication, scoped credentials, logical databases, dynamic typed tables, row CRUD, structured queries, spreadsheet editing, cell history, imports/exports, scheduled backups and restores, jobs, observability, public REST, and remote MCP.

Rich source-evidence collection, editorial approvals, published dataset releases, relationship field types, formulas, attachments, arbitrary SQL, decimal fields, ClickHouse, SSO, SCIM, billing, and public SaaS tenancy are deferred. The data model must avoid closing off future work, but these features are not needed for v1 sign-off.

## Reference discipline

Towbar was inspected in the local checkout at commit `bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2`, branch `fix/continuous-page-refresh`. These documents reference source behavior, not a claim about deployed Towbar behavior. Link references use that commit so later changes do not silently change this baseline.

Implementation must record the exact versions it installs and test them. Library documentation, a successful spike, and the architectural baseline are separate evidence from full implementation sign-off.

## Changing the plan

A change records the affected requirement, reason, migration or compatibility impact, and replacement verification gate. Update all affected documents in the same change. Do not silently reduce the row limit, remove a transport, or turn an unverified check into a deferred feature.

The [verification checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md) is the sign-off contract. It starts unchecked. Evidence must identify the tested commit, image, environment, method, result, and reviewer.
