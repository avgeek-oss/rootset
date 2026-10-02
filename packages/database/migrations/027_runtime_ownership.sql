-- Runtime DDL must never inherit the deployment/migration login role.
-- Shared catalogs coordinate simultaneous fresh databases in this cluster.
LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE role_arg text;
BEGIN
 FOREACH role_arg IN ARRAY ARRAY['rootset_managed_owner','rootset_identity_definer','rootset_worker_definer','rootset_capacity_definer','rootset_metrics_definer'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_arg) THEN
   BEGIN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT %s',role_arg,CASE WHEN role_arg='rootset_managed_owner' THEN 'NOBYPASSRLS' ELSE 'BYPASSRLS' END);
   EXCEPTION WHEN duplicate_object OR unique_violation THEN
    -- Role catalog entries are cluster-global; migration locks are per database.
    NULL;
   END;
  END IF;
  EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT %s',role_arg,CASE WHEN role_arg='rootset_managed_owner' THEN 'NOBYPASSRLS' ELSE 'BYPASSRLS' END);
  EXECUTE format('REVOKE %I FROM rootset_app,rootset_ddl,rootset_identity',role_arg);
 END LOOP;
 ALTER ROLE rootset_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 ALTER ROLE rootset_ddl NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 ALTER ROLE rootset_identity NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 REVOKE rootset_owner FROM rootset_ddl;
 REVOKE rootset_owner FROM rootset_app,rootset_identity;
 GRANT rootset_managed_owner TO rootset_ddl;
 EXECUTE format('GRANT CREATE ON DATABASE %I TO rootset_ddl',current_database());
 IF EXISTS(SELECT 1 FROM pg_roles privileged CROSS JOIN pg_roles runtime
   WHERE runtime.rolname IN ('rootset_app','rootset_ddl','rootset_identity')
     AND (privileged.rolsuper OR privileged.rolbypassrls OR privileged.rolcreaterole)
     AND pg_has_role(runtime.oid,privileged.oid,'MEMBER')) THEN
  RAISE EXCEPTION 'A Rootset runtime role still inherits a privileged role';
 END IF;
END $$;

GRANT USAGE ON SCHEMA rootset_control TO rootset_managed_owner,rootset_identity_definer,rootset_worker_definer,rootset_capacity_definer,rootset_metrics_definer;
REVOKE CREATE ON SCHEMA rootset_control FROM PUBLIC,rootset_app,rootset_ddl,rootset_identity,rootset_managed_owner,rootset_identity_definer,rootset_worker_definer,rootset_capacity_definer,rootset_metrics_definer;

-- Registry tuples inherit their rule's organisation boundary. Neither the
-- application nor managed owner gets a cross-organisation table-owner bypass.
ALTER TABLE rootset_control.unique_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.unique_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_organisation_boundary ON rootset_control.unique_entries
 USING(EXISTS(SELECT 1 FROM rootset_control.unique_rules r WHERE r.id=rule_id AND r.org_id=nullif(current_setting('rootset.org_id',true),'')))
 WITH CHECK(EXISTS(SELECT 1 FROM rootset_control.unique_rules r WHERE r.id=rule_id AND r.org_id=nullif(current_setting('rootset.org_id',true),'')));
ALTER TABLE rootset_control.unique_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.unique_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_organisation_boundary ON rootset_control.unique_buckets
 USING(EXISTS(SELECT 1 FROM rootset_control.unique_rules r WHERE r.id=rule_id AND r.org_id=nullif(current_setting('rootset.org_id',true),'')))
 WITH CHECK(EXISTS(SELECT 1 FROM rootset_control.unique_rules r WHERE r.id=rule_id AND r.org_id=nullif(current_setting('rootset.org_id',true),'')));

DO $$
DECLARE name_arg text; relation record; function_arg regprocedure;
BEGIN
 FOREACH name_arg IN ARRAY ARRAY['databases','tables','fields','unique_rules','indexes','schema_operations','mutations','cell_changes','cell_changes_default','row_events','resource_history','history_gaps','query_sessions','unique_entries','unique_buckets','restore_provenance','restore_write_barriers','history_metrics'] LOOP
  EXECUTE format('ALTER TABLE rootset_control.%I OWNER TO rootset_managed_owner',name_arg);
 END LOOP;
 -- A partition can be addressed directly, so its own policy is required too.
 FOR relation IN SELECT c.oid::regclass AS relation FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='rootset_control.cell_changes'::regclass LOOP
  EXECUTE format('ALTER TABLE %s OWNER TO rootset_managed_owner',relation.relation);
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',relation.relation);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',relation.relation);
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation.relation AND polname='partition_organisation_boundary') THEN
   EXECUTE format('CREATE POLICY partition_organisation_boundary ON %s USING(org_id=nullif(current_setting(''rootset.org_id'',true),'''')) WITH CHECK(org_id=nullif(current_setting(''rootset.org_id'',true),''''))',relation.relation);
  END IF;
 END LOOP;
 FOR relation IN SELECT DISTINCT d.schema_name FROM rootset_control.databases d JOIN pg_namespace n ON n.nspname=d.schema_name WHERE d.schema_name ~ '^rsd_[a-z0-9]{26}$' LOOP
  EXECUTE format('ALTER SCHEMA %I OWNER TO rootset_managed_owner',relation.schema_name);
 END LOOP;
 FOR relation IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN rootset_control.databases d ON d.schema_name=n.nspname
   WHERE c.relkind IN ('r','p') AND c.relname ~ '^rst_[a-z0-9]{26}(_g[0-9]+)?$' LOOP
  EXECUTE format('ALTER TABLE %I.%I OWNER TO rootset_managed_owner',relation.nspname,relation.relname);
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',relation.nspname,relation.relname);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',relation.nspname,relation.relname);
 END LOOP;
 FOREACH function_arg IN ARRAY ARRAY[
  'rootset_control.canonical_number(numeric)'::regprocedure,
  'rootset_control.canonical_json(jsonb)'::regprocedure,
  'rootset_control.cell_value(jsonb,jsonb)'::regprocedure,
  'rootset_control.canonical_row(jsonb,character varying)'::regprocedure,
  'rootset_control.json_depth(jsonb)'::regprocedure,
  'rootset_control.validate_json(jsonb)'::regprocedure,
  'rootset_control.unique_digest(text)'::regprocedure,
  'rootset_control.enforce_row()'::regprocedure,
  'rootset_control.enforce_restore_write()'::regprocedure,
  'rootset_control.new_ulid()'::regprocedure,
  'rootset_control.track_history_metrics()'::regprocedure
 ] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO rootset_managed_owner',function_arg);
 END LOOP;
