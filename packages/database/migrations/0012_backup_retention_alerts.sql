ALTER TABLE rootset_control.worker_heartbeats
  ADD COLUMN backup_alert_delivery boolean NOT NULL DEFAULT false;

CREATE TABLE rootset_control.backup_policies (
  database_id varchar(26) PRIMARY KEY,
  org_id varchar(26) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  retention_count integer CHECK (retention_count BETWEEN 1 AND 10000),
  overdue_grace_minutes integer NOT NULL DEFAULT 60 CHECK (overdue_grace_minutes BETWEEN 5 AND 1440),
  alerts_started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,database_id) REFERENCES rootset_control.databases(org_id,id)
);
INSERT INTO rootset_control.backup_policies(database_id,org_id)
  SELECT database_id,org_id FROM rootset_control.backup_schedules;
ALTER TABLE rootset_control.backup_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.backup_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.backup_policies
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));

ALTER TABLE rootset_control.database_backups
  ADD COLUMN storage_state text NOT NULL DEFAULT 'available' CHECK (storage_state IN ('available','deleting','pruned')),
  ADD COLUMN pruned_at timestamptz,
  ADD COLUMN prune_lease_token varchar(26),
  ADD COLUMN prune_lease_until timestamptz,
  ADD COLUMN prune_attempts integer NOT NULL DEFAULT 0 CHECK (prune_attempts BETWEEN 0 AND 100),
  ADD COLUMN next_prune_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN prune_error text,
  ADD CONSTRAINT backup_pruned_timestamp CHECK (storage_state<>'pruned' OR pruned_at IS NOT NULL),
  ADD CONSTRAINT backup_prune_publication CHECK (storage_state='available' OR (published AND kind='backup'));
CREATE INDEX backup_retention_candidates ON rootset_control.database_backups(org_id,database_id,completed_at DESC,id DESC)
  WHERE published AND kind='backup' AND storage_state<>'pruned';
CREATE INDEX restore_backup_pins ON rootset_control.jobs(org_id,(input->>'backupId'))
  WHERE kind IN ('database_restore_preview','database_restore');

CREATE TABLE rootset_control.backup_alerts (
  id varchar(26) PRIMARY KEY,
  org_id varchar(26) NOT NULL,
  database_id varchar(26) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('failed','overdue')),
  backup_id varchar(26),
  occurrence_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  resolved_at timestamptz,
  FOREIGN KEY (org_id,database_id) REFERENCES rootset_control.databases(org_id,id),
  FOREIGN KEY (org_id,backup_id) REFERENCES rootset_control.database_backups(org_id,id),
  CHECK ((kind='failed' AND backup_id IS NOT NULL) OR (kind='overdue' AND backup_id IS NULL))
);
CREATE UNIQUE INDEX backup_failure_alert ON rootset_control.backup_alerts(database_id,backup_id) WHERE kind='failed';
CREATE UNIQUE INDEX backup_overdue_episode ON rootset_control.backup_alerts(database_id) WHERE kind='overdue' AND resolved_at IS NULL;
CREATE INDEX backup_alert_page ON rootset_control.backup_alerts(org_id,database_id,id DESC);
ALTER TABLE rootset_control.backup_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.backup_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.backup_alerts
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));
