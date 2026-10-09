# Accounts and installation

An installation has exactly one organisation. The baseline enforces this with a
SQL singleton constraint, and setup claims the first Admin and organisation
atomically. Invitations add people to that organisation; there is no selector
or organisation creation/deletion workflow after setup.

Public authentication uses the published shared auth layouts and forms. Setup
first collects Rootset's installation secret, then uses `TeamSetup` for the team,
admin account and date/time preferences. The server validates the secret and
preferences before claiming setup, and saves the initial preferences in the same
transaction as the account and organisation. An identical retry reconciles the
original claim; changed account details or preferences cannot claim it again.

Password reset uses the shared confirmation form and removes the reset token
from the browser URL after success. Rootset retains verified-email invitations
and binds published shared forms to those protocols. Invitation and account email verification remain required. Sign-in and sensitive-action confirmation use Towbar's passkey workflow.

The prelaunch Editor role is now called Member, with identical permissions.
Membership stores a user and one role: `admin`, `member` or `viewer`. A present
membership grants access; removing it removes access. There is no active-member
flag or deleted-account lifecycle. Preserve actor references needed to interpret
row/cell history when membership is removed.

Profile, team, member, passkey and personal-key names follow the shared Towbar
forms: trimmed, non-empty names with a 120-character maximum. The public account
contracts, identity service and fresh SQL baseline enforce that limit. Email
addresses are normalized and capped at 320 characters; resource names retain
their separate Rootset limits.

## Roles

| Capability                                                 | Admin | Member | Viewer |
| ---------------------------------------------------------- | ----- | ------ | ------ |
| Read tables and history; export readable data              | Yes   | Yes    | Yes    |
| Create, edit and delete rows                               | Yes   | Yes    | No     |
| Manage databases, schema and uniqueness                    | Yes   | No     | No     |
| Invite people and change/remove memberships                | Yes   | No     | No     |
| Manage own profile, factors, preferences and personal keys | Yes   | Yes    | Yes    |

Protect the last Admin from removal or demotion that would leave the installation
without administration. Role changes and removals must take effect on browser,
REST, MCP, job admission/publication and replay. Installation management does not
require another role or binding flag.

Team settings use the shared member table, member-edit dialog and invitation
table. Member edits can change a name, a role or both, with the membership
version checked before either write. Last-Admin checks, current Admin authority
and removal revocation remain server-side. The Admin-only member response
includes a passkey-enrollment flag. The shared security column is labelled Passkeys; the existing `twoFactorEnabled` response field means registered passkeys, with no authenticator-code capability.

Members and pending invitations use cursor pagination. The invitation API accepts
an optional state filter and computes expired state on the server. The UI also
refreshes at the next expiry and on focus, so an expired invitation cannot stay
actionable merely because the page remains open. Invitation creation returns an ID-based link that can be copied from the shared
invite dialog. The ID is a locator, not email proof or password authority; list
responses retain only metadata. A new recipient requests a six-digit email code,
then submits their name and code using the shared verification form. The code is
hashed at rest, expires after ten minutes and permits five failed attempts.
Successful proof issues a hashed, invitation-bound, single-use ten-minute password
receipt. The shared first-password form consumes that receipt and creates the
verified account, credential and membership atomically. Existing accounts sign in
with the matching verified email before accepting. Expiry, revocation or loss of
the inviter's Admin role blocks acceptance and new-account creation. Delivery
payloads remain encrypted.

## Authentication

Keep verified email/password sign-in, password reset, passkeys, passkey recovery codes and session management. There is no authenticator/TOTP plugin, setup secret, verification endpoint, database table or action type. Setup/invitation/reset/factor tokens
are bounded, single-use and protected at rest. Rate-limit authentication and
approval attempts; errors must not reveal unrelated account existence.

Passwords contain 15–1,024 characters and use salted credential hashes.
Hash/verify work shares a fixed bounded FIFO gate: two active operations and
sixteen waiting. Overflow returns a retryable 503. There is no external password
breach lookup or installation setting for password-work concurrency.

Public resend takes only a normalized email and returns a neutral acknowledgement
for unknown, verified and unverified accounts, with a common 500 ms response
floor. It inherits no session and fixes the callback to the configured login
route. Apply IP 20/minute, email 1/minute and email 5/24-hour budgets to every
request before checking eligibility. Hash rate-limit identifiers at rest. Private
outbox limits permit no more than one delivery/minute and five/24 hours and stay
hidden from the public response. The signed-in resend route requires the session's
exact email and fixes its callback to Email & Password. Unverified password
sign-in does not issue a session or trigger an automatic email.

Once a user registers a passkey, successful password verification creates a bounded pending sign-in instead of a usable session. The second step requires a cryptographically verified passkey with user verification. Its challenge binds the exact pending sign-in and user. Direct passkey sign-in remains supported. Reauthentication binds the exact existing session, keeps its identifier and updates only its fresh-proof timestamp; password-only reauthentication is refused for an account with passkeys.

The first passkey returns ten random recovery codes once. Only SHA-256 hashes of their normalized 128-bit values are stored in `auth_recovery_codes`. A recovery code completes a pending password sign-in and is consumed atomically with that pending proof, so concurrent attempts cannot both succeed. A recovery-created session has no fresh-proof timestamp: read access remains available, but key issuance, credential changes, passkey management and approval require an actual passkey assertion bound to that session. Adding another passkey preserves codes; replacement invalidates the previous set; removing the last key removes its codes. Password reset preserves passkeys. Access revocation invalidates pending sign-in and bound challenge receipts. Explicit host-authorized operator recovery removes passkeys/codes and revokes sessions and delegated credentials.

