CREATE TABLE rootset_control.history_metrics (
  org_id varchar(26) NOT NULL,
  table_id varchar(26) NOT NULL,
  events bigint NOT NULL CHECK(events>=0),
  tuple_bytes bigint NOT NULL CHECK(tuple_bytes>=0),
  PRIMARY KEY(org_id,table_id)
);
ALTER TABLE rootset_control.history_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.history_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_boundary ON rootset_control.history_metrics USING(org_id=current_setting('rootset.org_id',true)) WITH CHECK(org_id=current_setting('rootset.org_id',true));
GRANT SELECT,INSERT,UPDATE ON rootset_control.history_metrics TO rootset_app,rootset_ddl,rootset_identity;
INSERT INTO rootset_control.history_metrics(org_id,table_id,events,tuple_bytes)
SELECT org_id,table_id,count(*),sum(pg_column_size(c)) FROM rootset_control.cell_changes c GROUP BY org_id,table_id;
CREATE FUNCTION rootset_control.track_history_metrics() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO rootset_control.history_metrics(org_id,table_id,events,tuple_bytes) VALUES(NEW.org_id,NEW.table_id,1,pg_column_size(NEW))
  ON CONFLICT(org_id,table_id) DO UPDATE SET events=rootset_control.history_metrics.events+1,tuple_bytes=rootset_control.history_metrics.tuple_bytes+EXCLUDED.tuple_bytes;
  RETURN NEW;
 ELSE
  UPDATE rootset_control.history_metrics SET events=events-1,tuple_bytes=greatest(0,tuple_bytes-pg_column_size(OLD)) WHERE org_id=OLD.org_id AND table_id=OLD.table_id;
  RETURN OLD;
 END IF;
END $$;
CREATE TRIGGER history_usage AFTER INSERT OR DELETE ON rootset_control.cell_changes FOR EACH ROW EXECUTE FUNCTION rootset_control.track_history_metrics();
