ALTER TABLE rootset_control.users ALTER COLUMN name TYPE varchar(255);
ALTER TABLE rootset_control.organisations ALTER COLUMN name TYPE varchar(255);
ALTER TABLE rootset_control.api_keys ALTER COLUMN name TYPE varchar(255);
ALTER TABLE rootset_control.auth_passkeys ALTER COLUMN name TYPE varchar(255);
DROP FUNCTION rootset_control.memberships_for_user(text);
CREATE FUNCTION rootset_control.memberships_for_user(identity_user_id text)
RETURNS TABLE(id varchar(26),org_id varchar(26),user_id varchar(26),role text,state text,version bigint,restricted boolean,name varchar(255),organisation_state text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,rootset_control AS $$
 SELECT m.id,m.org_id,m.user_id,m.role,m.state,m.version,m.restricted,o.name,o.state FROM rootset_control.memberships m JOIN rootset_control.organisations o ON o.id=m.org_id WHERE m.user_id=identity_user_id;
$$;
REVOKE ALL ON FUNCTION rootset_control.memberships_for_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.memberships_for_user(text) TO rootset_identity;
