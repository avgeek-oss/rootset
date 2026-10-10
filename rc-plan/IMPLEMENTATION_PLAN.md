# Implementing the revised V1

Build and verify the current [scope](README.md). Earlier multi-organisation,
Owner/operator, grant and migration-sequence work is historical and supplies no
completion credit for the revised model.

## Work sequence

1. Consolidate the supported control schema into
   `packages/database/migrations/0001_baseline.sql`. Enforce the organisation
   singleton in SQL, verify normal migration digests and refuse an incompatible
   earlier ledger without changing its data.
2. Align identity/access with Admin, Member and Viewer. Admin manages installation
   health and deployment configuration is supplied through `.env`. Remove obsolete role/flag/grant/key models and workflows. Recheck
   live authority after demotion, member removal and credential revocation.
3. Align contracts, handlers and UI with one field `name` matching
   `/^[A-Za-z_]+$/`, length 1–64. Use it as the label and JSON row key while
   preserving stable IDs, values, query behavior and history through renames.
4. Regenerate REST/client/MCP contracts. Keep personal-key permission ceilings, workspace-owned team keys and
   OAuth PKCE/operation consent; remove resource selectors and obsolete operations.
5. Remove backup scheduling and installation overrides from the catalog and SQL.
   Remove database backup/restore and keep operation progress; remove the standalone jobs
   page and storage admission package. Configure SMTP and S3 only through `.env`.
6. Verify storage, uniqueness, concurrency, schema reconciliation,
   200-entry cell history and exports on the current empty-baseline fixture.
7. Adapt the actual Towbar/Mill primary/secondary navigation, account menu, compact
   controls, widget cards and responsive drawer. Separate account, team, database
   and table settings; keep the bounded DOM spreadsheet. Verify real navigation,
   resource links, menus, editing and light/dark and narrow/wide states.
8. Review real setup, People, settings and spreadsheet flows. Run the full-scale
   performance profile and record unresolved checks before release review.

## Verification and evidence

Use ordinary package checks, `pnpm contracts:generate`, `pnpm verify`, affected
native integration checks and browser tests. Use synthetic isolated fixtures and
keep the approved combined four-service memory caps at 8 GiB with no added swap.
The [checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md) defines remaining
functional, security, recovery and performance evidence.

A useful result records the candidate, command/scenario, environment, outcome and
limitation. Retain logs and relevant screenshots; keep secret
values out of reports. There is no requirement to manufacture a new authority
packet for every source read or ordinary test.

Prior candidate evidence stays under `verification/` as historical records.
Do not relabel it as proof of the new baseline or carry old pass marks into the
new checklist. Update tools and evidence registries to the revised requirements.

## Review

Review behavior and generated drift together. A source change is not proof of a
working installed flow; an accepted job is not proof of completed effects.
Fresh installation and recovery need genuine rehearsals. V1 does not promise an
upgrade from the retired prelaunch migration sequence.

Record implementation, verification, publication and production status
separately. Acceptance remains false until the revised checklist has current
results and unresolved failures are addressed.
