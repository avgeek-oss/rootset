# Keys and account recovery

Keep `ROOTSET_SECRET` and `ROOTSET_ENCRYPTION_KEY` outside Git and logs. Preserve
protected configuration separately from database and artifact backups.

## Encryption key

`ROOTSET_ENCRYPTION_KEY` is one 32-byte key encoded as 64 hexadecimal characters.
It protects email/action payloads and stored artifacts. Keep its original value
for the lifetime of the installation and its recovery copies. A replacement
key cannot decrypt existing data. Rootset does not support a keyring or an
automatic re-encryption/rotation workflow.

Lost-key, authentication-tag and checksum failures are explicit failures. They
must never be treated as successful empty reads. Recover the original key
before resuming reads or restore.

## Application secret

`ROOTSET_SECRET` supplies initial setup access and the persistent root material
for authentication, personal-key hashing and cursor signing. Rootset derives
separate keys for those purposes internally. Preserve the same value across
restarts. Changing it can invalidate sessions, personal keys and pagination
cursors; it does not replace the encryption key.

Personal keys inherit live Admin/Member/Viewer membership. Rotation, expiry,
revocation, demotion and membership removal must affect further requests, waiting
work and replay. Keys have no operation/resource selection. OAuth retains approved
operations intersected with the person's current role; reconnecting must not
restore revoked or removed authority.

## Lost factors or lost Admin access

Use normal recovery codes first. For installation-controlled emergency recovery,
verify the person's identity through an established private process, record the
incident reason and use the retained installation configuration. The CLI requires
internal IDs and a nonempty reason; it does not establish the person's identity.

```sh
docker compose exec api node dist/operator.mjs recover USER_ID --reason "verified lost-factor recovery"
docker compose exec api node dist/operator.mjs restore-admin ORG_ID USER_ID --reason "verified Admin recovery"
```

In source development the same entry point is `pnpm auth:operator`. Load protected
configuration into that process without putting secret values in command history.
`recover` removes enrolled factors and revokes the person's sessions/credentials;
`restore-admin` restores Admin membership for a verified person in the single
organisation. There is no installation-operator binding or Owner role.

Confirm the recorded security notification is actually delivered, affected old
credentials fail and the person signs in/enrols new factors through normal flows.
A CLI exit message about queued notification does not prove email delivery.
Record the result without copying factor secrets or recovery codes into the
incident. The current checklist requires an actual isolated rehearsal of this
procedure.

If configuration/keys or PostgreSQL state itself is lost, use the
[full-installation recovery procedure](upgrade-and-recovery.md). Knowing an ID
does not authorize manual privilege expansion or direct credential edits.
