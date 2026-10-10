# Security reports

Use a private GitHub vulnerability report when enabled, or an established private
channel to a repository administrator. Keep credentials, customer rows, backups,
session tokens and usable exploit credentials out of public issues.

Include the source version, affected operation and role, synthetic reproduction
steps, and observed impact. V1 is under implementation and verification; no
released version is currently designated production-supported.

## Current security boundary

An installation has one SQL-enforced organisation and three membership roles:
Admin, Member and Viewer. Admin includes installation management. Personal API
keys use live membership authority; demotion removes former permissions and
member removal or credential revocation must reject subsequent use. OAuth adds
operation consent, PKCE and token/client/audience validation. It has no database
or table selection grants.

Keep runtime PostgreSQL application, identity and DDL credentials separate from
the migration/database-owner credential. Protect sessions, factors, credential
hashing secrets and encryption keys. A retained encrypted artifact is recoverable
only with its matching key. Follow the [recovery runbooks](development/operations/README.md).

The [current checklist](rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md) requires
real denial, recovery and dependency checks. Earlier source reviews and runtime
receipts describe historical candidates; they do not certify the revised model.
