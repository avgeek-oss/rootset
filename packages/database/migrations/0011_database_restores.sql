ALTER TABLE rootset_control.database_backups
  ADD CONSTRAINT database_backups_org_id_id_key UNIQUE (org_id,id);

CREATE TABLE rootset_control.restore_results (
  job_id varchar(26) PRIMARY KEY REFERENCES rootset_control.jobs(id),
  org_id varchar(26) NOT NULL,
  source_backup_id varchar(26) NOT NULL,
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  database_id varchar(26) NOT NULL UNIQUE,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,source_backup_id) REFERENCES rootset_control.database_backups(org_id,id),
  FOREIGN KEY (org_id,database_id) REFERENCES rootset_control.databases(org_id,id)
);
ALTER TABLE rootset_control.restore_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.restore_results FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.restore_results
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));
