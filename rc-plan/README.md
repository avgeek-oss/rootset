# Rootset V1 plan

Current scope was revised on 5 October 2026. These requirements supersede the
former account architecture, migration sequence and checklist. Implementation
and verification are in progress; acceptance remains false.

## Product

One installation contains one organisation, enforced by a SQL singleton
constraint. People use Admin, Member or Viewer membership roles. Admin includes
installation management. Personal keys inherit the person's live role; OAuth
connections retain PKCE and operation consent without resource selections.

Logical databases contain typed PostgreSQL tables with row revisions, cell
history, structured queries and a spreadsheet. Imports/exports, internal processing,
manual encrypted backups and verified restores remain in V1. REST, MCP and the browser
share their domain operations.

Each field has one `name` property, 1–64 ASCII letters or underscores matching
`/^[A-Za-z_]+$/`. The name is both its UI label and JSON row key. A rename keeps
the internal field ID and prior history.

V1 excludes separate Owner/installation-operator authority, organisation
switching or deletion, ownership transfer, descriptions, organisation quotas,
active-member/deleted-account flags, organisation-wide audit, resource grants and
team keys. Personal keys have no selected-operation or resource whitelist.
Backup schedules, storage admission policies, editable installation tuning,
SMTP/object storage forms, test-email delivery and a standalone Background Jobs
screen are also excluded. Provider configuration comes only from `.env`.

## Retained limits

| Contract                      | V1 value                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Live rows per table           | 5,000,000                                                                                |
| Active fields per table       | 200                                                                                      |
| Types                         | Text, integer, float, boolean, date, UTC time, UTC date-time, JSON                       |
| Canonical user-cell row bytes | 65,536                                                                                   |
| JSON nesting                  | 32 object/array levels                                                                   |
| Synchronous mutation batch    | At most 1,000 rows within the request byte cap                                           |
| Query rows                    | Requested size 1–25,000; REST default 5,000, MCP/UI default 200                          |
| JSON payload/result caps      | REST/browser 8 MiB; MCP result 1 MiB                                                     |
| Interactive query budget      | 10 seconds plus bounded transport cleanup                                                |
| Test runtime memory           | PostgreSQL 4 GiB, API 1 GiB, worker 2 GiB, web 1 GiB; 8 GiB combined, no additional swap |

UTC storage/API behavior, uniqueness, transactional cell history, five-million-row
performance and backup/recovery requirements remain unchanged. Formulas,
attachments, relationships, arbitrary SQL, ClickHouse, SSO/SCIM, billing and public
SaaS tenancy remain outside V1.

## Fresh installation

`packages/database/migrations/0001_baseline.sql` is the only migration. It creates
the current schema directly and can be edited/regenerated before V1 release.
Startup verifies the normal migration digest and refuses an incompatible earlier
prelaunch ledger. No upgrade from the retired sequence is promised. Preserve old
data and use a separate empty installation for the revised baseline.

## Read the plan

1. [Accounts](ACCOUNT_ARCHITECTURE.md)
2. [Database and field contract](MDM_DATABASE_ARCHITECTURE.md)
3. [API and MCP](API_AND_MCP_ARCHITECTURE.md)
4. [Runtime and UI](STACK_ARCHITECTURE.md)
5. [Implementation sequence](IMPLEMENTATION_PLAN.md)
6. [Verification checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md)

The local Towbar and Mill repositories inform the shared shell, authentication,
public dependency and practical runbook conventions. Rootset's role and storage
contracts are its own. Their deployed state is not Rootset evidence.
