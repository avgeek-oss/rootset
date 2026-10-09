# Shared account settings and passkeys

Rootset consumes Towbar's account, authentication and team patterns from
`@avgeek-oss/design-system@1.2.12`. Profile, Preferences, Email & Password,
Passkeys, Sessions, API Keys, MCP Connections and MCP Guide use the library's components and
fixed copy. The secondary sidebar contains only the current settings scope.
The application shell is mounted in the persistent Next.js root layout.
Navigating between settings, databases and table views updates the content and
breadcrumbs without remounting the header, brand or primary navigation. The
shared sidebar toggle uses the same icon in both states and a 44 px hit area.
Team details, invitation creation, member editing/removal and invitation
revocation also use shared patterns. The native `EmailChangeSettings` owns
verification status, resend cooldown, pending changes and cancellation; the
application supplies only identity operations and date formatting.

Account pages use `/settings/<page>` with Account Settings as their breadcrumb
parent. Team pages use `/team-settings/general` and `/team-settings/members`
with Team Settings as their parent. Previous team-settings links redirect to
the canonical routes. Profile details contains the shared name form in one widget. Date/time preferences keep their searchable options without
a preview or explanatory footer.

Sign-in exposes the library's verification-email action only after an
`EMAIL_NOT_VERIFIED` failure. `VerificationEmail`
uses the neutral public resend endpoint, and `InvitationVerification` supplies
the shared resend control and one-minute cooldown without replacing its copy.
Invalid invitation codes leave the draft in place and show one error toast.

Invitation creation returns a replayable URL containing the opaque invitation
ID, not a credential. The shared acceptance and email-code forms establish
recipient proof before the shared first-password form creates an account. A
valid link alone cannot set a password, create a session or grant membership.
Email codes allow five attempts and expire after ten minutes; the subsequent
password receipt is hashed, bound to the invitation and consumed once.

Public verification requests use a dedicated handler with a neutral response,
fixed login callback and no inherited session. Unknown, verified and unverified
addresses receive the same acknowledgement and a 500 ms response floor. Public
IP and normalized-email budgets apply before account eligibility; private outbox
cooldown and daily delivery limits do not reveal eligibility. The signed-in
resend route accepts only that session's email. Unverified sign-in remains denied.

Authenticator/TOTP enrollment, verification, action types and storage have been
removed. Passkey recovery codes belong to the shared first-key/replacement
ceremony. They are not a separate account settings panel. The single prelaunch
SQL baseline now stores only their hashes; existing installations with the old
baseline checksum are refused rather than silently rewritten.

## Security verification

`packages/identity/src/passkey-security.test.ts` exercises the actual identity
handler and PostgreSQL storage using signed WebAuthn registration/assertion
responses. Its authenticator creates an ECDSA key and CBOR attestation; it does
not replace the server's cryptographic verifier with a success stub.

| Behavior                                                              | Evidence                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Removed authenticator routes and action types cannot be used          | Removed-endpoints subtest expects 404 and refuses the old account action                                                                                                                                                                                                                  |
| Enrollment requires recent proof and a verified authenticator         | Registration subtest refuses stale sessions, missing user verification, wrong origin, replay and `createSession` bypass                                                                                                                                                                   |
| Password sign-in cannot issue an authenticated actor before a passkey | Pending-sign-in subtest verifies the signed password receipt has no usable browser session                                                                                                                                                                                                |
| Challenges bind the exact sign-in or existing session                 | Assertion and fresh-verification subtests refuse swapped pending/session cookies, wrong owner and concurrent replay; valid reauthentication keeps the original session ID                                                                                                                 |
| Recovery codes are protected and single-use                           | Replacement subtest checks hash-only storage, invalidation of old codes, expiry and concurrent consumption with one successful request                                                                                                                                                    |
| Recovery cannot mint credentials or approve access                    | Recovery-authority subtest checks `authenticatedAt = 0`, permits a profile read, and refuses API-key issuance, key-action approval, email/password changes, passkey enrollment/removal/replacement and password fallback; the real OAuth service refuses consent without creating a grant |
| A fresh passkey restores the intended authority                       | The same recovery-authority subtest performs a signed assertion bound to the recovery session, then completes the reviewed API-key action and OAuth consent                                                                                                                               |
| Revocation invalidates outstanding proofs                             | Revoked-session/foreign-owner subtest refuses challenges after session or access revocation                                                                                                                                                                                               |
| Recovery and member status follow actual enrollment                   | First/last-key subtest preserves codes when adding a key, removes them with the last key and verifies member status before/after enrollment and removal                                                                                                                                   |

`email-change-security.test.ts` verifies that opening/inspecting a confirmation
cannot change the account. New links hold their proof in a URL fragment; the
explicit POST consumes it once. Email update, session/key/grant revocation and
the two encrypted notices commit together. A forced notice-persistence failure
rolls back the email, authority and receipt; a later concurrent retry commits only
once. GET confirmation and foreign-origin/bearer mutations are refused.
The native `EmailConfirmation` screen inspects the proof before showing its
confirmation action, clears the URL while preserving router state, and keeps the
proof only in memory. Rendered inspection left the fixture email, pending proof,
sessions and change-notice count unchanged. A reload of the scrubbed URL shows
the shared unavailable state without submitting confirmation.
Opening a new fragment link on the same confirmation route reloads the document
for a fresh inspection, so an earlier unavailable/ready screen cannot retain the
new link's proof in the address bar or confirm the previous in-memory proof.

