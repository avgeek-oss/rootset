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
and authenticator challenges; the app binds the shared forms to those protocols.
It does not substitute Towbar's invitation email-code protocol or passkey policy.

Membership stores a user and one role: `admin`, `editor` or `viewer`. A present
membership grants access; removing it removes access. There is no active-member
flag or deleted-account lifecycle. Preserve actor references needed to interpret
row/cell history when membership is removed.

## Roles

| Capability                                                 | Admin | Editor | Viewer |
| ---------------------------------------------------------- | ----- | ------ | ------ |
| Read tables and history; export readable data              | Yes   | Yes    | Yes    |
| Create, edit and delete rows; import data                  | Yes   | Yes    | No     |
| Manage databases, schema, uniqueness and indexes           | Yes   | No     | No     |
| Manage backups and restores                                | Yes   | No     | No     |
| Invite people and change/remove memberships                | Yes   | No     | No     |
| View installation health                                   | Yes   | No     | No     |
| Manage own profile, factors, preferences and personal keys | Yes   | Yes    | Yes    |

Protect the last Admin from removal or demotion that would leave the installation
without administration. Role changes and removals must take effect on browser,
REST, MCP, job admission/publication and replay. Installation management does not
require another role or binding flag.

Team settings use the shared member table, member-edit dialog and invitation
table. Member edits can change a name, a role or both, with the membership
version checked before either write. Last-Admin checks, current Admin authority
and removal revocation remain server-side. The Admin-only member response
includes the actual authenticator two-factor flag; the UI does not infer it from
passkey enrollment.

Members and pending invitations use cursor pagination. The invitation API accepts
an optional state filter and computes expired state on the server. The UI also
refreshes at the next expiry and on focus, so an expired invitation cannot stay
actionable merely because the page remains open. Invitations retain Rootset's
email-proof protocol: tokens are hashed and delivery payloads encrypted, and list
responses do not disclose invitation links.

## Authentication

Keep verified email/password sign-in, password reset, passkeys, authenticator
2FA, recovery codes and session management. Setup/invitation/reset/factor tokens
are bounded, single-use and protected at rest. Rate-limit authentication and
approval attempts; errors must not reveal unrelated account existence.

Sensitive account changes, credential changes and
replacement restore require current authentication and explicit approval of the
intended action. A cached session or old approval cannot approve a changed
request. Changes to email verify the new address and handle uniqueness races;
revocation invalidates affected sessions and grants.

## Personal API keys

A key belongs to a person and has a name, protected secret hash, creation/expiry
and revocation metadata. Show the random secret once and retain only its keyed
hash and redacted metadata. The default expiry remains 90 days; an Admin can
approve a non-expiring key. Rotation uses a bounded overlap before revocation.

Keys inherit the person's current role across this installation. They do not
contain selected operations or database/table whitelists. An Admin key loses
Admin permissions when its person becomes Editor or Viewer. A removed person,
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
screen has no database/table chooser.

## Preferences and history

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
changes by restarting API and worker; Admin views read-only installation health.

## Account settings pages

Reuse the current Towbar account sidebar, page titles, wording and HeroUI
components. Each route has only its account navigation, even if the URL still
contains a previous database or table identifier.

| Group     | Page             | Route                      | Content                                                                                                                |
| --------- | ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Account   | Profile          | `/settings/profile`        | Appearance, linked Gravatar image and Full name with Update                                                            |
| Account   | Preferences      | `/settings/preferences`    | Towbar Date and time form, supported format selectors, Time zone, preview and Save                                     |
| Security  | Email & Password | `/settings/email-password` | Current email verification status, confirmed email change with pending/cancel controls, and password confirmation form |
| Security  | Two-factor Auth  | `/settings/2fa`            | Authenticator status, QR/setup-key enrollment, code confirmation, disabling MFA, and passkey add/rename/remove dialogs |
| Security  | Sessions         | `/settings/sessions`       | Towbar session table; current browser identified with its Revoke button disabled                                       |
| API & MCP | API Keys         | `/settings/api-keys`       | Personal keys table and MCP Connections table; creation/expiry and one-time secret modal; role-inherited permissions   |
| API & MCP | MCP Guide        | `/settings/mcp`            | Towbar client selector, client configuration code blocks, copy controls and OAuth connection instructions              |

Legacy `/settings/security`, `/settings/keys` and `/settings/connections` links
resolve to Two-factor Auth or API Keys. Recovery-code controls and generated-code
panels are absent from account settings; authentication recovery primitives remain
available to the existing server/operator recovery workflow. Sensitive operations
continue to use Rootset's immutable approval checks. Account form submissions
express the action intent; the browser checks the matching server ticket before
approving and completing it. When identity confirmation is required, use Towbar's
compact "Confirm it’s you" password/authenticator dialog. Restore, delete and
operator repair actions retain their separate explicit review. Authenticator enable/disable
passes the password only between the approval dialog and the identity client in
memory; it is not written to preferences or persisted browser storage.

The browser-only `/v1/auth/email-change` GET/DELETE endpoint reads or cancels only
the signed-in user's pending confirmation. Cancellation invalidates its token and
expires unsent outbox work. Cross-origin mutations and bearer-key requests are
rejected. These controls reuse the existing email-change table and add no schema.
