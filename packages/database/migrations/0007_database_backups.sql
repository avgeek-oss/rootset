ALTER TABLE rootset_control.databases ADD CONSTRAINT databases_org_id_id_key UNIQUE (org_id,id);

ALTER TABLE rootset_control.worker_heartbeats
  ADD COLUMN backup_backend_id text;

CREATE TABLE rootset_control.backup_schedules (
  database_id varchar(26) PRIMARY KEY,
  org_id varchar(26) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT false,
  bucket text NOT NULL,
  prefix text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL,
  backend_id text NOT NULL,
  next_run_at timestamptz,
  tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,database_id) REFERENCES rootset_control.databases(org_id,id),
  CHECK (enabled = false OR next_run_at IS NOT NULL)
);
CREATE INDEX backup_schedules_due ON rootset_control.backup_schedules(next_run_at) WHERE enabled;
ALTER TABLE rootset_control.backup_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.backup_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.backup_schedules
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));

CREATE TABLE rootset_control.database_backups (
  id varchar(26) PRIMARY KEY,
  org_id varchar(26) NOT NULL,
  database_id varchar(26) NOT NULL,
  job_id varchar(26) UNIQUE REFERENCES rootset_control.jobs(id),
  kind text NOT NULL CHECK (kind IN ('backup','destination_test','skipped')),
  trigger text NOT NULL CHECK (trigger IN ('manual','schedule')),
  schedule_version integer,
  scheduled_at timestamptz NOT NULL,
  skipped_until timestamptz,
  bucket text NOT NULL,
  prefix text NOT NULL,
  backend_id text NOT NULL,
  published boolean NOT NULL DEFAULT false,
  snapshot_at timestamptz,
  started_at timestamptz,
  object_key text,
  byte_length bigint,
  checksum text,
  table_count integer,
  row_count bigint,
  result jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (org_id,database_id) REFERENCES rootset_control.databases(org_id,id),
  CHECK (NOT published OR (result IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (kind <> 'backup' OR NOT published OR (object_key IS NOT NULL AND checksum IS NOT NULL AND snapshot_at IS NOT NULL))
);
CREATE UNIQUE INDEX database_backups_occurrence ON rootset_control.database_backups(database_id,schedule_version,scheduled_at)
  WHERE trigger='schedule' AND kind='backup';
CREATE INDEX database_backups_page ON rootset_control.database_backups(org_id,database_id,id DESC);
ALTER TABLE rootset_control.database_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.database_backups FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.database_backups
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));
