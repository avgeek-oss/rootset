CREATE FUNCTION rootset_control.new_ulid() RETURNS varchar(26)
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE alphabet text:='0123456789ABCDEFGHJKMNPQRSTVWXYZ'; entropy bytea; value numeric; output text:=''; i integer;
BEGIN
 entropy:=public.gen_random_bytes(10);
 value:=floor(extract(epoch FROM clock_timestamp())*1000)*1208925819614629174706176;
 FOR i IN 0..9 LOOP value:=value+get_byte(entropy,i)::numeric*power(256::numeric,9-i); END LOOP;
 FOR i IN 1..26 LOOP output:=substr(alphabet,mod(value,32)::integer+1,1)||output;value:=trunc(value/32); END LOOP;
 RETURN output::varchar(26);
END $$;
ALTER TABLE rootset_control.cell_changes ADD COLUMN public_id varchar(26) NOT NULL DEFAULT rootset_control.new_ulid();
CREATE UNIQUE INDEX cell_changes_public_id ON rootset_control.cell_changes(public_id,changed_at);
CREATE INDEX cell_changes_public_lookup ON rootset_control.cell_changes(org_id,table_id,public_id);
CREATE TABLE rootset_control.restore_provenance (
 database_id varchar(26) PRIMARY KEY REFERENCES rootset_control.databases(id),org_id varchar(26) NOT NULL,
 source_database_id varchar(26) NOT NULL,job_id varchar(26) NOT NULL,manifest jsonb NOT NULL,state text NOT NULL DEFAULT 'staged',
 created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz
);
ALTER TABLE rootset_control.restore_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.restore_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON rootset_control.restore_provenance USING(org_id=nullif(current_setting('rootset.org_id',true),'')) WITH CHECK(org_id=nullif(current_setting('rootset.org_id',true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.restore_provenance TO rootset_ddl;
GRANT SELECT ON rootset_control.restore_provenance TO rootset_app;
