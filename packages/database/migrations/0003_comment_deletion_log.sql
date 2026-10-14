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
