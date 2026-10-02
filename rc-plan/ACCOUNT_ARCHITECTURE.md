# Account architecture

Baseline: 2026-10-02. Status: v1 design contract; implementation and verification are in progress. Final acceptance requires the [verification checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md). Related contracts: [database](MDM_DATABASE_ARCHITECTURE.md), [API and MCP](API_AND_MCP_ARCHITECTURE.md), and [stack](STACK_ARCHITECTURE.md).

## Organisation structure

An installation contains organisations. An organisation owns logical databases, resource grants, team API keys, backup policies, and organisation audit events. A user is a global identity and receives access through an organisation membership. Do not put the organisation role on the user record.

Initial self-hosted onboarding creates one organisation and its first Owner. General public signup and arbitrary organisation creation are disabled in v1. The schema supports users with multiple memberships so future hosting does not require replacing identity records. If several organisations are provisioned through supported administration, sessions select one explicitly; every request resolves and authorises its organisation. The initial product does not promise public SaaS signup or billing.

An installation operator controls deployment, migrations, secrets, and recovery. Operator authority is separate from an organisation role. A deployment-controlled CLI can bind operator authority to a verified Rootset user for installation settings through the browser, REST or OAuth/MCP; an organisation Owner cannot grant it through organisation administration. Delegated access also requires explicit installation scopes, and team keys cannot acquire this authority. An operator recovery action must have a bounded CLI/runbook, an audit record, and a notification. Database ownership is never inferred from knowing a resource ID.

## Management records

| Record              | Main attributes                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| User                | ID, display name, canonical email, email verification, disabled state, authentication version, created/updated timestamps.                       |
| Preferences         | User ID, IANA timezone, date format, 12/24-hour time format, locale, system/light/dark theme.                                                    |
| Organisation        | ID, name, description, lifecycle state, timestamps.                                                                                              |
| Membership          | Organisation ID, user ID, role, membership version, active/disabled state. Unique on organisation plus user.                                     |
| Invitation          | Organisation, target email, role, inviter, hashed token, expiry, acceptance/cancellation state.                                                  |
| Resource grant      | Membership or service principal, database/table target, read/edit/manage level, grant version.                                                   |
| Browser session     | User, selected organisation, expiry, last activity, last completed authentication, revocation state.                                             |
| Credential          | Password account, passkey credential, encrypted TOTP secret, hashed recovery codes.                                                              |
| API key             | Organisation, owner kind, owner user if personal, creator attribution, key hash/prefix, scopes, targets, expiry, revocation, last use.           |
| OAuth grant         | User membership, organisation, client, audience, operation scopes, resource targets, consent and revocation state.                               |
| Refresh token       | Hashed token, grant, token family, previous token, expiry, used/revoked state.                                                                   |
| Account action      | User/client/organisation, immutable requested action digest, expiry, interactive approval and consumption state.                                 |
| Account audit event | Actor, operation, target, request ID, UTC timestamp, redacted outcome.                                                                           |
| Email outbox        | Template, recipient, payload, dedupe key, attempt state, next attempt, provider result. Sensitive payloads require protected storage and expiry. |

Identity and management IDs use the same alphanumeric ID convention as other Rootset resources. Auth-library adapters must preserve it or map their internal identifiers explicitly.

## Roles and resource access

| Capability                                    | Owner                | Admin                | Editor                                   | Viewer                 |
| --------------------------------------------- | -------------------- | -------------------- | ---------------------------------------- | ---------------------- |
| Read allowed databases/tables and history     | Yes                  | Yes                  | Yes                                      | Yes                    |
| Create/edit/delete rows within edit grants    | Yes                  | Yes                  | Yes                                      | No                     |
| Create databases, manage fields/rules/indexes | Yes                  | Yes                  | Only with explicit resource manage grant | No                     |
| Run exports                                   | Yes                  | Yes                  | With read/export grant                   | With read/export grant |
| Manage backups/restores                       | Yes                  | Yes                  | No                                       | No                     |
| Invite/manage non-owner members               | Yes                  | Yes                  | No                                       | No                     |
| Manage team keys                              | Yes                  | Yes                  | No                                       | No                     |
| Change owners/delete organisation             | Yes                  | No                   | No                                       | No                     |
| Edit own profile/security/preferences         | Yes                  | Yes                  | Yes                                      | Yes                    |
| Create personal keys                          | Within own authority | Within own authority | Within own authority                     | Read scopes only       |

Read/edit/manage resource grants are inherited from organisation to database to table. Resource restrictions intersect with the organisation role; they never raise an operation beyond its role ceiling. A manage grant can give an Editor table/schema administration but cannot give organisation membership or team-key administration. Owners and Admins retain organisation-wide access in v1. Row-level and column-level access rules are deferred.

All active members can read shared data by default. Administrators can replace this default with explicit database/table grants for Editors and Viewers. Inheritance and restrictions must be visible in settings. History and export use the same resource restrictions as live values.

