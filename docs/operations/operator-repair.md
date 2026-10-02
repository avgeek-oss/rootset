# Approved operator repair

Repair uses the existing typed batch mutation operation. It does not accept SQL,
disable history triggers, bypass uniqueness, or grant an installation operator
access to a resource outside their current organisation and resource grants.
Ordinary batch mutations remain synchronous.

Use a verified personal identity with an active installation-operator binding,
`installation:manage`, and the normal `rows:write` scope and edit grant for the
target table. A team key cannot initiate a repair. The browser, personal API key,
or OAuth credential remains bound to its original principal and delegation.

1. Identify the organisation, database, table and row through the authorised API.
   Read the current schema and row revisions and retain the relevant cell-history
   IDs for the incident. Prepare at most 1,000 explicit updates, each with its
   expected row version. Repair does not create or delete rows.
2. Begin an account action using `type: "operator_repair"`,
   `operationId: "mutateRows"`, and the exact batch input. Include
   `repair: { reason: "the reviewed incident reason" }`; the trimmed reason must
   contain 1–512 characters. Record the request's idempotency key. Keep Rootset
   authentication proof and recovery codes out of the incident reason.
3. Open the returned approval URL in the verified user's browser. Authenticate
   again as required and review the exact target, reason, schema version, row
   versions and proposed business values before explicitly approving. An existing
   recent session alone does not approve repair. Field names and JSON keys such
   as `password`, `token` and `secret` remain ordinary business values in this
   typed review; authentication proof is excluded from the review envelope.
4. Submit the same batch to
   `POST /v1/orgs/{orgId}/databases/{databaseId}/tables/{tableId}/rows/batch`
   with the approved action ID in `approvalId` and an unchanged idempotency key.
   The equivalent MCP tool is `rootset_mutate_rows`. Completion of the bound
   account action can also admit the exact operation. A successful admission
   returns HTTP 202 and a job ID; it does not mean that any cell has changed.
5. Poll the returned job URL to a terminal state. The worker rechecks the current
   personal operator binding, credential, scope and edit grant before publication.
   Schema-version, row-version, validation, capacity and uniqueness failures leave
   the batch uncommitted. Changes to the target, reason, updates or approval proof
   cannot reuse an earlier admission.
6. Verify the terminal result and the authorised row and cell history. Correlate
   the `operatorRepairRequested` control event, approval ID, job ID, native
   mutation ID and `operatorRepair` completion event. The intent records the
   reason and identifiers. The completion summary records the reason and
   approval/job/mutation identifiers. Cell history contains the actual before and
   after values with the verified principal and source `operator`.

Admission records the approved action, job, intent and replay receipt in one
control transaction. The worker commits rows, revisions, normal history, native
idempotency outcome, repair completion and durable operation outcome in the same
ordinary data transaction. Recovery of an interrupted worker uses that recorded
outcome and the original mutation identity; it must not apply the update twice.
Retry an unchanged admission with its original credential, input, proof and key,
then inspect the original job. Current authority is checked before replay.

Once the ordinary row transaction commits, later cancellation or permission loss
does not reverse those cells. Recovery reports the authentic recorded outcome
without applying new row effects. Every new named admission and publication,
and every public job or action read, still requires its applicable current
authority. Reading an already consumed action's historical metadata requires
current authentication and ownership of the ticket; it does not require renewed
permission to mutate the original cells.

An incomplete, failed or cancelled job is not a completed repair. Preserve its
redacted failure, the pre-repair observations and the incident reason. Prepare a
new explicitly approved request after resolving a revision or validation problem.
Privileged direct SQL and trigger bypass are unsupported live repair procedures;
use the separate full-installation recovery runbook for installation recovery.