Sensitive account changes, credential changes and
destructive schema changes require current authentication and explicit approval of the
intended action. A cached session or old approval cannot approve a changed
request. Changes to email verify the new address and handle uniqueness races;
revocation invalidates affected sessions and grants. Email-change links hold
proof in a URL fragment; opening the page only inspects it. An explicit shared
confirmation button submits the proof. Email update, session/key/grant revocation
and both encrypted notices are atomic; failure preserves the previous email,
authority and usable proof.

## Personal API keys

A key belongs to a person and has a name, protected secret hash, creation/expiry
and revocation metadata. Show the random secret once and retain only its keyed
hash and redacted metadata. The default expiry remains 90 days; an Admin can
approve a non-expiring key. Rotation uses a bounded overlap before revocation.

Keys inherit the person's current role across this installation. They do not
contain selected operations or database/table whitelists. An Admin key loses
Admin permissions when its person becomes Member or Viewer. A removed person,
expired key or revoked key cannot read, mutate or recover a previously cached
response using that credential. Every person manages their own personal keys;
there are no team/service keys.

## OAuth and MCP

An OAuth connection belongs to the person who grants consent. PKCE, exact
redirects, issuer/audience/resource binding, single-use codes and rotating refresh
tokens remain required. Here resource binding identifies the MCP server URL; it
does not select databases or tables.

Consent approves operations. Effective access is the intersection of those
operations and the person's current role. Demotion, membership removal and
revocation apply to existing access/refresh tokens and waiting work. The consent
screen has no database/table chooser. Approving OAuth/MCP access requires recent authentication; a recovery code cannot grant this proof. The native identity-confirmation dialog completes bound passkey proof and retries the same reviewed request.

## Preferences and history

Display formats use the same identifiers and defaults as Towbar: `day-short-month-year`,
`short-month-day-year`, `year-month-day`, `day-month-year`, `month-day-year`;
and `24-hour`, `12-hour`, `24-hour-seconds`, `12-hour-seconds`. New accounts default
to `day-short-month-year`, `24-hour`, and `UTC`. The public and internal preference
operations accept the earlier `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `24h` and
`12h` aliases and return/store their canonical equivalents. Reading earlier values
also normalizes them without modifying the database on a read. Fresh SQL storage
accepts only canonical identifiers. Preference aliases do not alter domain DATE,
UTC TIME or UTC DATETIME values, editor precision, or API wire representations.

People can set an IANA timezone, locale, date/time format and theme. UTC is the
fallback. Date-time displays and edits use the selected timezone; resolve DST
ambiguities explicitly. Date-only values remain calendar dates and time-only
values remain labelled UTC. Preference changes do not mutate cells or history.

The account page and navigation are called **Preferences**, matching Towbar and
Mill. Reuse Towbar's Date and time form: paired date/time format selectors, a
searchable Time zone selector with UTC offsets, a live formatting preview and
Save. Show example values for Rootset's supported formats. Keep appearance in
the shared header control; retain locale in the preference API without a separate
free-text field in this form. Saving date/time settings patches only those three
values, preserving the user's current locale and appearance.

Cell/row and schema history retain the responsible person's identity and
credential/client attribution without secrets. V1 has no organisation-wide audit
browser or organisation audit resource. Keep the security/recovery records needed
to verify authentication and operations, without inventing another product area.

SMTP and S3-compatible storage settings belong to the deployment `.env` file.
There is no UI/API configuration override or test-email action. Apply provider
changes by restarting API and worker; Deployment readiness validates dependencies separately.

## Account settings pages

Reuse the current Towbar account sidebar, page titles, wording and HeroUI
components. Each route has only its account navigation, even if the URL still
contains a previous database or table identifier.

| Group     | Page             | Route                      | Content                                                                                                                |
| --------- | ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Account   | Profile          | `/settings/profile`        | Appearance, linked Gravatar image and Your Name with Save                                                              |
| Account   | Preferences      | `/settings/preferences`    | Towbar Date and time form, supported format selectors, Time zone, preview and Save                                     |
| Security  | Email & Password | `/settings/email-password` | Current email verification status, confirmed email change with pending/cancel controls, and password confirmation form |
| Security  | Passkeys         | `/settings/passkeys`       | Shared PasskeySettings add/rename/remove flows and one-time passkey recovery-code saving/replacement                   |
| Security  | Sessions         | `/settings/sessions`       | Towbar session table; current browser identified with its Revoke button disabled                                       |
| API & MCP | API Keys         | `/settings/api-keys`       | Personal keys table and MCP Connections table; creation/expiry and one-time secret modal; role-inherited permissions   |
| API & MCP | MCP Guide        | `/settings/mcp`            | Towbar client selector, client configuration code blocks, copy controls and OAuth connection instructions              |

Legacy `/settings/security` and `/settings/2fa` links resolve to Passkeys; keys/connections aliases resolve to API Keys. Account pages consume published `ProfileImageSettings`, `ProfileSettings`, `EmailChangeSettings`, `PasswordChangeSettings`, `PasskeySettings`, `SessionsSettings`, and the shared API/MCP patterns. Shared labels, dialogs and fixed copy stay in the library. Recovery-code saving belongs to the passkey ceremony, with no separate recovery-code administration panel.

Sensitive operations continue to use Rootset's immutable approval checks. The browser verifies the matching server ticket before approving and completing it. Identity confirmation uses the shared `ConfirmIdentityDialog`: password for an account without passkeys, or an abortable passkey request for an enrolled account. Cancellation cannot continue into the mutation. Delete and operator repair keep their separate explicit review.

The browser-only `/v1/auth/email-change` GET/DELETE endpoint reads or cancels only
the signed-in user's pending confirmation. Cancellation invalidates its token and
expires unsent outbox work. Cross-origin mutations and bearer-key requests are
rejected. These controls reuse the existing email-change table and add no schema.
