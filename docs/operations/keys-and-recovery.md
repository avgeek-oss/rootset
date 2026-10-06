# Keys and account recovery

Keep secrets outside Git and logs. Protect the encryption-key ring separately
from PostgreSQL/artifacts; a valid encrypted backup is unusable without its key.
Keep retained configuration and recovery copies under the same protection.

## Encryption keys

`ROOTSET_ENCRYPTION_KEYS` maps key IDs to 64 hexadecimal characters (32 random
bytes). `ROOTSET_ENCRYPTION_KEY_ID` selects the active entry. A single-key
configuration can use `ROOTSET_ENCRYPTION_KEY`. Ciphertext stores its key ID;
readers must fail explicitly when the matching retained key is unavailable.

1. Generate a new key with local secret tooling and a new ID. Add it to the
   protected ring without removing keys referenced by data or recovery copies.
2. Keep the old active ID while every API/worker replica receives the expanded
   ring. Verify old encrypted records/artifacts still read correctly.
3. Select the new active ID on every replica. Create and read back a new encrypted
   artifact, then verify isolated restore of both old and new artifacts.
4. Retain the old key until measured inventory and recovery retention show no
   remaining reference. Rotation does not automatically re-encrypt old data.

If a key is lost, recover its original value. A different value with the same ID
cannot decrypt old ciphertext. Missing-key/decryption failures are explicit
operational failures, never successful empty reads.

## Authentication and key-hash secrets

Preserve `ROOTSET_AUTH_SECRET`, `ROOTSET_KEY_HASH_SECRET` and
`ROOTSET_CURSOR_SECRET` across restart. Changing them can invalidate sessions/
factors, personal-key verification or cursors. Plan the resulting access changes,
provide replacement personal keys if needed and verify old/new behavior. Do not
promise seamless rotation where there is no versioned verification ring.

Personal keys inherit live Admin/Editor/Viewer membership. Rotation, expiry,
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
