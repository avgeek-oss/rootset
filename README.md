# Rootset

Rootset is a simple MDM structured-storage application. Organisations create databases containing typed tables, edit data through a spreadsheet interface, and use the same operations through a public API and OAuth-authenticated MCP tools.

Project domain: [rootset.fyi](https://rootset.fyi). Repository: [avgeek-inc/rootset](https://github.com/avgeek-inc/rootset).

## Current state

This repository contains the v1 architecture, implementation plan, and verification contract. Application implementation has not started. The presence of these documents does not establish working features, deployment, performance, or release readiness.

The product direction and reviewed architectural proposals were accepted on 2026-10-02. Engineering defaults are recorded explicitly in the plan and can change through a reviewed decision with corresponding checklist updates.

## V1 decisions

- PostgreSQL stores management metadata, typed user tables, and cell change history. Each user-created table has a physical PostgreSQL table.
- Databases are logical containers. A logical database has a managed PostgreSQL schema; it does not provision a new server.
- Field types are text, integer, float, boolean, date, time, date-time, and JSON.
- Tables support up to 5,000,000 live rows, bounded row sizes, optional scalar uniqueness rules, and structured column queries.
- Date-time values are stored and accepted in UTC, with user timezone preferences applied in the UI. Time-only cells display UTC. Calendar dates do not undergo timezone conversion.
- Every committed cell change has an atomic history entry. Internal row IDs are alphanumeric and hidden from the grid.
- Public REST queries default to 5,000 rows; MCP queries default to 200. Page sizes are 1 through 25,000, subject to byte and execution limits.
- The spreadsheet loads bounded windows and renders visible cells. Scale claims require measured evidence against the release candidate.
- Accounts, authentication screens, emails, 2FA, passkeys, preferences, and API-key behavior use Towbar as the implementation reference, with Rootset-specific permissions.
- Database-wide backups use consistent snapshots and include restore verification.

## Plan documents

Start with the [plan index](rc-plan/README.md).

| Document                                                                                      | Purpose                                                                                                   |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Account architecture](rc-plan/ACCOUNT_ARCHITECTURE.md)                                       | Organisations, memberships, roles, authentication, API keys, preferences, and account maintenance.        |
| [MDM database architecture](rc-plan/MDM_DATABASE_ARCHITECTURE.md)                             | Physical storage, field semantics, uniqueness, history, queries, limits, backups, and schema changes.     |
| [API and MCP architecture](rc-plan/API_AND_MCP_ARCHITECTURE.md)                               | Authentication, public and browser APIs, MCP tools, operation inventory, OpenAPI, and protocol contracts. |
| [Stack architecture](rc-plan/STACK_ARCHITECTURE.md)                                           | Backend, PostgreSQL, workers, storage, UI, grid, packaging, and deployment.                               |
| [Implementation plan](rc-plan/IMPLEMENTATION_PLAN.md)                                         | Work packages, dependencies, deliverables, and acceptance evidence.                                       |
| [Implementation and verification checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md) | Complete v1 sign-off gates, failure scenarios, performance targets, and release evidence.                 |

The repository starts private. Public distribution, project licensing, and a hosted offering remain separate release decisions. No DNS or hosting configuration is established by this plan.
