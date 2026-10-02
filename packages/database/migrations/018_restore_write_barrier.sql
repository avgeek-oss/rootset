CREATE TABLE rootset_control.restore_write_barriers (
 database_id varchar(26) PRIMARY KEY REFERENCES rootset_control.databases(id),
 org_id varchar(26) NOT NULL,
 job_id char(26) NOT NULL REFERENCES rootset_control.jobs(id),
 acquired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rootset_control.restore_write_barriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.restore_write_barriers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.restore_write_barriers
 USING(org_id=nullif(current_setting('rootset.org_id',true),''))
 WITH CHECK(org_id=nullif(current_setting('rootset.org_id',true),''));
GRANT SELECT ON rootset_control.restore_write_barriers TO rootset_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.restore_write_barriers TO rootset_ddl;
CREATE INDEX restore_write_barriers_job ON rootset_control.restore_write_barriers(org_id,job_id);

CREATE FUNCTION rootset_control.enforce_restore_write() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rootset_control AS $$
DECLARE database_arg varchar(26); organisation_arg varchar(26);
BEGIN
 SELECT database_id,org_id INTO STRICT database_arg,organisation_arg FROM rootset_control.tables WHERE id=TG_ARGV[0];
 IF organisation_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN
   RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(database_arg,0));
 IF EXISTS(SELECT 1 FROM rootset_control.restore_write_barriers WHERE database_id=database_arg) THEN
   RAISE EXCEPTION 'database is frozen for replacement restore' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION rootset_control.enforce_restore_write() FROM PUBLIC;

DO $$ DECLARE t record; relation record; BEGIN
 FOR t IN SELECT stored.id,stored.physical_name,d.schema_name FROM rootset_control.tables stored JOIN rootset_control.databases d ON d.id=stored.database_id LOOP
   FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=t.schema_name AND c.relkind='r' AND (c.relname=t.physical_name OR c.relname LIKE 'rst_'||lower(t.id)||'_g%') LOOP
     IF NOT EXISTS(SELECT 1 FROM pg_trigger p JOIN pg_class c ON c.oid=p.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE p.tgname='rootset_restore_guard' AND c.relname=relation.relname AND n.nspname=t.schema_name) THEN
       EXECUTE format('CREATE TRIGGER rootset_restore_guard BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION rootset_control.enforce_restore_write(%L)',t.schema_name,relation.relname,t.id);
     END IF;
   END LOOP;
 END LOOP;
END $$;
