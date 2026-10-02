GRANT USAGE ON SCHEMA rootset_control TO rootset_app, rootset_identity, rootset_ddl;
GRANT SELECT ON rootset_control.migrations TO rootset_app, rootset_identity, rootset_ddl;

CREATE FUNCTION rootset_control.worker_org_directory() RETURNS TABLE(id text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, rootset_control
AS $$ SELECT id FROM rootset_control.organisations WHERE state = 'active' $$;
REVOKE ALL ON FUNCTION rootset_control.worker_org_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.worker_org_directory() TO rootset_ddl;
