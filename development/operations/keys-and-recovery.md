# Keys and account recovery

Keep `ROOTSET_SECRET` and `ROOTSET_ENCRYPTION_KEY` outside Git and logs. Preserve
protected configuration separately from database and artifact backups.

## Encryption key

`ROOTSET_ENCRYPTION_KEY` is one 32-byte key encoded as 64 hexadecimal characters.
It protects email payloads and stored artifacts. Keep its original value
for the lifetime of the installation and its recovery copies. A replacement
key cannot decrypt existing data. Rootset does not support a keyring or an
automatic re-encryption/rotation workflow.

Lost-key, authentication-tag and checksum failures are explicit failures. They
must never be treated as successful empty reads. Recover the original key
before resuming artifact reads.

## Application secret

`ROOTSET_SECRET` supplies initial setup access and the persistent root material
for authentication, API-key hashing and cursor signing. Rootset derives
separate keys for those purposes internally. Preserve the same value across
restarts. Changing it can invalidate sessions, API keys and pagination
cursors; it does not replace the encryption key.

Personal API keys require a name, permissions and expiry. Choose Read-only for
viewing data and history, Edit for row writes and creating/editing databases, tables and fields, or Administrative for deleting databases/tables and team management. The UI offers 30 days, 90 days, 1 year and Never
(for administrators). API/MCP creation requires `access` (`read` or `edit`),
`includeAdmin` (true only for Administrative with edit access), and `expiresAt`
(an ISO timestamp or null for Never).

Each key's issued permission ceiling is intersected with live Admin/Member/Viewer
membership. A promotion never upgrades a Read-only or Edit key to Administrative.
Rotation preserves permissions and expiry unless explicitly changed. Revocation,
expiry, demotion and membership removal affect new requests, waiting work and
replay. Restricted keys cannot create more powerful keys or OAuth grants.
OAuth retains approved operations intersected with the person's current role;
reconnecting cannot restore revoked or removed authority.

## Team API keys

Administrators create and revoke team API keys under **Team Settings → API Keys**.
Team keys use the same required name, Read-only/Edit/Administrative permissions
and expiry choices as personal keys. Their secret appears only once.

A team key belongs to the workspace, with no user-account owner. It continues
working if its creator is demoted or leaves. Any current administrator can list,
rotate or revoke it. Rotation preserves its permissions and expiry unless changed.
Team keys cannot access personal profiles, security settings, personal keys or
OAuth consent, and cannot create or manage credentials. REST and MCP apply the
same permission ceiling; revocation and expiry invalidate new requests and
waiting jobs. Use personal keys when automation should follow a person's live
membership, and team keys for shared integrations.

Team-key management uses `listTeamKeys`, `createTeamKey`, `rotateTeamKey` and
`revokeTeamKey` at `/v1/orgs/{orgId}/keys`. Creation and rotation require an
`Idempotency-Key`, and their secrets are omitted from replayed results. A team
key can authenticate to the public `/mcp` endpoint with `Authorization: Bearer`.