`email-verification.test.ts` checks real handler responses, normalized and hashed
buckets, foreign origins, API-key denial, session isolation, timing, concurrent
requests and private delivery limits. `invitation-security.test.ts` exercises
link authority, email-code expiry and attempts, invitation-bound password proof,
concurrent consumption and revocation/last-Admin eligibility before account
creation. `password-policy.test.ts` checks salted password hashing, verification and the
bounded FIFO password-work queue. Password handling has no external breach-check
service or operator tuning variables.

The human-approved rename from Editor to Member changes the role name, not its
capabilities. Role matrix tests, live-role credentials, browser guards and
invitation contracts use Admin/Member/Viewer. The fresh-install baseline was
regenerated from an isolated PostgreSQL 18 schema; repeat application and digest
refusal preserve earlier databases. No original database or volume was reset.

Common account/team/member/key name contracts and SQL columns use the same
120-character bound as the shared forms. Existing identity and contract suites
exercise trimmed/non-empty, 120 and 121-character boundaries; the baseline suite
checks the actual column types and rejects oversized SQL updates without changing
the previous value. Rootset resource naming limits remain separate.

The existing identity suite continues to cover verified-email setup and
invitations, email changes, password reset, session/key revocation, role changes,
last-Admin protection, sensitive-action expiry/replay and operator recovery.
Password reset preserves passkeys; explicit operator recovery removes passkeys
and their recovery codes and revokes delegated access.

The concurrent last-key tests pause the real recovery-code insert with a
PostgreSQL barrier and issue removal while automatic registration issuance or
replacement is pending. The replacement regression failed before the fix
because the last key disappeared before replacement committed. Both issuance
paths now lock the user and enrolled keys until commit; automatic issuance is
skipped if no key remains after locking. Removal then finishes and deletes the
codes. Both regressions pass with requests using the actual identity handler.

`apps/rootset-web/src/lib/passkeys.test.ts` separately checks the browser adapter:
cancelled option fetches cannot start a ceremony, cancelled ceremonies cannot
submit a late assertion, and cancellation ends before the server proof is
submitted. Identity confirmation uses the shared dialog, and a successful proof
retries the same reviewed operation.

## Date and time preferences

All five date formats and four clock formats use Towbar's identifiers and defaults.
The UI consumes the published React-free `utilities/date-time-preferences` catalog
and uses the native shared preference controls. A contract test compares the
library options and defaults against the backend catalog. Backend contracts and
fresh SQL constraints retain the same catalog, with explicit input/read aliases
for earlier Rootset values. Output and new storage always use canonical IDs.
`date-time-preferences.test.ts`, the cell draft suite, the actual PostgreSQL
identity suite and baseline tests cover all twenty combinations, alias conversion,
setup retry equivalence, invalid formats/timezones, DST transitions, UTC-only
preview inputs, and unchanged cell editing precision. Existing local databases
remain preserved; a changed prelaunch baseline requires a fresh installation.

## Verification scope

Run `pnpm verify` with the identity/storage fixture environment configured, then
`pnpm test:integration` and
`pnpm exec tsx packages/jobs/src/integration.ts`. The local run used real
PostgreSQL, local S3-compatible storage and Mailpit. Identity, HTTP/runtime,
storage and job suites ran without skipped tests.

The published 1.2.4 registry archive matched all 624 installed package files;
the frozen dependency install and production vulnerability audit passed. The
final local run passed 198 web, 58 identity, 349 HTTP/runtime, 40 contract and
three database tests. Storage/API/MCP integration passed 42 tests, and
job/storage/mail integration passed 37 tests.

The first final-package run retained two authenticated export-download 503
responses with `CAPACITY_LIMIT`. The unchanged artifact verifier refuses work
when the temporary filesystem cannot retain the artifact plus its 1 GiB reserve.
The failing status assertion now includes the response body for diagnosis.
Focused field-matrix verification passed all 323 tests, then the complete gate
passed with the same protections, assertions and fixture isolation. Temporary
capacity at the original failure was not sampled, so the evidence identifies
the guard that refused the downloads without attributing the space change to a
particular process.

Rendered QA covered all seven account pages plus team General and Members at
1280 px and 390 px, in light and dark themes. Checks included isolated account
navigation, the profile input focus ring, timezone selection, MCP client
configuration switching, populated API-key metadata, member identity columns
and opening/cancelling shared passkey, API-key and member dialogs. Wide tables
scroll within their own container; the page itself remains within the viewport.

Production SPA verification held only the synthetic preview user's PostgreSQL
row while saving the profile. Navigating to MCP Guide before completion showed
no late success notification; returning to Profile showed the committed value.
A database statement timeout retained the mounted draft and re-enabled Save;
the deliberate retry committed the draft with one success notification. Expiring
only the fixture's sessions and reloading returned to the native sign-in screen
without late success feedback. That expiry check used document reload rather
than claiming an automatic SPA expiry transition. The preview was signed back
in and its original display name restored.

This evidence covers the account/passkey adoption. It does not sign off the full
V1 checklist or the five-million-row performance target. Browser/OS enrollment
with a physical or synced passkey still requires a person to complete the native
authenticator prompt; server verification is covered by the signed tests above.
