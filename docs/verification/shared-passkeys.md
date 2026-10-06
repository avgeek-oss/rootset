# Shared account settings and passkeys

Rootset consumes Towbar's account, authentication and team patterns from
`@avgeek-oss/design-system@1.2.1`. Profile, Preferences, Email & Password,
Passkeys, Sessions, API Keys and MCP Guide use the library's components and
fixed copy. The secondary sidebar contains only the current settings scope.
Team details, member editing/removal and invitation revocation also use shared
patterns. Rootset retains its email-delivered invitation protocol because the
shared invitation-creation dialog requires a returned invitation URL; Rootset's
list and creation responses do not disclose that token.

The published SignIn pattern has no resend-verification action or link. Rootset
retains `/verification` and `/verify-email` for direct use, but they are not
discoverable from that shared form. A correct password sign-in for an unverified
account queues an account-verification email and returns `EMAIL_NOT_VERIFIED`
without granting a session; the real identity setup test verifies that behavior.
Delivery still requires the configured SMTP worker. This is a discoverability
limitation of the current shared component, not full authentication-flow parity.

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

## Verification scope

Run `pnpm verify` with the identity/storage fixture environment configured, then
`pnpm test:integration` and
`pnpm exec tsx packages/jobs/src/integration.ts`. The local run used real
PostgreSQL, local S3-compatible storage and Mailpit. Identity, HTTP/runtime,
storage and job suites ran without skipped tests.

Rendered QA covered all seven account pages plus team General and Members at
1280 px and 390 px, in light and dark themes. Checks included isolated account
navigation, the profile input focus ring, timezone selection, MCP client
configuration switching, populated API-key metadata, member identity columns
and opening/cancelling shared passkey, API-key and member dialogs. Wide tables
scroll within their own container; the page itself remains within the viewport.

This evidence covers the account/passkey adoption. It does not sign off the full
V1 checklist or the five-million-row performance target. Browser/OS enrollment
with a physical or synced passkey still requires a person to complete the native
authenticator prompt; server verification is covered by the signed tests above.
