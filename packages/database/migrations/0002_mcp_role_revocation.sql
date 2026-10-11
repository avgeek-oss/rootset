CREATE FUNCTION rootset_control.revoke_mcp_on_membership_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, rootset_control AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.role IS DISTINCT FROM NEW.role THEN
    UPDATE rootset_control.oauth_grants SET revoked_at=now()
      WHERE user_id=OLD.user_id AND org_id=OLD.org_id AND revoked_at IS NULL;
    UPDATE rootset_control.oauth_families SET revoked_at=now()
      WHERE grant_id IN (SELECT id FROM rootset_control.oauth_grants WHERE user_id=OLD.user_id AND org_id=OLD.org_id)
        AND revoked_at IS NULL;
    UPDATE rootset_control.oauth_requests SET status='denied'
      WHERE user_id=OLD.user_id AND org_id=OLD.org_id AND status='pending';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rootset_control.revoke_mcp_on_membership_change() FROM PUBLIC;
CREATE TRIGGER revoke_mcp_on_membership_change AFTER UPDATE OF role OR DELETE ON rootset_control.memberships
  FOR EACH ROW EXECUTE FUNCTION rootset_control.revoke_mcp_on_membership_change();
