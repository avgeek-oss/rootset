CREATE TABLE IF NOT EXISTS rootset_control.jobs (
 id char(26) PRIMARY KEY,
 org_id char(26) NOT NULL,
 kind text NOT NULL,
 operation_id text NOT NULL,
 actor jsonb NOT NULL,
 requester_id text NOT NULL,
 target_type text NOT NULL CHECK (target_type IN ('table','database','organisation')),
 target_id char(26) NOT NULL,
 input jsonb NOT NULL,
 input_digest text NOT NULL,
 idempotency_key text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled','partially_completed')),
 stage text NOT NULL DEFAULT 'queued',
 attempt integer NOT NULL DEFAULT 0,
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
 lease_token char(26),
 lease_until timestamptz,
 heartbeat_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 cancel_requested boolean NOT NULL DEFAULT false,
 checkpoint jsonb NOT NULL DEFAULT '{}',
 progress jsonb NOT NULL DEFAULT '{"committed":0,"rejected":0}',
 result jsonb,
 error jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(org_id,requester_id,operation_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_poll ON rootset_control.jobs(next_attempt_at,created_at) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS jobs_org_target ON rootset_control.jobs(org_id,target_id,created_at DESC);
CREATE TABLE IF NOT EXISTS rootset_control.artifacts (
 id char(26) PRIMARY KEY,
 org_id char(26) NOT NULL,
 job_id char(26) REFERENCES rootset_control.jobs(id),
 requester_id text NOT NULL,
 target_type text NOT NULL CHECK (target_type IN ('table','database','organisation')),
 target_id char(26) NOT NULL,
 purpose text NOT NULL,
 object_key text NOT NULL UNIQUE,
 state text NOT NULL CHECK (state IN ('upload_pending','uploading','ready','expired','deleting','deleted','failed')),
 format text NOT NULL,
 media_type text NOT NULL,
 declared_bytes bigint,
 byte_length bigint,
 ciphertext_length bigint,
 checksum text,
 ciphertext_checksum text,
 encryption_key_id text,
 iv text,
 tag text,
 expected_checksum text,
 metadata jsonb NOT NULL DEFAULT '{}',
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_expiry ON rootset_control.artifacts(expires_at) WHERE state IN ('upload_pending','ready');
CREATE TABLE IF NOT EXISTS rootset_control.import_rejections (
 job_id char(26) NOT NULL REFERENCES rootset_control.jobs(id),
 org_id char(26) NOT NULL,
 record_number bigint NOT NULL,
 code text NOT NULL,
 message text NOT NULL,
 field text,
 PRIMARY KEY(job_id,record_number)
);
CREATE TABLE IF NOT EXISTS rootset_control.import_batches (
 job_id char(26) NOT NULL REFERENCES rootset_control.jobs(id),
 org_id char(26) NOT NULL,
 start_record bigint NOT NULL,
 end_record bigint NOT NULL,
 plan jsonb NOT NULL,
 state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','committed')),
 progress jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(job_id,start_record)
);
CREATE TABLE IF NOT EXISTS rootset_control.backup_policies (
 id char(26) PRIMARY KEY,
 org_id char(26) NOT NULL,
 database_id char(26) NOT NULL UNIQUE,
 actor jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 cron text NOT NULL,
 timezone text NOT NULL DEFAULT 'UTC',
 destination text NOT NULL DEFAULT 'installation',
 retention_days integer NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 3650),
 retention_count integer NOT NULL DEFAULT 10 CHECK(retention_count BETWEEN 1 AND 1000),
 max_runtime_seconds integer NOT NULL DEFAULT 3600 CHECK(max_runtime_seconds BETWEEN 30 AND 86400),
 encryption boolean NOT NULL DEFAULT true CHECK(encryption),
 notifications boolean NOT NULL DEFAULT true,
 next_occurrence timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_policies_due ON rootset_control.backup_policies(next_occurrence) WHERE enabled;
CREATE TABLE IF NOT EXISTS rootset_control.backup_occurrences (
 policy_id char(26) NOT NULL REFERENCES rootset_control.backup_policies(id),
 scheduled_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('enqueued','skipped_overlap','skipped_disabled')),
 job_id char(26) REFERENCES rootset_control.jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(policy_id,scheduled_at)
);
CREATE TABLE IF NOT EXISTS rootset_control.backups (
 id char(26) PRIMARY KEY,
 org_id char(26) NOT NULL,
 database_id char(26) NOT NULL,
 job_id char(26) NOT NULL UNIQUE REFERENCES rootset_control.jobs(id),
 state text NOT NULL CHECK(state IN ('queued','snapshotting','uploading','verifying','succeeded','failed','cancelled','deleting','deleted')),
 manifest_artifact_id char(26) REFERENCES rootset_control.artifacts(id),
 manifest jsonb,
 verified_at timestamptz,
 snapshot_at timestamptz,
 cleanup_error jsonb,
 notification_state text NOT NULL DEFAULT 'pending' CHECK(notification_state IN ('pending','sent','failed','disabled')),
 recovery_for_database_id char(26),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backups_verified ON rootset_control.backups(org_id,database_id,verified_at DESC) WHERE state='succeeded';
CREATE TABLE IF NOT EXISTS rootset_control.restore_publications (
 job_id char(26) PRIMARY KEY REFERENCES rootset_control.jobs(id),
 org_id char(26) NOT NULL,
 target_database_id char(26),
 staged_database_id char(26),
 recovery_backup_id char(26),
 state text NOT NULL CHECK(state IN ('preparing','staged','verified','published','recovered')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['jobs','artifacts','import_rejections','import_batches','backup_policies','backups','restore_publications'] LOOP
   EXECUTE format('ALTER TABLE rootset_control.%I ENABLE ROW LEVEL SECURITY',n);
   EXECUTE format('ALTER TABLE rootset_control.%I FORCE ROW LEVEL SECURITY',n);
   EXECUTE format('DROP POLICY IF EXISTS org_isolation ON rootset_control.%I',n);
   EXECUTE format('CREATE POLICY org_isolation ON rootset_control.%I USING (org_id = nullif(current_setting(''rootset.org_id'',true),'''')::char(26)) WITH CHECK (org_id = nullif(current_setting(''rootset.org_id'',true),'''')::char(26))',n);
 END LOOP;
END $$;
