# Security reports

Use a private GitHub vulnerability report for this repository when that feature
is enabled, or contact a repository administrator through an established private
channel. Do not put credentials, customer rows, backups, session tokens or working
exploit credentials in a public issue.

Include the candidate commit, installation version, affected operation and role,
reproduction steps using synthetic data, and the observed impact. The maintainer
will confirm the report privately and arrange a fix and verification evidence.

Rootset v1 is under implementation and verification. No released version is
currently designated production-supported. The architecture checklist defines
the required isolation, authentication, recovery and dependency checks; a pending
gate is not an assurance that the corresponding control has passed.

Keep PostgreSQL owner credentials restricted to migrations and operator recovery.
Application, identity and DDL roles have distinct credentials. Preserve encryption
keys with protected recovery copies; deleting a retired key can make retained
artifacts or credentials unrecoverable. Follow the [operations runbooks](docs/operations/README.md).
