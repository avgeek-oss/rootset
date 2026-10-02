CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE rootset_control.databases (
 id varchar(26) PRIMARY KEY, org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200), description text NOT NULL DEFAULT '',
 schema_name text NOT NULL UNIQUE CHECK(schema_name ~ '^rsd_[a-z0-9]{26}$'), state text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE rootset_control.tables (
 id varchar(26) PRIMARY KEY, database_id varchar(26) NOT NULL REFERENCES rootset_control.databases(id),
 org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id), name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
 physical_name text NOT NULL CHECK(physical_name ~ '^rst_[a-z0-9]{26}(_g[0-9]+)?$'), generation integer NOT NULL DEFAULT 1,
 schema_version bigint NOT NULL DEFAULT 1, row_count bigint NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 5000000),
 state text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 UNIQUE(database_id,physical_name)
);
CREATE INDEX tables_database ON rootset_control.tables(org_id,database_id);
CREATE TABLE rootset_control.fields (
 id varchar(26) PRIMARY KEY, table_id varchar(26) NOT NULL REFERENCES rootset_control.tables(id), org_id varchar(26) NOT NULL,
 api_key varchar(64) NOT NULL CHECK(api_key ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'), label text NOT NULL,
 definition jsonb NOT NULL, position integer NOT NULL, state text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE UNIQUE INDEX fields_active_api_key ON rootset_control.fields(table_id,api_key COLLATE "C") WHERE state='active';
CREATE TABLE rootset_control.unique_rules (
 id varchar(26) PRIMARY KEY, table_id varchar(26) NOT NULL REFERENCES rootset_control.tables(id), org_id varchar(26) NOT NULL,
 name text NOT NULL, field_ids varchar(26)[] NOT NULL, strategy text NOT NULL CHECK(strategy IN ('native','registry')),
 physical_name text, state text NOT NULL DEFAULT 'building', created_at timestamptz NOT NULL DEFAULT now(), error jsonb,
 CHECK(cardinality(field_ids) BETWEEN 1 AND 8)
);
CREATE TABLE rootset_control.indexes (
 id varchar(26) PRIMARY KEY, table_id varchar(26) NOT NULL REFERENCES rootset_control.tables(id), org_id varchar(26) NOT NULL,
 field_id varchar(26) NOT NULL, kind text NOT NULL CHECK(kind IN ('btree','trigram','json')), physical_name text NOT NULL,
 state text NOT NULL DEFAULT 'building', error jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.schema_operations (
 id varchar(26) PRIMARY KEY, org_id varchar(26) NOT NULL, database_id varchar(26) NOT NULL, table_id varchar(26),
 idempotency_key text NOT NULL, input_hash text NOT NULL, expected_version bigint, kind text NOT NULL,
 before_definition jsonb, after_definition jsonb, plan jsonb, state text NOT NULL DEFAULT 'planned',
 error jsonb, created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz,
 UNIQUE(org_id,idempotency_key)
);
CREATE TABLE rootset_control.mutations (
 id varchar(26) PRIMARY KEY, org_id varchar(26) NOT NULL, table_id varchar(26) NOT NULL,
 idempotency_key text, input_hash text NOT NULL, actor jsonb NOT NULL, context jsonb NOT NULL,
 schema_version bigint NOT NULL, outcome jsonb, committed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,table_id,idempotency_key)
);
CREATE TABLE rootset_control.cell_changes (
 id bigint GENERATED ALWAYS AS IDENTITY, org_id varchar(26) NOT NULL, database_id varchar(26) NOT NULL,
 table_id varchar(26) NOT NULL, row_id varchar(26) NOT NULL, field_id varchar(26) NOT NULL, mutation_id varchar(26) NOT NULL,
 old_value jsonb, new_value jsonb, field_definition jsonb NOT NULL, old_version bigint, new_version bigint,
 operation text NOT NULL, actor jsonb NOT NULL, context jsonb NOT NULL, changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE(changed_at);
CREATE TABLE rootset_control.cell_changes_default PARTITION OF rootset_control.cell_changes DEFAULT;
CREATE INDEX cell_changes_lookup ON rootset_control.cell_changes(org_id,table_id,row_id,field_id,changed_at,id);
CREATE INDEX cell_changes_mutation ON rootset_control.cell_changes(org_id,mutation_id);
CREATE TABLE rootset_control.row_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id varchar(26) NOT NULL, database_id varchar(26) NOT NULL,
 table_id varchar(26) NOT NULL, row_id varchar(26) NOT NULL, mutation_id varchar(26) NOT NULL,
 operation text NOT NULL, old_version bigint, new_version bigint, actor jsonb NOT NULL, context jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX row_events_lookup ON rootset_control.row_events(org_id,table_id,row_id,changed_at,id);
CREATE TABLE rootset_control.resource_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id varchar(26) NOT NULL, database_id varchar(26),table_id varchar(26),
 resource_id varchar(26) NOT NULL, operation text NOT NULL, before_value jsonb, after_value jsonb,
 actor jsonb NOT NULL, context jsonb NOT NULL, changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX resource_history_lookup ON rootset_control.resource_history(org_id,table_id,changed_at,id);
CREATE TABLE rootset_control.history_gaps (
 id varchar(26) PRIMARY KEY, org_id varchar(26) NOT NULL, table_id varchar(26) NOT NULL,
 from_time timestamptz NOT NULL, to_time timestamptz NOT NULL, manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.unique_buckets (
 rule_id varchar(26) NOT NULL REFERENCES rootset_control.unique_rules(id), digest text NOT NULL,
 PRIMARY KEY(rule_id,digest)
);
CREATE TABLE rootset_control.unique_entries (
 rule_id varchar(26) NOT NULL REFERENCES rootset_control.unique_rules(id), row_id varchar(26) NOT NULL,
 digest text NOT NULL, tuple text COLLATE "C" NOT NULL, PRIMARY KEY(rule_id,row_id)
);
CREATE INDEX unique_entries_bucket ON rootset_control.unique_entries(rule_id,digest);
CREATE TABLE rootset_control.query_sessions (
 id varchar(26) PRIMARY KEY, org_id varchar(26) NOT NULL, table_id varchar(26) NOT NULL, schema_version bigint NOT NULL,
 query_hash text NOT NULL, grant_hash text NOT NULL, anchors jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);

CREATE FUNCTION rootset_control.canonical_json(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE t text; n text; exp integer; mant text; neg text; digits text; pos integer;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||rootset_control.canonical_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO t FROM jsonb_each(v); RETURN t;
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(rootset_control.canonical_json(value),',' ORDER BY ord),'')||']' INTO t FROM jsonb_array_elements(v) WITH ORDINALITY e(value,ord); RETURN t;
 WHEN 'number' THEN
   n := (v::text::float8)::text;
   IF n='-0' THEN RETURN '0'; END IF;
   IF n ~ '[eE]' THEN
     mant:=split_part(lower(n),'e',1); exp:=split_part(lower(n),'e',2)::integer;
     IF exp >= -6 AND exp < 21 THEN
       neg:=CASE WHEN left(mant,1)='-' THEN '-' ELSE '' END;
       mant:=ltrim(mant,'-'); pos:=position('.' in mant); IF pos=0 THEN pos:=length(mant)+1; END IF;
       digits:=replace(mant,'.',''); pos:=pos-1+exp;
       IF pos<=0 THEN n:=neg||'0.'||repeat('0',-pos)||digits;
       ELSIF pos>=length(digits) THEN n:=neg||digits||repeat('0',pos-length(digits));
       ELSE n:=neg||left(digits,pos)||'.'||substr(digits,pos+1); END IF;
     ELSE n:=mant||'e'||CASE WHEN exp>=0 THEN '+' ELSE '' END||exp::text; END IF;
   END IF;
   RETURN n;
 ELSE RETURN v::text;
 END CASE;
END $$;

CREATE FUNCTION rootset_control.cell_value(record_json jsonb, f jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v jsonb; t text;
BEGIN
 v:=record_json->('f_'||lower(f->>'id'));
 IF v IS NULL OR v='null'::jsonb THEN RETURN 'null'::jsonb; END IF;
 t:=f->>'type';
 IF t='time' THEN RETURN to_jsonb(to_char((v#>>'{}')::time,'HH24:MI:SS.MS')||'Z'); END IF;
 IF t='date-time' THEN RETURN to_jsonb(to_char((v#>>'{}')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')); END IF;
 IF t='date' THEN RETURN to_jsonb(to_char((v#>>'{}')::date,'YYYY-MM-DD')); END IF;
 RETURN v;
END $$;
CREATE FUNCTION rootset_control.canonical_row(record_json jsonb, table_id_arg varchar) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,rootset_control AS $$
DECLARE result jsonb:='{}'; f record;
BEGIN
 FOR f IN SELECT id,definition FROM rootset_control.fields WHERE table_id=table_id_arg AND state='active' ORDER BY id COLLATE "C" LOOP
   result:=result||jsonb_build_object(f.id,rootset_control.cell_value(record_json,f.definition));
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION rootset_control.json_depth(v jsonb) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE d integer;
BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT max(rootset_control.json_depth(value)) INTO d FROM jsonb_each(v); RETURN 1+coalesce(d,0); END IF;
 IF jsonb_typeof(v)='array' THEN SELECT max(rootset_control.json_depth(value)) INTO d FROM jsonb_array_elements(v); RETURN 1+coalesce(d,0); END IF;
 RETURN 0;
END $$;
CREATE FUNCTION rootset_control.validate_json(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE e record;
BEGIN
 IF jsonb_typeof(v)='number' THEN
   IF (v::text::numeric)=trunc(v::text::numeric) AND abs(v::text::numeric)>9007199254740991 THEN RETURN false; END IF;
   BEGIN IF (v::text::float8)::text IN ('Infinity','-Infinity','NaN') THEN RETURN false; END IF; EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false; END;
 ELSIF jsonb_typeof(v)='object' THEN
   FOR e IN SELECT value FROM jsonb_each(v) LOOP IF NOT rootset_control.validate_json(e.value) THEN RETURN false; END IF; END LOOP;
 ELSIF jsonb_typeof(v)='array' THEN
   FOR e IN SELECT value FROM jsonb_array_elements(v) LOOP IF NOT rootset_control.validate_json(e.value) THEN RETURN false; END IF; END LOOP;
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION rootset_control.unique_digest(tuple_arg text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$ SELECT encode(public.digest(convert_to(tuple_arg,'UTF8'),'sha256'),'hex') $$;

CREATE FUNCTION rootset_control.enforce_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rootset_control SET timezone='UTC' AS $$
DECLARE tab rootset_control.tables%ROWTYPE; f record; r record; old_cells jsonb:='{}'; new_cells jsonb:='{}'; v jsonb; prev jsonb;
 mutation rootset_control.mutations%ROWTYPE; rid varchar(26); oldrev bigint; newrev bigint; tuple_arg text; digest_arg text; before_tuple text; bucket record;
BEGIN
 SELECT * INTO STRICT tab FROM rootset_control.tables WHERE id=TG_ARGV[0] FOR UPDATE;
 IF tab.org_id IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 IF tab.state <> 'active' AND coalesce(current_setting('rootset.schema_write',true),'')<>'true' THEN RAISE EXCEPTION 'table is in maintenance' USING ERRCODE='55000'; END IF;
 SELECT * INTO mutation FROM rootset_control.mutations WHERE id=nullif(current_setting('rootset.mutation_id',true),'') AND org_id=tab.org_id AND table_id=tab.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'audited mutation context required' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN old_cells:=rootset_control.canonical_row(to_jsonb(OLD),tab.id); rid:=OLD.row_id; oldrev:=OLD.row_version; END IF;
 IF TG_OP<>'DELETE' THEN
   IF NEW.org_id<>tab.org_id THEN RAISE EXCEPTION 'row organisation is immutable' USING ERRCODE='42501'; END IF;
   IF NEW.row_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN RAISE EXCEPTION 'invalid row identifier' USING ERRCODE='23514'; END IF;
   IF TG_OP='UPDATE' AND (NEW.row_id<>OLD.row_id OR NEW.org_id<>OLD.org_id OR NEW.created_at<>OLD.created_at) THEN RAISE EXCEPTION 'system columns are immutable' USING ERRCODE='23514'; END IF;
   new_cells:=rootset_control.canonical_row(to_jsonb(NEW),tab.id); rid:=NEW.row_id;
   IF octet_length(rootset_control.canonical_json(new_cells))>65536 THEN RAISE EXCEPTION 'row exceeds 65536 canonical bytes' USING ERRCODE='23514'; END IF;
   FOR f IN SELECT definition FROM rootset_control.fields WHERE table_id=tab.id AND state='active' LOOP
     v:=new_cells->(f.definition->>'id');
     IF v='null'::jsonb THEN IF coalesce((f.definition->>'required')::boolean,false) THEN RAISE EXCEPTION 'required field is null' USING ERRCODE='23514',DETAIL=f.definition->>'apiKey'; END IF; CONTINUE; END IF;
     CASE f.definition->>'type'
     WHEN 'text' THEN IF char_length(v#>>'{}')>coalesce((f.definition->>'charLimit')::integer,4096) THEN RAISE EXCEPTION 'text character limit exceeded' USING ERRCODE='23514',DETAIL=f.definition->>'apiKey'; END IF;
     WHEN 'integer' THEN IF abs((v#>>'{}')::numeric)>9007199254740991 THEN RAISE EXCEPTION 'integer outside safe transport range' USING ERRCODE='23514'; END IF;
     WHEN 'float' THEN IF (v#>>'{}') IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'nonfinite float' USING ERRCODE='23514'; END IF;
     WHEN 'json' THEN IF rootset_control.json_depth(v)>32 OR NOT rootset_control.validate_json(v) THEN RAISE EXCEPTION 'unsupported JSON depth or number' USING ERRCODE='23514'; END IF;
     WHEN 'date' THEN IF left(v#>>'{}',4)::integer<1 OR length(v#>>'{}')<>10 THEN RAISE EXCEPTION 'date year outside supported range' USING ERRCODE='23514'; END IF;
     WHEN 'date-time' THEN IF left(v#>>'{}',4)::integer<1 OR length(v#>>'{}')<>24 THEN RAISE EXCEPTION 'date-time year outside supported range' USING ERRCODE='23514'; END IF;
     ELSE NULL;
     END CASE;
     IF f.definition ? 'min' THEN
       IF f.definition->>'type' IN ('integer','float') THEN IF (v#>>'{}')::float8<(f.definition->>'min')::float8 THEN RAISE EXCEPTION 'minimum violated' USING ERRCODE='23514'; END IF;
       ELSE IF (v#>>'{}') COLLATE "C" < (f.definition->>'min') COLLATE "C" THEN RAISE EXCEPTION 'minimum violated' USING ERRCODE='23514'; END IF; END IF;
     END IF;
     IF f.definition ? 'max' THEN
       IF f.definition->>'type' IN ('integer','float') THEN IF (v#>>'{}')::float8>(f.definition->>'max')::float8 THEN RAISE EXCEPTION 'maximum violated' USING ERRCODE='23514'; END IF;
       ELSE IF (v#>>'{}') COLLATE "C" > (f.definition->>'max') COLLATE "C" THEN RAISE EXCEPTION 'maximum violated' USING ERRCODE='23514'; END IF; END IF;
     END IF;
   END LOOP;
   IF TG_OP='UPDATE' AND old_cells=new_cells THEN NEW.row_version:=OLD.row_version; NEW.updated_at:=OLD.updated_at; RETURN NEW; END IF;
   NEW.row_version:=coalesce(oldrev,0)+1; NEW.updated_at:=clock_timestamp(); newrev:=NEW.row_version;
 END IF;
 IF TG_OP='INSERT' THEN UPDATE rootset_control.tables SET row_count=row_count+1 WHERE id=tab.id; ELSIF TG_OP='DELETE' THEN UPDATE rootset_control.tables SET row_count=row_count-1 WHERE id=tab.id; END IF;
 FOR bucket IN
   SELECT rule.id AS rule_id, dg.digest FROM rootset_control.unique_rules rule
   CROSS JOIN LATERAL (
     SELECT rootset_control.canonical_json(jsonb_agg(jsonb_build_array(field.definition->>'type',old_cells->field.id) ORDER BY ord)) AS tup
     FROM unnest(rule.field_ids) WITH ORDINALITY ids(id,ord) JOIN rootset_control.fields field ON field.id=ids.id
     HAVING bool_and(old_cells->field.id IS NOT NULL AND old_cells->field.id<>'null'::jsonb)
     UNION
     SELECT rootset_control.canonical_json(jsonb_agg(jsonb_build_array(field.definition->>'type',new_cells->field.id) ORDER BY ord))
     FROM unnest(rule.field_ids) WITH ORDINALITY ids(id,ord) JOIN rootset_control.fields field ON field.id=ids.id
     HAVING bool_and(new_cells->field.id IS NOT NULL AND new_cells->field.id<>'null'::jsonb)
   ) tuples CROSS JOIN LATERAL (SELECT rootset_control.unique_digest(tuples.tup) AS digest) dg
   WHERE rule.table_id=tab.id AND rule.state='active' AND rule.strategy='registry' ORDER BY rule.id,dg.digest
 LOOP
   INSERT INTO rootset_control.unique_buckets(rule_id,digest) VALUES(bucket.rule_id,bucket.digest) ON CONFLICT DO NOTHING;
   PERFORM 1 FROM rootset_control.unique_buckets WHERE rule_id=bucket.rule_id AND digest=bucket.digest FOR UPDATE;
 END LOOP;
 FOR r IN SELECT * FROM rootset_control.unique_rules WHERE table_id=tab.id AND state='active' AND strategy='registry' ORDER BY id LOOP
   DELETE FROM rootset_control.unique_entries WHERE rule_id=r.id AND row_id=rid;
   SELECT rootset_control.canonical_json(jsonb_agg(jsonb_build_array(field.definition->>'type',new_cells->field.id) ORDER BY ord)) INTO tuple_arg
   FROM unnest(r.field_ids) WITH ORDINALITY ids(id,ord) JOIN rootset_control.fields field ON field.id=ids.id
   HAVING bool_and(new_cells->field.id IS NOT NULL AND new_cells->field.id<>'null'::jsonb);
   IF tuple_arg IS NOT NULL AND TG_OP<>'DELETE' THEN
     digest_arg:=rootset_control.unique_digest(tuple_arg);
     IF EXISTS(SELECT 1 FROM rootset_control.unique_entries WHERE rule_id=r.id AND digest=digest_arg AND tuple=tuple_arg COLLATE "C") THEN RAISE EXCEPTION 'unique rule conflict' USING ERRCODE='23505',DETAIL=r.id; END IF;
     INSERT INTO rootset_control.unique_entries(rule_id,row_id,digest,tuple) VALUES(r.id,rid,digest_arg,tuple_arg);
   END IF;
 END LOOP;
 FOR f IN SELECT id,definition FROM rootset_control.fields WHERE table_id=tab.id AND state='active' LOOP
   prev:=coalesce(old_cells->f.id,'null'::jsonb); v:=coalesce(new_cells->f.id,'null'::jsonb);
   IF prev IS DISTINCT FROM v THEN
     INSERT INTO rootset_control.cell_changes(org_id,database_id,table_id,row_id,field_id,mutation_id,old_value,new_value,field_definition,old_version,new_version,operation,actor,context)
     VALUES(tab.org_id,tab.database_id,tab.id,rid,f.id,mutation.id,prev,v,f.definition,oldrev,newrev,lower(TG_OP),mutation.actor,mutation.context);
   END IF;
 END LOOP;
 INSERT INTO rootset_control.row_events(org_id,database_id,table_id,row_id,mutation_id,operation,old_version,new_version,actor,context)
 VALUES(tab.org_id,tab.database_id,tab.id,rid,mutation.id,lower(TG_OP),oldrev,newrev,mutation.actor,mutation.context);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['databases','tables','fields','unique_rules','indexes','schema_operations','mutations','cell_changes','row_events','resource_history','history_gaps','query_sessions'] LOOP
   EXECUTE format('ALTER TABLE rootset_control.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE rootset_control.%I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY org_isolation ON rootset_control.%I USING (org_id = nullif(current_setting(''rootset.org_id'',true),'''')) WITH CHECK (org_id = nullif(current_setting(''rootset.org_id'',true),''''))',t);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rootset_app') THEN
   GRANT USAGE ON SCHEMA rootset_control TO rootset_app;
   GRANT SELECT ON rootset_control.databases,rootset_control.tables,rootset_control.fields,rootset_control.unique_rules,rootset_control.indexes,rootset_control.schema_operations TO rootset_app;
   GRANT UPDATE(updated_at) ON rootset_control.tables TO rootset_app;
   GRANT SELECT,INSERT,UPDATE ON rootset_control.mutations TO rootset_app;
   GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.query_sessions TO rootset_app;
   GRANT SELECT ON rootset_control.cell_changes,rootset_control.row_events,rootset_control.resource_history,rootset_control.history_gaps TO rootset_app;
   GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA rootset_control TO rootset_app;
 END IF;
END $$;
REVOKE ALL ON FUNCTION rootset_control.enforce_row() FROM PUBLIC;
REVOKE ALL ON rootset_control.unique_buckets,rootset_control.unique_entries FROM PUBLIC;
REVOKE ALL ON FUNCTION rootset_control.canonical_row(jsonb,varchar) FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.databases,rootset_control.tables,rootset_control.fields,rootset_control.unique_rules,rootset_control.indexes,rootset_control.schema_operations,rootset_control.mutations,rootset_control.query_sessions,rootset_control.unique_buckets,rootset_control.unique_entries,rootset_control.cell_changes,rootset_control.row_events,rootset_control.resource_history,rootset_control.history_gaps TO rootset_ddl;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA rootset_control TO rootset_ddl;
GRANT EXECUTE ON FUNCTION rootset_control.canonical_row(jsonb,varchar) TO rootset_ddl;
