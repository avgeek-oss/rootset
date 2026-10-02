# Keys and account recovery

Keep keys outside Git and logs. Back up the key ring separately from PostgreSQL
and artifacts; a correct encrypted backup is unusable without its retained key.
All replica configurations must agree before a new key becomes active.

## Encryption key rotation

Rootset accepts `ROOTSET_ENCRYPTION_KEYS` as a JSON object mapping key IDs to
64-hex-character, 32-byte random keys. `ROOTSET_ENCRYPTION_KEY_ID` selects the
active ID. For a single-key installation, `ROOTSET_ENCRYPTION_KEY` supplies the
active key. Key IDs are stored with ciphertext; readers select the matching
retained key and must fail explicitly if it is unavailable.

1. Generate a fresh 32-byte key using approved local secret tooling. Add its ID
   to the protected key ring while retaining every key referenced by encrypted
   outbox, credential, action or artifact records.
2. Keep the old active ID initially and restart every API/worker replica with
   the expanded ring. Verify old artifact/outbox/credential reads still work.
3. Change the active ID to the new entry and restart all replicas. Create a new
   encrypted artifact and notification; verify their stored key IDs, read-back
   and isolated restore.
4. Rehearse disaster recovery with both old and new artifacts. Keep the former
   key until there is measured evidence that no retained data or recovery copy
   references it. Rootset does not silently rotate or re-encrypt all prior data.

If a key is lost, restore it from its protected recovery copy. Generating another
value with the same ID does not recover ciphertext. Record a failed decryption as
an actionable key/configuration problem, not successful empty data.

## Authentication, key hashing and cursor secrets

Preserve `ROOTSET_AUTH_SECRET`, `ROOTSET_KEY_HASH_SECRET` and
`ROOTSET_CURSOR_SECRET` across restart. Rotating them has different effects from
artifact encryption: sessions/factor protections, API-key verification and
cursor authenticity can be invalidated. Schedule a reviewed change, notify
affected users, provision replacement API keys when the hash secret changes and
verify old keys fail while new scoped keys succeed. Treat temporary loss of
access as an explicit operational outcome. Do not promise seamless rotation for
a secret that has no versioned verification ring.

## Operator binding and lost-factor recovery

Organisation Owner authority cannot bind an installation operator. The deployment
operator uses the CLI with a verified user's internal ID and a recorded reason:

```sh
docker compose exec api node dist/operator.mjs bind USER_ID --reason "approved operator binding"
docker compose exec api node dist/operator.mjs recover USER_ID --reason "verified lost-factor recovery"
docker compose exec api node dist/operator.mjs restore-owner ORG_ID USER_ID --reason "verified organisation owner recovery"
```

For source development use `pnpm auth:operator` with the same arguments and the
protected configuration loaded into the process. IDs must be Rootset ULIDs; use
an established private verification process to identify the person. The CLI
records audit and security-notification events. It does not print a password,
factor secret, API key or recovery code. Verify those events and delivery before
closing the incident.

After factor recovery, confirm affected sessions/factors are invalidated and the
user enrolls a new factor through normal interactive step-up. Confirm resource
grants and API-key scopes remain bounded. Owner recovery must not create extra
installation authority. Keep the original account and security events available
for the review.

An operator recovering their own database/configuration access uses the full
installation recovery procedure and protected keys. Knowing a user/database ID
does not authorize an unaudited database edit or grant expansion.
