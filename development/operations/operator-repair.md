# Admin data correction

Use typed row mutations to correct data. They retain validation, uniqueness,
expected schema/row revisions and cell history.

An Admin can submit a correction directly. There are no account-action tickets
or approval pages. Personal keys need Administrative permissions, and OAuth
connections must consent to the operation scopes. Team keys cannot use operations
that require a personal identity.

1. Read the current table schema and row revisions.
2. Prepare up to 1,000 typed updates and a short correction reason.
3. Submit `mutateRows` with `repair: { reason }` and an idempotency key.
4. Wait for the returned job to finish, then check the values and cell history.

The worker rechecks current permissions before committing. A validation error,
conflict, cancellation or revoked credential cannot publish a partial correction.
Retrying the same request with the same idempotency key does not repeat changes.
Ordinary row edits keep their usual Edit permission requirement.
