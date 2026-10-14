# Changelog

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
