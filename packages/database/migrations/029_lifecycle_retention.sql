GRANT SELECT(id,org_id,operation,target_id,user_id,outcome,created_at) ON rootset_control.account_audit TO rootset_worker_definer;
GRANT DELETE ON rootset_control.account_audit TO rootset_worker_definer;
GRANT UPDATE(id) ON rootset_control.account_audit TO rootset_worker_definer;
GRANT SELECT(org_id,state) ON rootset_control.artifacts,rootset_control.backups TO rootset_worker_definer;
GRANT SELECT(org_id) ON rootset_control.cell_changes,rootset_control.row_events,rootset_control.resource_history,rootset_control.history_gaps,rootset_control.mutations,rootset_control.schema_operations TO rootset_worker_definer;

CREATE FUNCTION rootset_control.maintenance_org_directory() RETURNS TABLE(id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.id::text FROM rootset_control.organisations o
 WHERE o.state='active' OR EXISTS(SELECT 1 FROM rootset_control.jobs j WHERE j.org_id=o.id AND j.state IN ('queued','running'))
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
CREATE FUNCTION rootset_control.deletion_metadata(org_arg text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE deleted_at timestamptz;
BEGIN
 IF nullif(current_setting('rootset.org_id',true),'') IS DISTINCT FROM org_arg THEN
  RAISE EXCEPTION 'Organisation scope mismatch' USING ERRCODE='42501';
 END IF;
 SELECT min(a.created_at) INTO deleted_at FROM rootset_control.account_audit a
 JOIN rootset_control.organisations o ON o.id=a.org_id AND o.state='deleted'
 WHERE a.org_id=org_arg AND a.operation='deleteOrganisation' AND a.outcome->>'state'='deleted';
 RETURN jsonb_build_object('organisationDeletedAt',deleted_at);
END $$;
CREATE FUNCTION rootset_control.purge_retained_account_audit(org_arg text,before_arg timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
 IF nullif(current_setting('rootset.org_id',true),'') IS DISTINCT FROM org_arg OR before_arg>clock_timestamp() THEN
  RAISE EXCEPTION 'Invalid retention scope or cutoff' USING ERRCODE='42501';
 END IF;
 WITH covered AS (
  SELECT a.id FROM rootset_control.account_audit a
  WHERE a.org_id=org_arg AND a.created_at<before_arg AND a.operation NOT IN ('deleteAccount','deleteOrganisation')
  AND (EXISTS(SELECT 1 FROM rootset_control.account_audit marker WHERE marker.org_id=org_arg AND marker.operation='deleteAccount'
       AND marker.target_id=a.user_id AND marker.outcome->>'state'='deleted' AND marker.outcome->>'retainedActorIdentity'='true' AND marker.created_at<=before_arg)
    OR EXISTS(SELECT 1 FROM rootset_control.account_audit marker JOIN rootset_control.organisations o ON o.id=marker.org_id AND o.state='deleted'
       WHERE marker.org_id=org_arg AND marker.operation='deleteOrganisation' AND marker.outcome->>'state'='deleted' AND marker.created_at<=before_arg))
  ORDER BY a.created_at,a.id LIMIT 1000 FOR UPDATE SKIP LOCKED
 ) DELETE FROM rootset_control.account_audit a USING covered c WHERE a.id=c.id AND a.org_id=org_arg;
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
ALTER FUNCTION rootset_control.maintenance_org_directory() OWNER TO rootset_worker_definer;
ALTER FUNCTION rootset_control.deletion_metadata(text) OWNER TO rootset_worker_definer;
ALTER FUNCTION rootset_control.purge_retained_account_audit(text,timestamptz) OWNER TO rootset_worker_definer;
REVOKE ALL ON FUNCTION rootset_control.maintenance_org_directory(),rootset_control.deletion_metadata(text),rootset_control.purge_retained_account_audit(text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.maintenance_org_directory(),rootset_control.deletion_metadata(text),rootset_control.purge_retained_account_audit(text,timestamptz) TO rootset_ddl;
