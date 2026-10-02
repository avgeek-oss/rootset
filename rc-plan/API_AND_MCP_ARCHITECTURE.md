# API and MCP architecture

Baseline: 2026-10-02. Status: planned contracts and operation inventory; no endpoints or tools are implemented. Related contracts: [accounts](ACCOUNT_ARCHITECTURE.md), [database](MDM_DATABASE_ARCHITECTURE.md), [stack](STACK_ARCHITECTURE.md), and [verification](IMPLEMENTATION_VERIFICATION_CHECKLIST.md).

## Shared operation model

Browser, public REST, MCP, and workers execute the same domain operations. Each definition has a stable operation ID, input/output schemas, required scopes, role ceiling, resource-target resolver, read/mutation classification, idempotency/concurrency rules, step-up requirement, audit event, and error codes.

Generate the public OpenAPI document, browser client, MCP schemas, and coverage inventory from these definitions. Transport adapters handle authentication and formatting; they cannot implement independent validation or permissions. In particular, a read-only key can execute a read-classified POST query. Do not copy Towbar's broad HTTP-method read/write guard as the Rootset permission decision.

The completed operation matrix records UI entry, internal HTTP route, public route, MCP tool, job behavior, scope, role, interactive requirement, and verification IDs. The catalog below is the v1 baseline. A route added during implementation needs a corresponding matrix row and sign-off check; no undocumented admin bypass is permitted.

## Surfaces and origins

Use one configured HTTPS installation origin. Examples below use `https://rootset.example`; they do not establish deployment or DNS at rootset.fyi.

| Surface                   | Entry point                            | Authentication                                                                             |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Browser operation API     | `/api/internal/v1/...`                 | Secure HttpOnly cookie, current organisation context, CSRF/origin validation on mutations. |
| Public REST               | `/v1/...`                              | Bearer personal/team API key or REST-audience OAuth access token.                          |
| Remote MCP                | `/mcp`                                 | Streamable HTTP with OAuth access token bound to this resource.                            |
| OAuth HTTP                | `/oauth/...` and well-known metadata   | Protocol-specific client/user verification; consent uses the browser session.              |
| Setup/authentication      | `/v1/setup`, `/v1/auth/...`            | Bootstrap, public challenge, or browser authentication as appropriate.                     |
| Operator/internal service | Restricted CLI/worker service adapters | Installation credentials or dedicated service identity, never public browser cookies.      |

Serve the web app's internal routes through same-origin reverse proxy routing to the API. Internal browser routes use the same operation schemas and services as public REST. They do not expose server-to-server worker credentials. Workers poll jobs directly with their restricted database role; do not ship a public "run arbitrary job" endpoint.

## REST authentication

Accept `Authorization: Bearer <token>` only, with no query-string token. Keys are resolved by non-secret lookup ID and verified against stored hashes. Evaluate expiry/revocation, current user/membership where personal, operation scopes, target grants, role ceiling, and any step-up proof. Team keys are organisation service principals. Do not create a browser session from a key.

OAuth grants are audience-bound to `/v1` or `/mcp` as consented. Reject a token at the other resource. Never pass a client token through to another service. Effective permission is the intersection of credential scope/targets and current actor authority. A key's ability to manage keys does not allow it to mint a broader credential.

Scopes follow domain operations, for example `databases:read`, `databases:manage`, `schema:manage`, `rows:read`, `rows:write`, `history:read`, `imports:write`, `exports:read`, `backups:manage`, `members:manage`, `keys:manage`, and `account:security`. Group names are not a full-admin shortcut. Organisation/database/table targets are separate grants so a key can read one table without enumerating all others.

## OAuth and remote MCP

Implement OAuth authorisation-code flow with S256 PKCE, exact registered redirect matching, single-use short-lived codes, issuer validation, resource indicators, client attribution, and explicit consent. Advertise protected-resource metadata and authorisation-server metadata. Follow the [current MCP authorisation specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization); pin the supported protocol version in implementation and test real clients.