At least one enabled, verified Owner must remain. Owner removal, demotion, transfer, and organisation deletion lock the relevant organisation/memberships and validate that invariant under concurrency. Invitations cannot create Owners; ownership transfer is a separate step-up operation.

A successful ownership transfer promotes the selected enabled, verified member to Owner and demotes the initiating Owner to Admin in the same transaction. For example, transferring from Alice to Bob changes Alice from Owner to Admin and Bob from Editor to Owner. Other existing Owners keep their roles. Selecting the current Owner does not change that membership. The request requires recent browser authentication or an approval bound to the exact user, organisation and initiating credential/client.

## Setup and invitations

Setup is a one-time, transactional claim gated by an installation bootstrap secret available through deployment configuration. It creates the first organisation and Owner, requires email verification, and disables the bootstrap path after success. Two simultaneous setup requests cannot create competing first owners. A lost initial response can be reconciled by the setup status endpoint without revealing credentials.

Bootstrap claim and bound account-action digests use HMAC with the installation key-hash secret. Password-bearing inputs are never retained as an unkeyed digest. Migration `036_bound_digest_protocol.sql` erases earlier unkeyed digests, expires pending approval tickets and clears their protected payloads while preserving consumed outcomes. Users start a fresh action after this upgrade. Existing installations remain claimed; old-protocol setup retries return `SETUP_ALREADY_CLAIMED`, and verification can be resent through the authentication flow.

Invitation acceptance requires a valid, unexpired token, verified control of the invited email, and the correct organisation. Existing users authenticate and accept the membership. New users establish their account through the invitation flow. Tokens are single-use and stored hashed. Cancellation, inviter loss of authority, organisation suspension, and membership creation must be handled before acceptance. Replays return an intelligible terminal result without adding a second membership.

Use invite links as the normal way to add users. Administrators never choose or receive another user's permanent password. Login, signup-through-invitation, verification, password reset, and step-up screens follow Towbar's layout and interaction patterns after Rootset branding and routes are applied.

## Authentication and recovery

Use Better Auth with the PostgreSQL/Drizzle adapter, passkey and two-factor plugins, and application-owned authorisation. Preserve the reference's checks for disabled accounts, verified invitations, WebAuthn origin/RP binding, and user verification. Reuse security behavior with its regression tests.

V1 supports email/password, authenticator-app TOTP, single-use recovery codes, and passkeys. A successful user-verified passkey can complete authentication without an extra TOTP challenge; a password login for a 2FA-enabled account must complete TOTP or a recovery code before receiving a fully authenticated session. Enabling TOTP requires confirmation with a valid code. Password reset must not silently disable 2FA.

Engineering defaults are seven-day browser sessions with server-side revocation checks and a five-minute recent-authentication window for sensitive changes. Password reset/change, account disablement, and credential recovery revoke relevant sessions and delegated grants. Normal logout revokes the current browser session; "sign out everywhere" revokes all sessions and allows explicit revocation of delegated access.

Sensitive operations include changing email/password, registering/removing passkeys, disabling 2FA, rotating recovery codes, transferring ownership, creating or expanding privileged keys, changing backup credentials or installation configuration, restoring over existing data, and deleting an organisation/database/table. Browser users complete step-up. API/MCP users start the same action through an account-action ticket and finish its approval in the browser. A ticket binds the immutable request, client, user, organisation, target, and expiry. It cannot be reused for another action.

The passkey RP ID and allowed origins derive from the configured installation URL. Existing Towbar credentials and RP bindings are not copied. Challenge replay, origin mismatch, missing user verification, duplicate credential attachment, and expired challenges must fail. V1 operator recovery must work for a lost factor without printing credentials or silently adding unrestricted access.

Email change verifies the new address, preserves the old address until completion, handles email uniqueness races, revokes appropriate sessions/grants, and notifies both addresses. Rate-limit login, reset, verification, invitation acceptance, factor verification, and action approval. Error responses must not reveal whether an unrelated email has an account.

## Personal and team API keys

Personal keys belong to a user membership in exactly one organisation. Effective permissions are the intersection of the current membership, resource grants, and key scopes/targets. A demotion, membership removal, user disablement, or resource restriction takes effect on the next request; a token is not a snapshot of old authority.

Team keys belong to the organisation as service principals. They have explicit operation scopes and database/table targets. The creator is audit attribution, not the runtime owner. Leaving the organisation does not silently disable a team integration. Owners/Admins can list, rotate, and revoke these keys. A team key cannot act as a person, authenticate to the browser, manage a person's factors, or perform ownership transfer.

Keys have at least 256 bits of random secret material, a Rootset prefix, a non-secret lookup identifier, and a one-time secret display. Store only a keyed hash of the secret and redacted metadata. Never log headers, tokens, recovery codes, password material, or backup credentials. The default key expiry is 90 days; only Owners/Admins can approve a non-expiring key. Rotation creates a replacement and supports an explicitly bounded overlap before revoking the old key.

