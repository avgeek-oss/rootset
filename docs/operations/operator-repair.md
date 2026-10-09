# Admin data correction

Use typed row mutations to correct data. They retain validation, uniqueness,
expected schema/row revisions and cell history. Direct SQL, trigger bypass and
manual history edits are unsupported live correction procedures.

An Admin has installation management permission through their current membership.
There is no operator binding flag, separate Owner role or resource grant. Team keys cannot approve personal repair actions.
A personal key also requires Administrative permissions; an OAuth connection must also have the
needed operation consent. Sensitive correction approval remains bound to the
exact action rather than a recent session alone.

1. Identify the database/table/rows through the supported API or browser. Read the
   current schema and row revisions. Prepare at most 1,000 explicit updates and
   retain the relevant existing history IDs for the incident.
2. Review proposed typed values, expected revisions and a bounded incident reason.
   Use the current generated operation's approval flow for a privileged correction;
   keep authentication proof and recovery codes out of the reason/business payload.
3. Submit the unchanged approved request with its idempotency key. Check whether
   the operation completed synchronously or admitted a job; an accepted job does
   not mean the cells changed. If queued, wait for its truthful terminal state.
4. Verify committed values, revisions, typed before/after history, actor and UTC
   time. A validation/conflict/cancellation failure must not publish a partial
   repair as successful. Retrying a committed request must not repeat effects.

Live role, credential validity and OAuth consent are rechecked before effects and
replay. Demotion/removal/revocation must block waiting corrections. Ordinary row
edits retain their usual permissions; the correction path cannot bypass them.

Preserve the original rows/history and incident record for review. Broader damage
or lost state belongs in [recovery](upgrade-and-recovery.md), with a separate
validated target before cutover. This guide describes required behavior, not a
claim that current correction/recovery checks have passed.
