-- Compatibility bridge for the baseline changed in Rootset v0.1.4.
-- Run with the ordinary Rootset database owner before starting v0.1.4.
-- All schema changes, the original ledger snapshot, and ledger reconciliation
-- commit together. Unknown or partially modified installations are rejected.
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('rootset:migrations'));

DO $upgrade$
DECLARE
  previous_migrations jsonb;
  baseline_digest text;
BEGIN
  SELECT jsonb_agg(to_jsonb(m) ORDER BY name) INTO previous_migrations
    FROM rootset_control.migrations m;
  SELECT digest INTO baseline_digest FROM rootset_control.migrations
    WHERE name = '0001_baseline.sql';

  IF EXISTS (
    SELECT 1 FROM rootset_control.migrations
    WHERE NOT (
      (name = '0001_baseline.sql' AND digest IN (
        '4eb1bef6adf616d0c93b2165d39cd44655bb2640a29d4033e812cca11dcf8139',
        'fffd4634da07c05545d925ea7e7e940257a2da180aa552a52243b95475015ebe'
      )) OR
      (name = '0002_mcp_role_revocation.sql' AND digest = '381775803fc348664371f2b5209a0b734530b63f69905af4b3ba3355d3ae9932') OR
      (name = '0003_comment_deletion_log.sql' AND digest = '5eecc1162012ca9a8cc4c1933a7047832190c567392a50c6575db80956620b99')
    )
  ) OR baseline_digest IS NULL OR NOT EXISTS (
    SELECT 1 FROM rootset_control.migrations WHERE name = '0002_mcp_role_revocation.sql'
  ) THEN
    RAISE EXCEPTION 'Upgrade requires an unmodified Rootset v0.1.2, v0.1.3 or v0.1.4 migration ledger';
  END IF;

  IF baseline_digest = 'fffd4634da07c05545d925ea7e7e940257a2da180aa552a52243b95475015ebe' THEN
    -- v0.1.4 already has the comments schema; its normal migrator handles
    -- a pending deletion-log migration without touching existing comments.
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM rootset_control.migrations WHERE name = '0003_comment_deletion_log.sql')
    OR to_regclass('rootset_control.row_comments') IS NOT NULL THEN
    RAISE EXCEPTION 'Comments schema conflicts with the recorded baseline; preserve this database for inspection';
  END IF;

  CREATE TABLE rootset_control.migration_repairs (
    name text PRIMARY KEY,
    previous_migrations jsonb NOT NULL,
    repaired_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  INSERT INTO rootset_control.migration_repairs(name, previous_migrations)
    VALUES ('v0.1.4-row-comments', previous_migrations);

ALTER TABLE rootset_control.tables ADD CONSTRAINT tables_org_id_id_key UNIQUE (org_id,id);

CREATE TABLE rootset_control.row_comments (
  id varchar(26) PRIMARY KEY CHECK (id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
  table_id varchar(26) NOT NULL,
  row_id varchar(26) NOT NULL CHECK (row_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  author_user_id varchar(26) REFERENCES rootset_control.users(id) ON DELETE SET NULL,
  author_name_snapshot varchar(120) NOT NULL,
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096 AND body ~ '[^[:space:]]'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id,table_id) REFERENCES rootset_control.tables(org_id,id) ON DELETE CASCADE
);
CREATE INDEX row_comments_page ON rootset_control.row_comments(org_id,table_id,row_id,created_at,id);
ALTER TABLE rootset_control.row_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.row_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY row_comments_read ON rootset_control.row_comments FOR SELECT
  USING (org_id = (SELECT rootset_control.current_org_id()));
CREATE POLICY row_comments_create ON rootset_control.row_comments FOR INSERT
  WITH CHECK (org_id = (SELECT rootset_control.current_org_id()));
CREATE POLICY row_comments_delete ON rootset_control.row_comments FOR DELETE
  USING (org_id = (SELECT rootset_control.current_org_id()));

ALTER TABLE rootset_control.row_comments
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE rootset_control.row_comments
  DROP CONSTRAINT row_comments_body_check,
  ADD CONSTRAINT row_comments_body_check CHECK (
    (deleted_at IS NULL AND char_length(body) BETWEEN 1 AND 4096 AND body ~ '[^[:space:]]')
    OR (deleted_at IS NOT NULL AND body = '')
  );

CREATE POLICY row_comments_redact ON rootset_control.row_comments FOR UPDATE
  USING (org_id = (SELECT rootset_control.current_org_id()) AND deleted_at IS NULL)
  WITH CHECK (org_id = (SELECT rootset_control.current_org_id()) AND deleted_at IS NOT NULL AND body = '');

CREATE FUNCTION rootset_control.protect_comment_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, rootset_control AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.table_id, NEW.row_id, NEW.author_name_snapshot, NEW.actor, NEW.created_at)
    IS DISTINCT FROM
    (OLD.id, OLD.org_id, OLD.table_id, OLD.row_id, OLD.author_name_snapshot, OLD.actor, OLD.created_at) THEN
    RAISE EXCEPTION 'Comment attribution and chronology cannot be changed' USING ERRCODE = '23514';
  END IF;
  -- Allow the existing author foreign key to clear when a user is removed.
  IF NEW.author_user_id IS DISTINCT FROM OLD.author_user_id AND (
    NEW.author_user_id IS NOT NULL OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  ) THEN
    RAISE EXCEPTION 'Comment authors cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.body, NEW.deleted_at) IS DISTINCT FROM (OLD.body, OLD.deleted_at) AND (
    OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.body <> ''
  ) THEN
    RAISE EXCEPTION 'Comments can only be deleted, not edited or restored' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rootset_control.protect_comment_log() FROM PUBLIC;
CREATE TRIGGER protect_comment_log BEFORE UPDATE ON rootset_control.row_comments
  FOR EACH ROW EXECUTE FUNCTION rootset_control.protect_comment_log();

  UPDATE rootset_control.migrations
    SET digest = 'fffd4634da07c05545d925ea7e7e940257a2da180aa552a52243b95475015ebe'
    WHERE name = '0001_baseline.sql';
  INSERT INTO rootset_control.migrations(name, digest)
    VALUES ('0003_comment_deletion_log.sql', '5eecc1162012ca9a8cc4c1933a7047832190c567392a50c6575db80956620b99');
END
$upgrade$;
COMMIT;
