CREATE TABLE rootset_control.operation_outcomes (
  job_id varchar(26) PRIMARY KEY REFERENCES rootset_control.jobs(id),
  org_id varchar(26) NOT NULL,
  operation_id text NOT NULL,
  job_input_digest text NOT NULL,
  result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rootset_control.operation_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.operation_outcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_boundary ON rootset_control.operation_outcomes USING(org_id=current_setting('rootset.org_id',true)) WITH CHECK(org_id=current_setting('rootset.org_id',true));
GRANT SELECT,INSERT ON rootset_control.operation_outcomes TO rootset_app,rootset_ddl,rootset_identity;
CREATE OR REPLACE FUNCTION rootset_control.worker_org_directory() RETURNS TABLE(id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,rootset_control AS $$
  SELECT o.id::text FROM rootset_control.organisations o
  WHERE o.state='active' OR EXISTS (
    SELECT 1 FROM rootset_control.jobs j WHERE j.org_id=o.id AND j.state IN ('queued','running')
  )
$$;
REVOKE ALL ON FUNCTION rootset_control.worker_org_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.worker_org_directory() TO rootset_ddl;
