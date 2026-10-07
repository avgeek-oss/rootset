// These are the current checklist clauses, not additional admission requirements.
export const gateReviewOracles = new Map<string, string>([
  [
    "V1-01",
    "An empty PostgreSQL 18 installation applies only `0001_baseline.sql`; concurrent startup and digest mismatch behave safely.",
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
    "Admin/Member/Viewer permissions match the role matrix across browser, REST and MCP; Admin alone manages members, schema and restores; SMTP/S3 configuration is read only from the deployment environment.",
  ],
  [
    "V1-05",
    "Invitations and member role/removal flows work, protect the last Admin, and have no organisation switcher or removed lifecycle fields.",
  ],
  [
    "V1-06",
    "Password/email verification/reset, passkey-gated sign-in, passkey recovery codes, session-bound fresh proof, session revocation and explicit sensitive-action approval work with expiry/replay/rate-limit failures. Authenticator/TOTP capabilities are absent.",
  ],
  [
    "V1-07",
    "Personal keys inherit current role without operation/resource selectors; demotion, member removal, expiry and revocation affect existing and waiting requests and replay.",
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
    "All eight types, defaults/nulls, required fields, numeric/text bounds and JSON validation work without coercion or silent loss.",
  ],
  [
    "V1-14",
    "UTC time/date-time precision, calendar dates and timezone/DST editing round-trip through browser, REST, MCP, export, history and backup.",
  ],
  [
    "V1-15",
    "Row bytes, 200 fields, JSON depth, request/result bytes, query rows and 1,000-row mutation caps enforce exact boundaries.",
  ],
  [
    "V1-16",
    "The 5,000,000th live row succeeds and the next fails; concurrent imports/writers cannot race the limit, rollback releases reservations and committed deletion frees capacity.",
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
    "Inserts/edits/deletes/imports/conversions record correct typed before/after values, field/row IDs, revisions, attribution and UTC time in the data transaction; failed/no-op writes add no false cell history.",
  ],
  [
    "V1-21",
    "Row/field deletion, field renames and retained table/database history remain interpretable and obey current role; archive readback/retention never loses required history silently.",
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
    "CSV/JSONL import/export preserves types/UTC/leading-zero text, validates dry runs/upsert conflicts, resumes without duplicates and produces authenticated checksummed artifacts.",
  ],
  [
    "V1-26",
    "Backups run only on manual trigger; no scheduling policy or cron endpoint exists. One consistent database snapshot includes schema, rows, rules and retained history during concurrent editing.",
  ],
  [
    "V1-27",
    "A successful backup has encrypted-object readback and an isolated restore comparison of schema, values, revisions, history, constraints and checksums; upload alone stays unverified.",
  ],
  [
    "V1-28",
    "New/replacement restore validates before publication, preserves the original on failed/cancelled cutover and never activates a captured failed rule/index.",
  ],
  [
    "V1-29",
    "Full-installation recovery restores SQL role privileges, identity/control/data state, a nonempty object set and retained encryption keys on a separate target without altering the source.",
  ],
  [
    "V1-30",
    "Object/SMTP outage, corruption, missing keys, disk pressure and connection saturation produce truthful failures/retry behavior; retention preserves the last verified recovery point.",
  ],
  [
    "V1-31",
    "Real phone/desktop and light/dark flows cover setup, people, role/key/OAuth settings, all typed editors, drafts/conflicts, history and job terminal states. The shared notification menu covers empty/loading/failure states, bounded complete pagination, explicit mark-all, per-user isolation and durable read-state recovery.",
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
    "A reviewer follows the current installation, account/key recovery and backup/restore runbooks successfully with synthetic isolated data.",
  ],
  [
    "V1-40",
    "The report lists current results and unresolved checks, keeps historical evidence separate and states acceptance/publication/deployment status truthfully.",
  ],
]);