| Endpoint                                             | Responsibility                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource/mcp`      | MCP resource URI, authorisation servers, relevant supported scopes, bearer method.                         |
| `GET /.well-known/oauth-protected-resource/v1`       | REST protected-resource metadata.                                                                          |
| `GET /.well-known/oauth-authorization-server`        | Issuer, authorise/token/revoke endpoints, code/refresh support, S256 and client-registration capabilities. |
| `GET /oauth/authorize`                               | Validate request/client/resource/scope, associate issuer/PKCE/state, enter login/consent.                  |
| `GET /api/internal/v1/oauth/requests/{id}`           | Browser-only consent details with verified client identity/trust level and exact grants.                   |
| `POST /api/internal/v1/oauth/requests/{id}/decision` | Approve/deny once, preserving the bound request and user authority.                                        |
| `POST /oauth/token`                                  | Exchange a code or rotate a refresh token; validate client and resource binding.                           |
| `POST /oauth/revoke`                                 | Revoke token/grant or refresh family without revealing token validity to unrelated callers.                |
| `POST /oauth/register`                               | Optional compatibility dynamic registration, with rate limits and SSRF/redirect validation.                |

Prefer Client ID Metadata Documents and preregistered clients; dynamic registration is a compatibility feature. Metadata-document fetching requires redirect/size/time limits, private-network rejection, HTTPS origin validation, and bounded caching. A fetched client name/logo does not establish trust by itself. Consent must distinguish verified metadata provenance from an unverified claim.

Access tokens expire after 15 minutes. Refresh tokens rotate, have seven-day inactivity and 30-day absolute expiry, and are stored hashed. Reuse revokes the family. Token issuance and consumption are transactional under concurrent exchanges. Revoked membership, grants, or account state also invalidate effective access before token expiry.

Return standards-compatible 401 `WWW-Authenticate` resource metadata and insufficient-scope challenges. Rate-limit pre-authentication OAuth endpoints and authenticated operation buckets separately. Never request all write/admin scopes simply because a client wants to list databases.

MCP supports initialise, tools/list, tools/call, the protocol's lifecycle/negotiation, and authorised artifact resources where implemented. A protocol session ID is transport state, not authentication. Reauthenticate each request. Browser Origin checks and negotiated headers must follow the pinned Streamable HTTP spec; do not rely on Origin as the sole credential check.

## Requests, rows and concurrency

Resource paths resolve IDs plus their full parent ownership. Passing an existing table ID under another database/organisation fails without leaking its real location. Unknown and unauthorised targets have a consistent disclosure policy.

Rows return `{ id, version, createdAt, updatedAt, values }`. Row versions are decimal strings to preserve bigint precision; schema versions are bounded positive integers. Internal IDs are returned by API/MCP and are not user grid columns. `values` maps immutable API keys to canonical typed values. Unknown fields, coercions, system writes, and invalid temporal values are rejected.

Mutations require `Idempotency-Key` for row creates/patches/deletes, schema writes, batch writes, imports, jobs, and credential creation/rotation. The operation catalog declares the policy for other account/configuration mutations. Store a digest including actor, organisation, operation, target, schema version, and payload. Reusing a key with different input yields `IDEMPOTENCY_CONFLICT`; replaying equivalent input returns the prior non-secret result after rechecking current access. Default synchronous replay retention is 24 hours. Durable job/batch identities persist for the job's lifetime.

Row update/delete requires the expected revision. PATCH accepts `expectedVersion`; DELETE uses `If-Match: "<row-id>:<version>"`. Schema mutation requires `expectedSchemaVersion`. Stale values return 409 with authorised current revision/value details. A batch checks every expected revision and is atomic unless explicitly submitted as a large import job.

JSON requests are capped at 8 MiB. Duplicate/malformed members, unknown envelope keys, invalid UTF-8, too-deep inputs, excess predicates and unsupported field values fail with typed errors. Validate body size before parsing and use a decoder that can reject duplicate members where the contract requires it.

## Query contract

The same object is accepted by `POST .../query` and `rootset_query_rows`. Filters resolve API keys or stable field IDs, and output projection controls user values independently of hidden row identity.

```json
{
  "select": ["AIRLINE_ID", "SHORT_NAME", "IS_ACTIVE"],
  "where": {
    "and": [
      { "field": "IS_ACTIVE", "op": "eq", "value": true },
      { "field": "SHORT_NAME", "op": "contains", "value": "Air" }
    ]
  },
  "orderBy": [{ "field": "AIRLINE_ID", "direction": "asc" }],
  "limit": 5000,
  "cursor": null
}
```

REST defaults to 5,000 rows; MCP defaults to 200. Explicit limits are 1-25,000. The result uses `data`, `schemaVersion`, and `page` containing `returned`, `requestedLimit`, `hasMore`, `nextCursor`, `stopReason`, and `consistency: "live"`. Stop reasons distinguish row limit, byte limit, and end of results. A timeout is an error, not a truncated successful page.

REST/browser results fit an 8 MiB encoded budget; MCP results fit 1 MiB including structured result overhead. Return complete rows only and an appropriate continuation. An exact filtered count is an explicit job when expensive; do not count for every page. A cursor binds query/schema/target/grants and expires after one hour. Live cursor traversal is not snapshot isolation; exports offer a consistent whole-result snapshot.

GET row listing supports a compact documented subset of projection/order/limit/cursor. Use POST query for full typed filters rather than embedding a SQL-like language in a URL. JSON-path filters use a bounded segment-array representation, avoiding ambiguous escaped path strings. Include indexed operator guidance in schema discovery.

## Operation inventory

Path shorthand: `O = /v1/orgs/{orgId}`, `D = O/databases/{databaseId}`, `T = D/tables/{tableId}`. Expanded paths are emitted in OpenAPI. The browser operation API mirrors these operations under its internal prefix; it adds only session/context/UI-window and interactive challenge adapters.

The "authority" column describes the minimum scope plus role/resource gate; the account contract defines exact ceilings. "Step-up" means a bound account-action approval where required. The listed MCP tools are planned tools, not currently callable.

### Accounts and organisation

| Operation                              | Public HTTP                                                      | Authority                                                                      | MCP                                                                              |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Get caller/context                     | `GET /v1/me`                                                     | Authenticated principal; redacted service-principal representation             | `rootset_get_context`                                                            |
| Get/update own profile                 | `GET/PATCH /v1/me/profile`                                       | Personal `profile:manage`                                                      | `rootset_get_profile`, `rootset_update_profile`                                  |
| Get/update preferences                 | `GET/PATCH /v1/me/preferences`                                   | Personal `profile:manage`                                                      | `rootset_get_preferences`, `rootset_update_preferences`                          |
| Preference options/preview             | `GET /v1/preferences/options`, `POST /v1/me/preferences/preview` | Authenticated; preview is read-only                                            | `rootset_get_preference_options`, `rootset_preview_preferences`                  |
| List/revoke own sessions               | `GET /v1/me/sessions`, `DELETE /v1/me/sessions/{id}`             | Personal `account:security`; step-up for broad revocation                      | `rootset_list_sessions`, `rootset_revoke_session`                                |
| List/revoke OAuth grants               | `GET /v1/me/connections`, `DELETE /v1/me/connections/{id}`       | Personal `account:security`                                                    | `rootset_list_connections`, `rootset_revoke_connection`                          |
| Start/inspect sensitive account action | `POST /v1/me/actions`, `GET /v1/me/actions/{id}`                 | Personal authority for requested action                                        | `rootset_begin_account_action`, `rootset_get_account_action`                     |
| Complete sensitive action              | `POST /v1/me/actions/{id}/complete`                              | Bound action approval; single use                                              | `rootset_complete_account_action`                                                |
| List accessible organisations          | `GET /v1/orgs`                                                   | Current memberships/service-principal organisation                             | `rootset_list_organisations`                                                     |
| Get/update organisation                | `GET/PATCH O`                                                    | `org:read` / `org:manage`, Owner/Admin                                         | `rootset_get_organisation`, `rootset_update_organisation`                        |
| Transfer ownership                     | `POST O/ownership-transfer`                                      | Owner `ownership:manage`, step-up                                              | `rootset_transfer_ownership`                                                     |
| Delete organisation                    | `DELETE O`                                                       | Owner `ownership:manage`, step-up, deletion job                                | `rootset_delete_organisation`                                                    |
| List/update/remove members             | `GET O/members`, `PATCH/DELETE O/members/{id}`                   | `members:read/manage`, role/last-owner gates                                   | `rootset_list_members`, `rootset_update_member`, `rootset_remove_member`         |
| List/create/cancel invitations         | `GET/POST O/invitations`, `DELETE O/invitations/{id}`            | `members:manage`, Owner/Admin                                                  | `rootset_list_invitations`, `rootset_invite_member`, `rootset_cancel_invitation` |
| List/update resource grants            | `GET/PATCH O/grants`                                             | `grants:manage`, Owner/Admin, no authority expansion                           | `rootset_get_grants`, `rootset_update_grants`                                    |
| Read organisation audit                | `POST O/audit/query`                                             | `audit:read`, target restrictions                                              | `rootset_query_organisation_audit`                                               |
| List/create personal keys              | `GET/POST /v1/me/keys`                                           | Personal `keys:manage`, authority intersection, creation step-up as applicable | `rootset_list_personal_keys`, `rootset_create_personal_key`                      |
| Rotate/revoke personal key             | `POST /v1/me/keys/{id}/rotate`, `DELETE /v1/me/keys/{id}`        | Personal `keys:manage`, ownership and step-up gates                            | `rootset_rotate_personal_key`, `rootset_revoke_personal_key`                     |
| List/create team keys                  | `GET/POST O/keys`                                                | `keys:manage`, Owner/Admin; create step-up                                     | `rootset_list_team_keys`, `rootset_create_team_key`                              |
| Rotate/revoke team key                 | `POST O/keys/{id}/rotate`, `DELETE O/keys/{id}`                  | `keys:manage`, Owner/Admin, rotation step-up                                   | `rootset_rotate_team_key`, `rootset_revoke_team_key`                             |
| List passkeys/factor status            | `GET /v1/me/security`                                            | Personal `account:security`; credential metadata only                          | `rootset_get_security_status`                                                    |

Password/email change, passkey registration/removal, TOTP enable/disable, recovery-code rotation, account deletion, and sign-out-everywhere are named account-action types. Starting/completing them is available through API/MCP, but proof of user presence or factor verification is completed in the browser. The action status does not return factor secrets to a third-party MCP client.

### Databases, tables and schema

| Operation                      | Public HTTP                                                | Authority                                               | MCP                                                                          |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| List/create databases          | `GET/POST O/databases`                                     | `databases:read/manage`, create Owner/Admin             | `rootset_list_databases`, `rootset_create_database`                          |
| Get/update/delete database     | `GET/PATCH/DELETE D`                                       | `databases:read/manage`; delete step-up/job             | `rootset_get_database`, `rootset_update_database`, `rootset_delete_database` |
| List/create tables             | `GET/POST D/tables`                                        | `tables:read/manage`, database resource grant           | `rootset_list_tables`, `rootset_create_table`                                |
| Get/update/delete table        | `GET/PATCH/DELETE T`                                       | `tables:read/manage`; delete step-up/job                | `rootset_get_table`, `rootset_update_table`, `rootset_delete_table`          |
| Get complete table schema      | `GET T/schema`                                             | `tables:read`                                           | `rootset_get_table_schema`                                                   |
| List/create fields             | `GET/POST T/fields`                                        | `tables:read` / `schema:manage`                         | `rootset_list_fields`, `rootset_create_field`                                |
| Update/remove field            | `PATCH/DELETE T/fields/{fieldId}`                          | `schema:manage`, expected schema/dependency checks      | `rootset_update_field`, `rootset_delete_field`                               |
| Reorder fields                 | `PUT T/field-order`                                        | `schema:manage`; labels/order only                      | `rootset_reorder_fields`                                                     |
| Preview schema change          | `POST T/schema/preview`                                    | `schema:manage`; read-only dry run                      | `rootset_preview_schema_change`                                              |
| Start/inspect schema operation | `POST T/schema/operations`, `GET T/schema/operations/{id}` | `schema:manage`; job and final catalogue readback       | `rootset_apply_schema_change`, `rootset_get_schema_operation`                |
| List/create unique rules       | `GET/POST T/unique-rules`                                  | `tables:read` / `schema:manage`; creation job if needed | `rootset_list_unique_rules`, `rootset_create_unique_rule`                    |
| Remove unique rule             | `DELETE T/unique-rules/{id}`                               | `schema:manage`, expected schema version                | `rootset_delete_unique_rule`                                                 |
| List/create/remove indexes     | `GET/POST T/indexes`, `DELETE T/indexes/{id}`              | `tables:read` / `schema:manage`; build job              | `rootset_list_indexes`, `rootset_create_index`, `rootset_delete_index`       |

### Rows, query and history

| Operation               | Public HTTP                                  | Authority                                            | MCP                                                  |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| List/query rows         | `GET T/rows`, `POST T/query`                 | `rows:read`; POST query remains read-only            | `rootset_query_rows`                                 |
| Get a row               | `GET T/rows/{rowId}`                         | `rows:read`                                          | `rootset_get_row`                                    |
| Create a row            | `POST T/rows`                                | `rows:write`, idempotency/capacity                   | `rootset_create_row`                                 |
| Patch a row             | `PATCH T/rows/{rowId}`                       | `rows:write`, expected version, idempotency          | `rootset_update_row`                                 |
| Delete a row            | `DELETE T/rows/{rowId}`                      | `rows:write`, If-Match, idempotency                  | `rootset_delete_row`                                 |
| Atomic batch mutation   | `POST T/rows/batch`                          | `rows:write`, maximum 1,000 rows                     | `rootset_mutate_rows`                                |
| Query/count metadata    | `GET T/statistics`, `POST T/count`           | `rows:read`; exact filtered count may be a job       | `rootset_get_table_statistics`, `rootset_count_rows` |
| Get cell history        | `GET T/rows/{rowId}/cells/{fieldId}/history` | `history:read`; retained resource grants             | `rootset_get_cell_history`                           |
| Query row/table history | `POST T/history/query`                       | `history:read`, bounded filters/projection/paging    | `rootset_query_history`                              |
| Get mutation outcome    | `GET O/mutations/{id}`                       | Actor or authorised target auditor; no secret replay | `rootset_get_mutation`                               |

### Imports, exports, backups and jobs

| Operation                       | Public HTTP                                         | Authority                                                 | MCP                                                      |
| ------------------------------- | --------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Prepare/upload import artifact  | `POST T/imports/uploads`                            | `imports:write`, bounded authenticated/presigned upload   | `rootset_prepare_import_upload`                          |
| Validate import                 | `POST T/imports/validate`                           | `imports:write`, schema/mapping, report/job               | `rootset_validate_import`                                |
| Run import                      | `POST T/imports`                                    | `imports:write` plus `rows:write`, idempotent job         | `rootset_import_rows`                                    |
| Run snapshot export             | `POST T/exports`                                    | `exports:read` plus source read, job                      | `rootset_export_rows`                                    |
| Get artifact/download access    | `GET O/artifacts/{id}`                              | Current source/target access, short-lived access          | `rootset_get_artifact`                                   |
| Get/set backup policy           | `GET/PUT D/backup-policy`                           | `backups:read/manage`, Owner/Admin; secret-change step-up | `rootset_get_backup_policy`, `rootset_set_backup_policy` |
| Preview cron occurrences        | `POST D/backup-policy/preview`                      | `backups:read`; read-only                                 | `rootset_preview_backup_schedule`                        |
| List/get backups                | `GET D/backups`, `GET D/backups/{id}`               | `backups:read`                                            | `rootset_list_backups`, `rootset_get_backup`             |
| Run manual backup               | `POST D/backups`                                    | `backups:manage`, idempotent job                          | `rootset_create_backup`                                  |
| Delete a backup                 | `DELETE D/backups/{id}`                             | `backups:manage`, recovery-point policy                   | `rootset_delete_backup`                                  |
| Preview restore                 | `POST D/backups/{id}/restore-preview`               | `backups:manage`, compatibility/target dry run            | `rootset_preview_restore`                                |
| Run restore                     | `POST D/backups/{id}/restores`                      | `backups:manage` plus target manage; replacement step-up  | `rootset_restore_backup`                                 |
| List/get jobs                   | `GET O/jobs`, `GET O/jobs/{id}`                     | `jobs:read`, requester/resource restrictions              | `rootset_list_jobs`, `rootset_get_job`                   |
| Cancel/retry job                | `POST O/jobs/{id}/cancel`, `POST O/jobs/{id}/retry` | `jobs:cancel/retry` plus original operation authority     | `rootset_cancel_job`, `rootset_retry_job`                |
| Get organisation storage/limits | `GET O/usage`                                       | `org:read`, appropriately redacted                        | `rootset_get_usage`                                      |

### Browser, setup and installation adapters

| HTTP adapter                                                                                                                | Purpose and MCP relationship                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/setup`, `POST /v1/setup`                                                                                           | Installation bootstrap status/claim, protected by bootstrap secret where needed. OAuth cannot precede creation of the first identity; no pre-authenticated MCP setup tool is advertised.                                                                                                                                                          |
| `/v1/auth/login`, `/v1/auth/logout`, `/v1/auth/password-reset/*`, `/v1/auth/email-verification/*`, `/v1/auth/invitations/*` | Identity establishment and public proof flows. After authentication, related management actions use the shared account-action tools.                                                                                                                                                                                                              |
| `/v1/auth/passkeys/*`, `/v1/auth/two-factor/*`                                                                              | Start/finish factor challenges. Actual WebAuthn/TOTP proof stays browser-mediated and bound to the account action.                                                                                                                                                                                                                                |
| `GET /api/internal/v1/context`                                                                                              | Selected organisation, current permissions, preferences, and onboarding state. Public equivalent is `rootset_get_context`.                                                                                                                                                                                                                        |
| `/api/internal/v1/tables/{id}/windows/*`                                                                                    | Grid anchor/window navigation adapter to the shared query compiler; public clients use query/cursors. It does not add unauthorised data access.                                                                                                                                                                                                   |
| `GET/PUT /api/internal/v1/view-preferences/{tableId}`                                                                       | Per-user column width/order/freeze/filter preferences. Public `GET/PUT /v1/me/view-preferences/{tableId}` and `rootset_get_view_preferences` / `rootset_update_view_preferences` use the same service and current table access checks.                                                                                                            |
| `/api/internal/v1/account-actions/{id}/approve`                                                                             | Browser session/factor approval, issuer/client/action-bound. MCP can inspect and then complete the approved action.                                                                                                                                                                                                                               |
| `GET /v1/installation/status`, `GET/PATCH /v1/installation/configuration`, `POST /v1/installation/email-test`               | Operator-authorised health/configuration/redacted email test. MCP equivalents are `rootset_get_installation_status`, `rootset_get_installation_configuration`, `rootset_update_installation_configuration`, `rootset_test_email`, subject to installation authority and step-up. Organisation Owner alone does not confer installation authority. |
| `/health/live`, `/health/ready`                                                                                             | Bounded, redacted operational probes. They are not general data operations or private configuration disclosure.                                                                                                                                                                                                                                   |

