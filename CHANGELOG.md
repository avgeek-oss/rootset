# Changelog

## Unreleased

- Group databases, records, audit logs and background work under workspaces. Migrate existing databases into a protected Default workspace shared by the whole team.
- Let admins create private workspaces and manage access using members' existing team roles. Add a team-wide workspace directory, searchable member selection and confirmation before removing access.
- Replace team API keys with admin-managed workspace API keys. Existing team keys are revoked during migration. Database, table, record, job, artifact and audit operations now require an explicit `workspaceId` in REST and MCP requests.
- Keep the current page visible while workspace navigation loads its destination. Preserve workspace scope on filtered and paginated browser requests, including Restore Attempts.

## 0.2.4 (2026-10-19)

- Add searchable database and table dropdowns to resource breadcrumbs.
- Restructure the documentation, reference navigation and footer; refresh the homepage copy and product screenshots; simplify installation around bundled PostgreSQL and latest-release downloads.
- Add step-by-step API key and MCP connection guides, use Request conventions for REST guidance, and remove retired documentation routes and redirects.
- Require matching application versions and the latest successful verification, documentation and security checks for the exact release commit before publishing. Scan every native platform image for High/Critical vulnerabilities before promoting it.
- Refresh the pinned Node runtime base and remove package managers from runtime images to resolve the base-image findings caught by the publication scan.
- Keep production workload declarations in platform-services, separate from application publication.

## 0.2.3 (2026-10-18)

- Add a dark green elephant mascot with friendly, sad and bucket-holding variants for empty lists, missing pages, unexpected errors and unavailable backup storage.
- Replace the unavailable backup schedule and retention forms with a compact empty state titled "Backup storage unavailable" and storage configuration guidance.
- Show a green loading indicator before "Loading Rootset…".
- Add a Details action to Audit Logs with on-demand, read-only JSON context. Show retained field names before and after reordering, changed field attributes, record counts, request options and backup settings under the same access checks as the log list. New rule and relation events retain their context; older entries without it show an explanatory note.
- Show deleted resource status beside its type as Database (Deleted) or Table (Deleted), with Deleted in italics.

## 0.2.2 (2026-10-18)

- Rename Foreign keys to Table relations in table settings, dialogs, messages, audit labels, restore summaries and documentation. Preserve existing API names, event IDs and links.
- Move Data above Settings in the table sidebar.
- Make the spreadsheet's frozen-column shadow narrower and lighter.

## 0.2.1 (2026-10-18)

- Start field and view-column reordering only from the six-dot drag handle, with keyboard reordering still available on the handle. Center the handle with the column label.
- Keep spreadsheet comment controls at the right edge of a compact row-number column, with space between the number and icon.
- Align visibility checkboxes with the column heading in the Columns panel.
- Mark backup attempt and retention errors with a red warning triangle before the details text.

## 0.2.0 (2026-10-17)

- Create and edit complete records in a drawer, with required fields, defaults, generated IDs, choices, foreign keys and concurrent-edit protection.
- Import CSV or JSONL files with column mapping, typed previews, row-specific validation and downloadable error reports. Imports append records in resumable batches.
- Search referenced records by a personal display field and select complete composite foreign keys.
- Save named personal or shared views with filters, sorting and column layouts. Stale or invalid views preserve their definitions and block loading until corrected.
- Select up to 200 records to atomically set field values, duplicate or delete rows. Field updates and duplication run directly from their drawers; deletion uses a confirmation dialog. New copies become the selected rows.
- Export all matching records from the current view with visible or selected columns, alongside existing full-table and database exports.
- Add indexed incoming-relationship counts and filtered source-record navigation through REST and MCP.
- Verify a managed backup, preview its contents and restore into a new database. Restore preserves records, schemas, constraints, counters, comments, retained history and compatible saved views without copying access grants or schedules.
- Configure successful-backup retention, protect the latest snapshot and packages needed by restores, and notify current administrators about failed or overdue backups.
- Add root-level Audit Logs under Operate, covering retained record and schema changes, imports, exports, backups and restores. Filter by granular event, resource, actor and time, with permission-aware links and relative dates. Group internal workers and operators as Automation.
- Organize database backup controls under Backup & Restore, with separate Backup Schedule, Backup Attempts and Restore Attempts pages. Put manual backups on Backup Attempts and distinguish manual and scheduled attempts by chip color.
- Switch database and table directories between grid and table views. Show descriptions, database total rows and table field counts; table views show the last data change or creation date when no change is recorded.
- Keep the current page visible until the destination's required data is ready, and load the first spreadsheet window before showing its grid.
- Use a CodeMirror JSON editor with syntax highlighting, line numbers and indentation in record drawers and expanded spreadsheet editors.
- Add row and column context menus, selection-aware bulk menus, theme-colored hover states and consistent spreadsheet row heights on desktop and mobile. Fit small tables to the available width and scroll wider tables horizontally.
- Refine column ordering, drag indicators, view controls, form spacing and action icons. Move Delete Table and Delete Database into final Danger Zone sidebar categories and show the application version beside its title.
- Page directory reads in PostgreSQL, read active-field counts without loading definitions and calculate database summaries in one table scan per database.
- Keep native tables on mobile and use the shared drawers, controls, typography and interaction patterns throughout these workflows.

