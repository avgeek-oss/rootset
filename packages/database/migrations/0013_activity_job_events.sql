CREATE TABLE rootset_control.activity_job_events (
  id varchar(26) PRIMARY KEY DEFAULT rootset_control.new_ulid(),
  org_id varchar(26) NOT NULL,
  job_id char(26) NOT NULL REFERENCES rootset_control.jobs(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('queued','succeeded','failed','cancelled','partially_completed')),
  attempt integer NOT NULL CHECK (attempt>=0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE rootset_control.activity_job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.activity_job_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.activity_job_events
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));
CREATE INDEX activity_jobs_time ON rootset_control.activity_job_events(org_id,occurred_at DESC,id DESC);
CREATE INDEX activity_jobs_job ON rootset_control.activity_job_events(org_id,job_id);

CREATE FUNCTION rootset_control.record_job_activity() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog,rootset_control AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF NEW.state IN ('queued','succeeded','failed','cancelled','partially_completed') THEN
    INSERT INTO rootset_control.activity_job_events(org_id,job_id,state,attempt,occurred_at)
      VALUES(NEW.org_id,NEW.id,NEW.state,NEW.attempt,
        CASE WHEN TG_OP='INSERT' THEN coalesce(NEW.completed_at,NEW.created_at) ELSE clock_timestamp() END);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_activity AFTER INSERT OR UPDATE OF state ON rootset_control.jobs
  FOR EACH ROW EXECUTE FUNCTION rootset_control.record_job_activity();

DO $$
DECLARE organisation record;
BEGIN
  FOR organisation IN SELECT id FROM rootset_control.organisations LOOP
    PERFORM set_config('rootset.org_id',organisation.id,true);
    INSERT INTO rootset_control.activity_job_events(org_id,job_id,state,attempt,occurred_at)
      SELECT org_id,id,'queued',0,created_at FROM rootset_control.jobs WHERE org_id=organisation.id;
    INSERT INTO rootset_control.activity_job_events(org_id,job_id,state,attempt,occurred_at)
      SELECT org_id,id,state,attempt,coalesce(completed_at,updated_at)
      FROM rootset_control.jobs WHERE org_id=organisation.id AND state IN ('succeeded','failed','cancelled','partially_completed');
  END LOOP;
  PERFORM set_config('rootset.org_id','',true);
END;
$$;

CREATE INDEX activity_mutations_time ON rootset_control.mutations(org_id,committed_at DESC,id DESC);
CREATE INDEX activity_cells_mutation ON rootset_control.cell_changes(org_id,mutation_id,row_id);
CREATE INDEX activity_resources_time ON rootset_control.resource_history(org_id,changed_at DESC,id DESC);
