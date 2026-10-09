# Cell editor browser verification

Run this suite against the React Data Grid UI and the real local Rootset API, worker, PostgreSQL and SMTP mailbox. It creates its own three-row, eight-type table in the existing `UI verification` database. It does not intercept requests or replace API responses.

The normal prerequisites are a bootstrapped, verified fixture owner in `apps/rootset-web/.env.browser-test`, actual organisation/database IDs in `apps/rootset-web/test-results/browser/fixture.json`, and a worker delivering email to Mailpit. The provisioning script invites a separate Admin, registers the invited account, follows its email verification link, signs in and accepts the invitation. Its password is retained only in the ignored, mode-0600 `apps/rootset-web/.env.cells-browser-test` file.

```sh
pnpm exec tsx apps/rootset-web/src/components/cells/provision-browser-account.ts
pnpm exec playwright test apps/rootset-web/src/components/cells/CellEditor.browser.spec.ts --workers=1 --reporter=list --output apps/rootset-web/test-results/cells-browser
```

The default web URL is `http://localhost:4300`, API URL is `http://localhost:4310`, and mailbox URL is `http://localhost:59080`. Override them with `ROOTSET_BROWSER_BASE_URL`, `ROOTSET_BROWSER_API_BASE_URL`, and `ROOTSET_BROWSER_MAILBOX_URL`. `ROOTSET_UI_FIXTURE_PATH` overrides the metadata file. `ROOTSET_BROWSER_CREDENTIALS_PATH` overrides the separate account file. If that file is absent, `ROOTSET_BROWSER_STATE_PATH` can supply an already authenticated account instead. Each credential-based run creates a fresh session, explicitly selects the fixture organisation and deletes its private temporary storage-state file afterward. Trace capture is disabled to avoid recording authentication bodies. Setup begins in a fresh request window, and test starts are spaced by 20 seconds to respect the normal 120 requests per minute account limit, including the real UI background queries.

| Check           | Real interaction and readback                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eight types     | Open a cell with a double-click; save text, integer, float, boolean, date, UTC time, local date-time and JSON; read the committed typed values through the API.                                                                       |
| Validation      | Reject empty required text, invalid integers and bounds while retaining input; verify no row revision advances.                                                                                                                       |
| Rejected save   | Save a duplicate name against an actual native unique rule; verify HTTP conflict, retained draft, unchanged row/history and successful corrected retry.                                                                               |
| Concurrent edit | Change the same row through another actual API request before saving, including the context-menu null action; require explicit review before retry.                                                                                   |
| Pending save    | Hold `SELECT … FOR UPDATE` on the fixture row in PostgreSQL; verify the API waits on a real lock, repeated saves/cancel are disabled, and the value commits after releasing the lock.                                                 |
| Keyboard        | Escape cancels and returns focus to the selected grid cell; Tab selects the next grid cell; Enter opens/commits; Tab saves the edited cell and focuses the next grid cell; leaving a cell saves valid changes without a confirmation. |
| Preferences     | Change actual account preferences; verify Kolkata local editing stores UTC, date/UTC-time remain stable, New York nonexistent local times reject and repeated local times require a specific instant.                                 |
| JSON            | Check bounded previews for a large value, expanded multiline editing and controls, retained duplicate-key/unsafe-number input, and valid corrected saves.                                                                             |
| Null semantics  | Verify nullable boolean null, false and JSON top-level null remain distinct.                                                                                                                                                          |

For the pending-save check, `.env.test` must supply the isolated `ROOTSET_TEST_DATABASE_URL`. The test reads only the target table's generated mapping, validates those identifiers, sets the tenant context and locks the exact fixture row. It releases the transaction and database connection in a `finally` block. The other checks need no direct SQL fixtures; they use `createTable`, `createUniqueRule`, `getJob`, `createRow`, `getRow`, `updateRow`, `getCellHistory`, `getPreferences`, `updatePreferences` and `updateViewPreferences` through the actual internal API.

Readable screenshots of saved, pending, rejected, conflicting, repeated-time and invalid-JSON states are written to `apps/rootset-web/test-results/cells-browser-evidence` and attached to the test results. Every cell-opening helper also checks that the plain inline input matches the grid font size, has no save/cancel button strip for scalar fields, and has no horizontal overflow. JSON exposes Format, Cancel and Save in an expanded multiline editor.

Passing these checks supports the editor portions of `UI-04` through `UI-07`, `UI-17`, the related field rules and stale revision handling. It does not by itself sign off screen-reader use, touch devices, cross-browser review, network loss, all API/MCP field parity or five-million-row performance. Those require their separate checklist evidence.

The suite also verifies 32 px row height, single-click selection, double-click editing, required-field null restrictions, type tooltips, the `#` header context menu, and the complete add-row form with real typed API values. Cell menus are also available with Shift+F10; Enter/F2 opens the selected inline editor.

For column resizing, drag two columns repeatedly, check that the latest widths
survive reload, and inspect `updateViewPreferences` request outcomes in the API
logs. A pointer movement must not create a request for every intermediate width.
`src/lib/debounced-save.test.ts` covers coalescing, an earlier save held pending,
new movement during that save, navigation flushes, and retry after failure.

Focused checks on the production preview after the editor-layout update: scalar inputs and display text have the same font, 8 px inset and line height; the editor border overlay is 1 px on all four sides and native input borders are zero. Check the rendered screenshot as well as computed values: an ancestor outline can be hidden behind the absolute editor background. The boolean select uses `appearance: none` and the existing green/orange colors. JSON starts formatted, Enter leaves it open, Format preserves its value, and an invalid Save keeps the draft with an inline error. Cancel dismisses it without a confirmation; a bottom-row editor expands upward within the grid. Two filter conditions fit at 1280 px and 390 px viewport widths with equal client/scroll widths. The database card displays the live table count and the revised icons appear in navigation. These focused computer-use checks do not constitute a fresh run of the whole browser suite.
