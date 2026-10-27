# Security reports

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/avgeek-oss/rootset/security/advisories/new).
If private reporting is unavailable, contact [support@avgeek.ltd](mailto:support@avgeek.ltd)
to arrange a private report. Do not post exploit details or credentials in public issues.

Include the Rootset version or commit, affected operation and role, synthetic
reproduction steps, and observed impact. Keep customer records, backups,
session tokens and usable credentials out of the report. Use synthetic data
and redact secrets from logs and screenshots.

## Security boundaries

An installation has one organisation and three membership roles: Admin, Member
and Viewer. Workspace membership limits access without changing those roles.
Default is shared; private workspaces require explicit membership even for admins.
Workspace API keys are restricted to their workspace. Admin includes installation management. Personal API keys use live
membership authority and their configured permission ceiling. OAuth additionally
limits operations through consent and validates PKCE, clients and token audiences.

Migrations, API and worker use one ordinary PostgreSQL database owner through
`ROOTSET_DATABASE_URL`. It must not have superuser or `BYPASSRLS` privileges.
The database owner can alter schemas and policies; its credentials are trusted
operator credentials, not an end-user SQL interface.

Protect the application secret, sessions, credentials and encryption key. An
encrypted backup requires its matching key to restore. Keep the database, worker
and storage administration interfaces private and expose the UI and API through
HTTPS. Follow the [security guide](https://www.rootset.app/self-hosting/security)
and [backup and recovery guide](https://www.rootset.app/self-hosting/backup).
