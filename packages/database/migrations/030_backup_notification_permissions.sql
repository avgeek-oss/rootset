-- Identity email delivery resolves only a scoped backup's terminal state and
-- original requester. The existing organisation policies remain enforced.
GRANT SELECT(id,org_id,database_id,job_id,state,verified_at) ON rootset_control.backups TO rootset_identity;
GRANT SELECT(id,org_id,actor) ON rootset_control.jobs TO rootset_identity;