Key creation uses an idempotency key. A replay returns metadata and does not re-display the secret. If the first response was lost, the user can revoke that key and create a replacement. A delegated credential cannot mint a key with scopes/targets beyond its own authority, even if the user's browser role has broader access. Privileged key creation also requires the bound step-up action.

Expose creation, listing, rotation, and revocation through the public API and MCP subject to these rules. Unlike the Towbar reference, Rootset must not rely on a blanket browser-only prohibition for all team/key operations.

## OAuth grants

Remote MCP uses user-delegated OAuth with consent identifying the client, organisation, scopes, and databases/tables. The API can also accept audience-bound OAuth grants for registered API integrations. A token for MCP is not accepted as a REST API token, or vice versa.

Use short-lived access tokens and rotating refresh tokens. Engineering defaults are 15-minute access tokens, seven-day refresh inactivity expiry, and a 30-day absolute grant lifetime. Reuse of a rotated refresh token revokes its family. Consent revocation, user disablement, membership loss, and grant expiry prevent refresh and further access. Permission checks still evaluate current grants on every request.

OAuth clients are not team service principals. Unattended team automation uses a scoped team key in v1. The connected-apps screen lists grants and lets users revoke them; administrators can revoke an organisation's grants without gaining access to token secrets.

## Preferences and viewing

Preferences belong to the user and apply across memberships. Store a validated IANA timezone, locale, date format, time format, and theme. UTC is the fallback timezone. Never infer and persist a new timezone from an API request.

Date-time viewing and editing use the selected timezone. The editor explicitly resolves ambiguous daylight-saving times and rejects nonexistent times until corrected. Date-only values remain calendar dates. Time-only values remain UTC and show a UTC label. REST, MCP, exports, history, and backups always use the canonical UTC contract, independently of the viewing preference.

Preference changes do not mutate table values or add cell-history entries. Locale formatting must not change stored floating-point or integer values. Add preview controls so users can inspect date/time formatting before saving.

## Emails and maintenance

Adapt Towbar's React Email templates for invitation, invitation verification, account verification, reset, password change, email-change verification and notices, factor changes, team-key creation/revocation, and account recovery. Replace branding, domains, sender names, links, issuer labels, and contact copy. Keep template rendering independent of delivery.

Use a transactional outbox so a committed account action cannot lose its email merely because SMTP was unavailable. Worker retries have dedupe keys, bounded backoff, and visible failures. A reused dedupe key must not suppress a later distinct security event. SMTP/object-storage secrets are encrypted and are never returned by a read endpoint. Account deletion and organisation deletion are durable jobs with explicit confirmation, resource accounting, retention handling, and auditable terminal states.

## Towbar reuse map

Reference commit: `bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2`.

| Reference                                                                                                                                           | Reuse                                                         | Rootset adaptation                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Identity UI](https://github.com/avgeek-inc/towbar/tree/bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2/packages/identity-web-ui/src)                      | Auth frame and credential-form patterns.                      | Branding, routes, invitation/setup state, Rootset errors.                              |
| [Identity service](https://github.com/avgeek-inc/towbar/blob/bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2/apps/towbar-api/src/areas/auth/identity.ts)   | Password, passkey, TOTP, verification, session checks.        | Owner role, alphanumeric IDs, organisation selection, Rootset RP/issuer.               |
| [Access model](https://github.com/avgeek-inc/towbar/blob/bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2/packages/towbar-access/src/index.ts)              | Actor types and permission intersections.                     | Database/table grants and administrative API/MCP coverage.                             |
| [API-key service](https://github.com/avgeek-inc/towbar/blob/bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2/apps/towbar-api/src/areas/api-keys/service.ts) | Key ownership, hashes, one-time display, audit.               | Resource targets, narrower operation scopes, rotation.                                 |
| [Account emails](https://github.com/avgeek-inc/towbar/tree/bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2/packages/towbar-email/emails/account)           | Template structure and security notifications.                | All Rootset text, links, sender/issuer, delivery configuration.                        |
| [MCP OAuth](https://github.com/avgeek-inc/towbar/tree/bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2/apps/towbar-api/src/areas/mcp-oauth)                 | PKCE/resource checks, client attribution, discovery, consent. | Fine-grained scopes, short tokens, refresh rotation, complete administrative coverage. |

Copying reference code requires preserving its applicable licence and notices. The project's public-distribution licence remains a release decision. Do not create a production dependency on Towbar-specific private packages, operational services, or credentials.

## Completion evidence

The account gates are `ACC-*`, `AUTH-*`, and `KEY-*` in the [verification checklist](IMPLEMENTATION_VERIFICATION_CHECKLIST.md). They require role/resource cross-product checks, real-factor authentication, rendered auth/email review, concurrent membership transitions, and rejection checks across session, personal-key, team-key, and OAuth actors.