END $$;
GRANT SELECT ON rootset_control.jobs TO rootset_managed_owner;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA rootset_control TO rootset_managed_owner;
GRANT EXECUTE ON FUNCTION rootset_control.enforce_row(),rootset_control.enforce_restore_write() TO rootset_ddl;

-- Global identity lookups receive columns used by their fixed SQL only.
GRANT SELECT(id,org_id,user_id,role,state,version,restricted) ON rootset_control.memberships TO rootset_identity_definer;
GRANT SELECT(id,name,state) ON rootset_control.organisations TO rootset_identity_definer;
GRANT SELECT(id,org_id) ON rootset_control.api_keys TO rootset_identity_definer;
GRANT SELECT(token_hash,org_id) ON rootset_control.invitations TO rootset_identity_definer;
GRANT SELECT(id,disabled) ON rootset_control.users TO rootset_identity_definer;
GRANT SELECT(id,user_id,org_id,revoked_at) ON rootset_control.oauth_grants TO rootset_identity_definer;
GRANT SELECT(id,database_id,org_id,state) ON rootset_control.tables TO rootset_identity_definer;
GRANT SELECT(id,org_id,state) ON rootset_control.databases TO rootset_identity_definer;
ALTER FUNCTION rootset_control.memberships_for_user(text) OWNER TO rootset_identity_definer;
ALTER FUNCTION rootset_control.key_locator(text) OWNER TO rootset_identity_definer;
ALTER FUNCTION rootset_control.invitation_locator(text) OWNER TO rootset_identity_definer;
ALTER FUNCTION rootset_control.oauth_grant_active(text) OWNER TO rootset_identity_definer;
ALTER FUNCTION rootset_control.oauth_table_database(text,text) OWNER TO rootset_identity_definer;
ALTER FUNCTION rootset_control.oauth_database_exists(text,text) OWNER TO rootset_identity_definer;

GRANT SELECT(id,state) ON rootset_control.organisations TO rootset_worker_definer;
GRANT SELECT(org_id,state) ON rootset_control.jobs TO rootset_worker_definer;
ALTER FUNCTION rootset_control.worker_org_directory() OWNER TO rootset_worker_definer;

-- Cross-organisation accounting never owns/writes a DDL-owned storage table.
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.capacity_settings,rootset_control.capacity_organisation_quotas,rootset_control.capacity_control_usage,rootset_control.capacity_reservations TO rootset_capacity_definer;
GRANT SELECT(org_id,schema_name) ON rootset_control.databases TO rootset_capacity_definer;
GRANT SELECT(id,org_id) ON rootset_control.unique_rules TO rootset_capacity_definer;
GRANT pg_read_all_settings TO rootset_capacity_definer;
DO $$ DECLARE function_arg regprocedure; BEGIN
 FOREACH function_arg IN ARRAY ARRAY[
  'rootset_control.capacity_lock()'::regprocedure,
  'rootset_control.capacity_org_usage(character varying)'::regprocedure,
  'rootset_control.capacity_configuration()'::regprocedure,
  'rootset_control.configure_capacity(jsonb)'::regprocedure,
  'rootset_control.capacity_storage_paths()'::regprocedure,
  'rootset_control.capacity_report_checkpoint()'::regprocedure,
  'rootset_control.report_storage_capacity(jsonb,jsonb)'::regprocedure,
  'rootset_control.capacity_status(character varying)'::regprocedure,
  'rootset_control.begin_capacity_admission(character varying,bigint,text)'::regprocedure,
  'rootset_control.validate_capacity_allocation(character varying,bigint,bigint,bigint)'::regprocedure,
  'rootset_control.finish_capacity_admission(character varying,text)'::regprocedure,
  'rootset_control.commit_capacity_admission()'::regprocedure,
  'rootset_control.enforce_capacity_admission()'::regprocedure,
  'rootset_control.track_capacity_control_usage()'::regprocedure
 ] LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO rootset_capacity_definer',function_arg); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION rootset_control.capacity_lock(),rootset_control.enforce_capacity_admission() TO rootset_managed_owner,rootset_ddl;

-- All callable privileged functions retain fixed paths and their existing
-- specific runtime grants. No role may SET ROLE to a definer owner.
DO $$ DECLARE function_arg regprocedure; BEGIN
 FOR function_arg IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
   WHERE n.nspname='rootset_control' AND r.rolname IN ('rootset_identity_definer','rootset_worker_definer','rootset_capacity_definer') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog',function_arg);
  EXECUTE format('ALTER FUNCTION %s SET timezone=''UTC''',function_arg);
 END LOOP;
END $$;
