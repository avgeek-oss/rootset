-- Suspension does not erase a completed account-deletion retention authority.
-- The worker discovers only organisation IDs; scoped purge still checks the
-- permanent marker and configured cutoff inside its organisation transaction.
CREATE OR REPLACE FUNCTION rootset_control.maintenance_org_directory() RETURNS TABLE(id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id::text FROM rootset_control.organisations o
 WHERE o.state='active' OR EXISTS(SELECT 1 FROM rootset_control.jobs j WHERE j.org_id=o.id AND j.state IN ('queued','running'))
 OR EXISTS(
   SELECT 1 FROM rootset_control.account_audit event
   WHERE event.org_id=o.id AND event.operation NOT IN ('deleteAccount','deleteOrganisation')
   AND EXISTS(
     SELECT 1 FROM rootset_control.account_audit marker
     WHERE marker.org_id=o.id AND marker.operation='deleteAccount'
       AND marker.target_id=event.user_id
       AND marker.outcome->>'state'='deleted'
       AND marker.outcome->>'retainedActorIdentity'='true'
       AND marker.created_at<=clock_timestamp()
   )
 )
 OR (o.state='deleted' AND (
   EXISTS(SELECT 1 FROM rootset_control.artifacts a WHERE a.org_id=o.id AND a.state<>'deleted')
   OR EXISTS(SELECT 1 FROM rootset_control.backups b WHERE b.org_id=o.id AND b.state<>'deleted')
   OR EXISTS(SELECT 1 FROM rootset_control.cell_changes h WHERE h.org_id=o.id)
   OR EXISTS(SELECT 1 FROM rootset_control.row_events h WHERE h.org_id=o.id)
   OR EXISTS(SELECT 1 FROM rootset_control.resource_history h WHERE h.org_id=o.id)
   OR EXISTS(SELECT 1 FROM rootset_control.history_gaps h WHERE h.org_id=o.id)
   OR EXISTS(SELECT 1 FROM rootset_control.mutations h WHERE h.org_id=o.id)
   OR EXISTS(SELECT 1 FROM rootset_control.schema_operations h WHERE h.org_id=o.id)
   OR EXISTS(SELECT 1 FROM rootset_control.account_audit h WHERE h.org_id=o.id AND h.operation NOT IN ('deleteAccount','deleteOrganisation'))
 ))
$$;
ALTER FUNCTION rootset_control.maintenance_org_directory() OWNER TO rootset_worker_definer;
REVOKE ALL ON FUNCTION rootset_control.maintenance_org_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.maintenance_org_directory() TO rootset_ddl;