The matrix must explicitly distinguish identity/protocol bootstrap and interactive proof from ordinary business operations. Administrative actions remain available through API/MCP initiation and completion; a tool must return an actionable approval state when human presence is required. It must not silently omit the operation or claim to have performed a WebAuthn ceremony.

## OpenAPI and schemas

Emit [OpenAPI 3.1.2](https://spec.openapis.org/oas/v3.1.2.html) with JSON Schema 2020-12. Publish `/v1/openapi.json` with no credentials or private installation configuration. Generate a separate internal browser description for development. Evaluate 3.2.x only after selected validators/generators/client tools pass compatibility checks.

Every operation needs operationId, tags, expanded path parameters, request/output schemas, auth/scopes, required concurrency/idempotency headers, examples, status/errors, and job semantics. Use a union/discriminator for field definitions. JSON Schema `format` annotations do not replace runtime UTC/date/number validation. Runtime-created tables expose their schemas through `T/schema`; the root spec uses generic row values plus schema discovery rather than regenerating the entire installation spec on each field edit.

CI checks the emitted spec, validates examples, compares operation inventory across transports, and generates a client that compiles and runs against actual endpoints. Specification generation is not enough: verify HTTP status/media type, nullability, numeric/temporal serialisation, pagination, and job responses. Secret-bearing outputs such as one-time key creation have explicit write-only/non-replay behavior.

## MCP outputs and tool behavior

Tools are named for tasks and have bounded, typed input schemas, descriptions, output schemas, and correct read-only/destructive/idempotent annotations. Annotations inform the client; server permissions remain authoritative. Tools/list does not leak hidden table names, rows, or keys. Tool arguments cannot choose an actor or bypass a resource grant.

Use `structuredContent` for machine-readable results and a short text summary. Do not duplicate thousands of rows in text and structured output. Pagination defaults/budgets differ from REST only where specified; data types, field validation, history, and mutation behavior remain identical. Large reads start exports and return job/artifact references, with current access checked on retrieval.

Mutation tools return committed row revisions/mutation IDs or a durable job ID and state. Tool errors distinguish validation, denied access, conflict, timeout, and upstream/job failure. A tool that starts a backup must not say "backup completed" before verified terminal success. Protected export resources can use `rootset://artifacts/{id}`; resource reads validate credentials, audience, current grants and artifact expiry.

## Errors, rate limits and jobs

REST error envelope is `{ error: { code, message, requestId, details? } }`, with field errors keyed by field ID/API key and no stack/SQL/secret output. Codes include `VALIDATION_FAILED`, `UNAUTHENTICATED`, `ACCESS_DENIED`, `RESOURCE_NOT_FOUND`, `ROW_VERSION_CONFLICT`, `SCHEMA_VERSION_CONFLICT`, `UNIQUE_CONFLICT`, `ROW_SIZE_LIMIT`, `ROW_LIMIT_REACHED`, `PAYLOAD_TOO_LARGE`, `QUERY_TIMEOUT`, `CURSOR_INVALID`, `STEP_UP_REQUIRED`, `IDEMPOTENCY_CONFLICT`, and `JOB_FAILED`. Use appropriate 400/401/403/404/409/413/422/429/5xx statuses. MCP carries the same domain code/details in its error result, separately from protocol errors.

Rate limits include pre-auth IP buckets, credential/organisation request buckets, mutation budgets, query concurrency and job admission. Engineering starting point is 120 authenticated requests/minute per principal, ten concurrent reads, and five concurrent mutations, with configurable operator ceilings and explicit Retry-After. Performance rehearsal can tune these values; do not reduce correctness or expose unbounded jobs to increase throughput.

Asynchronous operations return 202 with a job ID and status URL. Job responses identify queued/running/succeeded/failed/cancelled/partially_completed states and domain substage such as backup verifying. Polling is available on REST/MCP. Browser events may provide updates but are not the only completion mechanism. Retry/cancel checks original operation permissions and records already committed work.

## Acceptance

Verification gates `API-*`, `MCP-*`, `KEY-*`, and all domain gates apply. The coverage inventory must show every ordinary domain/admin operation across UI, browser service, REST and MCP, with documented bootstrap/interactive adapters. Test real OAuth clients, short-token expiry, refresh races/reuse, resource mismatch, read-only POST queries, parent-resource isolation, idempotent retries, byte-bounded paging, generated clients, and job terminal readback.
