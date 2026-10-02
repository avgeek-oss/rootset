ALTER TABLE rootset_control.backups ADD COLUMN notification_delivery_id varchar(26);
CREATE TABLE rootset_control.history_retention_policies (
 id varchar(26) PRIMARY KEY,
 org_id varchar(26) NOT NULL,
 table_id varchar(26) NOT NULL UNIQUE REFERENCES rootset_control.tables(id),
 database_id varchar(26) NOT NULL REFERENCES rootset_control.databases(id),
 actor jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 36500),
 cron text NOT NULL,
 timezone text NOT NULL DEFAULT 'UTC',
 max_runtime_seconds integer NOT NULL DEFAULT 3600 CHECK(max_runtime_seconds BETWEEN 60 AND 86400),
 next_occurrence timestamptz,
 suspension_code text,
 suspended_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((suspension_code IS NULL) = (suspended_at IS NULL))
);
CREATE INDEX history_retention_policies_due ON rootset_control.history_retention_policies(next_occurrence) WHERE enabled;
CREATE TABLE rootset_control.history_archive_occurrences (
 policy_id varchar(26) NOT NULL REFERENCES rootset_control.history_retention_policies(id),
 scheduled_at timestamptz NOT NULL,
 job_id varchar(26) REFERENCES rootset_control.jobs(id),
 state text NOT NULL CHECK(state IN ('enqueued','skipped_overlap')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(policy_id,scheduled_at)
);
CREATE TABLE rootset_control.history_archives (
 id varchar(26) PRIMARY KEY,
 org_id varchar(26) NOT NULL,
 database_id varchar(26) NOT NULL,
 table_id varchar(26) NOT NULL,
 job_id varchar(26) NOT NULL UNIQUE REFERENCES rootset_control.jobs(id),
 state text NOT NULL DEFAULT 'snapshotting' CHECK(state IN ('snapshotting','uploading','verified','purging','succeeded','failed','cancelled')),
 from_time timestamptz,
 to_time timestamptz NOT NULL,
 artifact_id varchar(26) REFERENCES rootset_control.artifacts(id),
 manifest jsonb,
 error jsonb,
 cell_count bigint NOT NULL DEFAULT 0 CHECK(cell_count>=0),
 row_count bigint NOT NULL DEFAULT 0 CHECK(row_count>=0),
 purged_cells bigint NOT NULL DEFAULT 0 CHECK(purged_cells>=0),
 purged_rows bigint NOT NULL DEFAULT 0 CHECK(purged_rows>=0),
 verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX history_archive_active_table ON rootset_control.history_archives(table_id)
 WHERE state IN ('snapshotting','uploading','verified','purging');
CREATE INDEX history_archives_table ON rootset_control.history_archives(org_id,table_id,id);
DO $$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['history_retention_policies','history_archives'] LOOP
  EXECUTE format('ALTER TABLE rootset_control.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE rootset_control.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY organisation_boundary ON rootset_control.%I USING(org_id=current_setting(''rootset.org_id'',true)) WITH CHECK(org_id=current_setting(''rootset.org_id'',true))',n);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON rootset_control.%I TO rootset_app,rootset_ddl',n);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON rootset_control.history_archive_occurrences TO rootset_ddl;
