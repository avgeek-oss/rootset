// These are the current checklist clauses, not additional admission requirements.
export const gateReviewOracles = new Map<string, string>([
  [
    "V1-01",
    "An empty PostgreSQL 18 installation applies the baseline and current forward migrations; concurrent startup and digest mismatch behave safely.",
  ],
  [
    "V1-02",
    "An incompatible earlier prelaunch ledger refuses startup without changing data; the message gives fresh-install guidance and preserves the original installation.",
  ],
  [
    "V1-03",
    "Setup claims one organisation and the first Admin atomically; SQL rejects a second organisation, including concurrent/direct fixture attempts.",
  ],
  [
    "V1-04",
    "Admin/Member/Viewer permissions match the role matrix across browser, REST and MCP; Admin alone manages members and deletes databases/tables; Members create and edit databases/tables/schema; SMTP/S3 configuration is read only from the deployment environment.",
  ],
  [
    "V1-05",
    "Invitations and member role/removal flows work, protect the last Admin, and have no organisation switcher or removed lifecycle fields.",
  ],
  [
    "V1-06",
    "Password/email verification/reset, passkey-gated sign-in, passkey recovery codes, session-bound fresh proof, session revocation and direct password/passkey confirmation work with expiry/replay/rate-limit failures. Authenticator/TOTP capabilities are absent.",
  ],
  [
    "V1-07",
    "Personal key permissions are capped by live membership; workspace-owned team keys have admin-only management and cannot access personal accounts. Verify REST/MCP permission ceilings, rotation, revocation, expiry, creator departure, waiting requests and replay.",
  ],
  [
    "V1-08",
    "OAuth PKCE, redirect/state/issuer/audience, code replay, refresh reuse, revocation and operation consent work with a real MCP client; no database/table selections remain.",
  ],
  [
    "V1-09",
    "Generated OpenAPI/client/MCP artifacts match the catalog; supported operations share strict input/output validation and have useful typed errors.",
  ],
  [
    "V1-10",
    "Browser Origin/CSRF, REST/MCP audience separation, nested-parent validation and SQL parameter/identifier boundaries reject abuse without leaking secrets or data.",
  ],
  [
    "V1-11",
    "Field definitions have only one `name`; 1\u201364 letters/underscores pass, digits/empty/overlong/invalid names fail, and table-local uniqueness is enforced.",
  ],
  [
    "V1-12",
    "Field rename changes the UI label and JSON key together while preserving internal ID, values, query references and interpretable cell history.",
  ],
  [
    "V1-13",
    "All eleven types, defaults/nulls, required fields, numeric/text bounds and JSON validation work without coercion or silent loss.",
  ],
  [
    "V1-14",
    "UTC time/date-time precision, calendar dates and timezone/DST editing round-trip through browser, REST, MCP, export and history.",
  ],
  [
    "V1-15",
    "Row bytes, 200 fields, JSON depth, request/result bytes, query rows and 1,000-row mutation caps enforce exact boundaries.",
  ],
  [
    "V1-16",
    "The 5,000,000th live row succeeds and the next fails; concurrent writers cannot race the limit, rollback releases reservations and committed deletion frees capacity.",
  ],
  [
    "V1-17",
    "Revision conflicts, no-op updates, atomic batches and idempotent retry preserve the committed outcome under concurrent writes and network/process loss.",
  ],
  [
    "V1-18",
    "Single/composite scalar uniqueness handles nulls, exact text/float equality, wide tuples, forced digest collisions and concurrent insert/update/delete.",
  ],
  [
    "V1-19",
    "Schema/rule/index jobs validate existing values and row size; interrupted conversion/index activation reconciles actual catalog state and preserves the original generation on failure.",
  ],
  [
    "V1-20",
    "Inserts/edits/conversions record correct typed before/after values, field/row IDs, revisions, attribution and UTC time in the data transaction; failed/no-op writes add no false cell history.",
  ],
  [
    "V1-21",
    "Field renames preserve interpretable history; deletion of a row, field, table or database removes its corresponding cell changelogs for every role; each existing cell retains only its latest 200 saved changes; no-op and failed writes add no entry.",
  ],
  [
    "V1-22",
    "Typed filters, JSON operators, projection/sort, signed cursors, byte-capped continuation and deep window navigation return correct complete rows.",
  ],
  [
    "V1-23",
    "Scan timeout/disconnect cancels owned work and preserves peer requests; native connection cleanup/restart tests cover idle and active pools without leaks.",
  ],
  [
    "V1-24",
    "Durable jobs fence stale leases, resume committed checkpoints, disclose partial cancellation and publish effects once under worker/process termination.",
  ],
  [
    "V1-25",
    "CSV/JSONL exports preserve types/UTC/leading-zero text and produce authenticated checksummed artifacts.",
  ],
  [
    "V1-26",
    "Database backup/restore operations, scopes and generated REST/MCP contracts are absent; API/MCP row creation remains available.",
  ],
  [
    "V1-27",
    "The browser provides filters and inline edits, automatically loads batches during scrolling, uses path-based resource URLs, and restores committed values with a toast on failed edits. There is no Add row button, row-creation modal, Go to row action or backup navigation.",
  ],
  [
    "V1-28",
    "The fresh baseline contains no backup, restore or backup-notification tables; exports and bounded cell history remain functional; archive/policy and separate row-log tables are absent.",
  ],
  [
    "V1-29",
    "Full-installation recovery restores database ownership, identity/control/data state, a nonempty object set and the installation encryption key on a separate target without altering the source.",
  ],
  [
    "V1-30",
    "Object/SMTP outage, corruption, missing keys, disk pressure and connection saturation produce truthful failures/retry behavior; retention preserves the last verified recovery point.",
  ],
  [
    "V1-31",
    "Real phone/desktop and light/dark flows cover setup, people, role/key/OAuth settings, all typed editors, drafts/conflicts, history and job terminal states.",
  ],
  [
    "V1-32",
    "Keyboard, touch, screen-reader and zoom behavior work on the actual grid; no removed account/resource-selection, installation tuning/provider configuration or standalone Background Jobs controls remain.",
  ],
  [
    "V1-33",
    "Record genuine five-million-row and 200-field near-limit fixtures, counts/checksums, at least ten million history events and the approved resource/network profile.",
  ],
  [
    "V1-34",
    "Warm/cold indexed queries, normal/byte-capped REST pages, unindexed scans and deep navigation meet the targets below with plans, percentiles and errors.",
  ],
  [
    "V1-35",
    "Ten simultaneous editing clients meet committed edit/history targets without lost changes or duplicate history; background work keeps foreground reads responsive.",
  ],
  [
    "V1-36",
    "Safari/Chromium viewport, five-minute scroll, cache eviction, memory and restart/query-switching checks meet the targets without growing leaks.",
  ],
  [
    "V1-37",
    "`pnpm contracts:generate` drift, `pnpm verify` and affected genuine integration/browser checks pass for the exact candidate; missing prerequisites are reported.",
  ],
  [
    "V1-38",
    "Fresh images/installation, non-root runtime privileges, narrow mounts/environments and readiness are verified, including failed migration/dependency startup.",
  ],
  [
    "V1-39",
    "A reviewer follows the current installation, account/key and PostgreSQL/provider recovery runbooks successfully with synthetic isolated data.",
  ],
  [
    "V1-40",
    "The report lists current results and unresolved checks, keeps historical evidence separate and states acceptance/publication/deployment status truthfully.",
  ],
]);
