CREATE TABLE rootset_control.backup_schedule_versions (
  database_id varchar(26) PRIMARY KEY,
  org_id varchar(26) NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  FOREIGN KEY (org_id,database_id) REFERENCES rootset_control.databases(org_id,id)
);
ALTER TABLE rootset_control.backup_schedule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.backup_schedule_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.backup_schedule_versions
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));

INSERT INTO rootset_control.backup_schedule_versions(database_id,org_id,version)
  SELECT database_id,org_id,version FROM rootset_control.backup_schedules;
DELETE FROM rootset_control.backup_schedules WHERE NOT enabled;
ALTER TABLE rootset_control.backup_schedules DROP COLUMN enabled;
ALTER TABLE rootset_control.backup_schedules ALTER COLUMN next_run_at SET NOT NULL;
CREATE INDEX backup_schedules_due ON rootset_control.backup_schedules(next_run_at);