## 0.1.9 (2026-10-16)

- Mark foreign-key columns with an fk chip and open referenced records in a new tab, filtered by the linked values, including composite keys.
- Add database-level Export Requests with one ZIP containing every table’s schema and CSV or JSONL data from a consistent snapshot.
- Include ordered field definitions, unique rules and foreign keys in schema files, with row counts and file checksums in a versioned manifest.
- Support cancellation, retry and expiring downloads with current-access checks. Keep export history in a horizontally scrollable table on mobile.

## 0.1.8 (2026-10-15)

- Add automated database backups using S3-compatible storage configured on the worker, with encrypted, versioned packages and verified uploads.
- Configure a bucket, path prefix, cron schedule and time zone under Backup Schedule. Saving verifies the destination before activating the schedule; deleting it stops future scheduled runs.
- Add manual backups and a separate Backup History page with status, relative timestamps and Manual or Scheduled chips.
- Include schema, records, constraints, counters, comments and history in consistent database snapshots, with an internal reconstruction check to prepare for future restore support.
- Keep backup credentials and the separate backup encryption key on the worker. Restore controls and automatic retention are not included in this release.
- Reduce button heights on mobile and align backup destination details with the shared code typography.

## 0.1.7 (2026-10-15)

- Add foreign keys between tables in the same database, with matching scalar fields and an unconditional unique key on the referenced table.
- Validate existing rows before enabling a foreign key, reject invalid writes, and protect referenced values and schema dependencies.
- Add a Foreign keys section alongside Unique rules in table settings, with REST and MCP support.
- Align database and table page widths, header spacing and icons, and keep tables horizontally scrollable on mobile.
- Render Markdown in record comments, including lists, links, code, tables and images.
- Make NULL values more muted in spreadsheet cells.
- Expand text values longer than 80 characters into a multiline editor with Save and Cancel actions.

## 0.1.6 (2026-10-15)

- Add conditional unique rules and allowed choices for text fields.
- Add integer auto-increment across the editor, REST, MCP and batch mutations, preserving existing IDs and durable counters.
- Improve choice editing, column drag handles, sidebar table counts, card hover feedback and dropdown icons.
- Display NULL values in muted italics in the spreadsheet, editors, field defaults and history.

## 0.1.4 (2026-10-14)

- Add row discussions across the spreadsheet, REST and MCP. Row pages include `hasComments`, and comment contents load on demand in a right-side drawer.
- Retain deleted comments as a muted, italic log entry with author and creation time after clearing their content.
- Improve spreadsheet sorting, empty-sheet placeholders, filter badges and delayed filter previews.
- Show total rows in the sidebar and right-align filtered result counts in the row-number heading, marking estimates with `~`.
- Raise the authenticated request limit to 600 per minute and simplify account-context recovery.
- Update comment timestamps, avatar initials and the drawer composer styling.
- This release changes the prelaunch database baseline. Existing v0.1.3 installations with its earlier baseline cannot upgrade in place; migration refuses the digest mismatch without altering data. Preserve the existing installation and use a separate empty database. Do not clear the migration ledger.

## 0.1.3 (2026-10-13)

- Sort spreadsheet columns by clicking their headers or pressing Enter or Space. Sorting applies to the full table and stays in place when filters change.
- Include Databases and Tables in resource breadcrumbs.
- Show PostgreSQL data and index sizes in database and table cards.
- Align the profile menu with Towbar and remove Repo / Contribute.
- Prepare API, worker and UI at version 0.1.3; publication and deployment remain separate steps.
