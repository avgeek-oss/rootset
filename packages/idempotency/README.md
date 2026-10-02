# Control mutation replay journal

Account, installation configuration, synchronous job controls and queued job admission share a PostgreSQL receipt with their
effects. `runMutation` requires an active transaction and the organisation RLS
context. A failed operation rolls back the receipt and its effects together.
Concurrent identical callers wait at most two seconds for the receipt; contention
returns a retryable dependency error rather than publishing another effect.

The receipt key binds the organisation, principal kind and ID, user, credential,
client and operation. HMACs protect the supplied idempotency key and canonical
input, including password-bearing account-action input. Raw inputs and raw
idempotency keys are never stored. Keep the installation's key-hash secret stable
across restart and disaster recovery; it is distinct from the rotatable protected
payload encryption keyring.

Equivalent input returns the same stored JSON outcome. Reusing a key with changed
input returns `IDEMPOTENCY_CONFLICT`. Top-level approval identifiers do not change
the business input digest. The caller must check the current credential,
membership, scope and target authority before `lookupMutation` or `runMutation`;
the receipt itself grants no authority. Initial and replayed responses must satisfy
the operation's strict output schema.

Receipts expire after 24 hours. An expired receipt can be replaced by a new request
under the same key; an unexpired receipt cannot. Durable job identities retain
their separate lifetime journal. Key issuance/rotation and account-action
completion retain their existing secret-handling journals. Generic outcomes remove
explicit password, token, key-secret, TOTP and recovery-code fields while retaining
ordinary domain error codes and public credential identifiers. A stored receipt
never redisplays a one-time secret.

The real PostgreSQL tests exercise concurrent publication, changed-input conflict,
RLS and principal bindings, password privacy, rollback, bounded contention,
autocommit rejection and expiry. The identity tests additionally use real
email-verified accounts and sessions to check invitation/action deduplication and
revoked-session replay denial. Transport tests exercise REST and MCP separately.
