-- Role catalogs are shared across databases; upgrades may run concurrently.
LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE parent_role text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rootset_capacity_reporter') THEN
  BEGIN
   CREATE ROLE rootset_capacity_reporter NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
 END IF;
 ALTER ROLE rootset_capacity_reporter NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 FOR parent_role IN SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname='rootset_capacity_reporter' LOOP
  EXECUTE format('REVOKE %I FROM rootset_capacity_reporter',parent_role);
 END LOOP;
 REVOKE rootset_capacity_reporter FROM rootset_app,rootset_ddl,rootset_identity;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA rootset_control FROM rootset_capacity_reporter;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA rootset_control FROM rootset_capacity_reporter;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rootset_control FROM rootset_capacity_reporter;
REVOKE ALL ON SCHEMA rootset_control FROM rootset_capacity_reporter;
GRANT USAGE ON SCHEMA rootset_control TO rootset_capacity_reporter;
GRANT EXECUTE ON FUNCTION rootset_control.capacity_storage_paths(),rootset_control.capacity_report_checkpoint(),rootset_control.report_storage_capacity(jsonb,jsonb) TO rootset_capacity_reporter;
