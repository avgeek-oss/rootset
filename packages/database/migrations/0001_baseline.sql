-- Rootset V1 fresh-install baseline. Regenerate this file before the first release.
-- Use pnpm db:migrate with ROOTSET_DATABASE_URL. Existing prelaunch schemas
-- are never reset automatically; use a fresh database and preserve their data.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
SET LOCAL idle_in_transaction_session_timeout = 0;
SET LOCAL transaction_timeout = 0;
SET LOCAL client_encoding = 'UTF8';
SET LOCAL standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', true);
SET LOCAL check_function_bodies = false;
SET LOCAL xmloption = content;
SET LOCAL client_min_messages = warning;
SET LOCAL row_security = off;

CREATE SCHEMA IF NOT EXISTS rootset_control;


-- Each installation has one organisation. Explicit transaction context still
-- takes precedence, so foreign organisation IDs cannot read or write its rows.
CREATE FUNCTION rootset_control.current_org_id() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$ SELECT coalesce(nullif(current_setting('rootset.org_id',true),''),(SELECT id::text FROM rootset_control.organisations)) $$;

CREATE FUNCTION rootset_control.append_operator_repair_completion(organisation_arg character varying, job_arg character varying, lease_arg character varying, mutation_arg character varying) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "TimeZone" TO 'UTC'
    SET row_security TO 'on'
    AS $_$
DECLARE j rootset_control.jobs%ROWTYPE; m rootset_control.mutations%ROWTYPE;
 t rootset_control.tables%ROWTYPE; d rootset_control.databases%ROWTYPE;
 saved_context jsonb; summary jsonb; audit_context jsonb; existing rootset_control.resource_history%ROWTYPE;
 reason text; approval text; principal_field text; schema_version_arg bigint;
 completion_count integer:=0;
BEGIN
 IF organisation_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'')
    OR coalesce(organisation_arg,'') !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    OR coalesce(job_arg,'') !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    OR coalesce(lease_arg,'') !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    OR coalesce(mutation_arg,'') !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN
   RAISE EXCEPTION 'Repair completion is not authorised' USING ERRCODE='42501';
 END IF;
 SELECT * INTO j FROM rootset_control.jobs WHERE id=job_arg AND org_id=organisation_arg
   AND kind='operation' AND operation_id='mutateRows' AND state='running'
   AND NOT cancel_requested AND lease_token=lease_arg AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair lease is not current' USING ERRCODE='42501'; END IF;
 IF j.state IS DISTINCT FROM 'running' OR j.cancel_requested IS DISTINCT FROM false
    OR j.lease_token IS DISTINCT FROM lease_arg OR j.lease_until IS NULL
    OR j.lease_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'Repair lease is not current' USING ERRCODE='42501';
 END IF;
 SELECT * INTO m FROM rootset_control.mutations WHERE id=mutation_arg AND org_id=organisation_arg;
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair mutation is not authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM rootset_control.tables WHERE id=m.table_id AND org_id=organisation_arg AND state='active';
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair table is not active' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM rootset_control.databases WHERE id=t.database_id AND org_id=organisation_arg AND state='active';
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair database is not active' USING ERRCODE='42501'; END IF;
 saved_context:=j.input->'operationContext'; reason:=j.input#>>'{repair,reason}'; approval:=saved_context->>'approvalId';
 IF jsonb_typeof(j.input->'expectedSchemaVersion') IS DISTINCT FROM 'number'
    OR coalesce(j.input->>'expectedSchemaVersion','') !~ '^[1-9][0-9]{0,9}$' THEN
   RAISE EXCEPTION 'Repair schema version is not authorised' USING ERRCODE='42501';
 END IF;
 schema_version_arg:=(j.input->>'expectedSchemaVersion')::bigint;
 IF schema_version_arg>2147483647 THEN
   RAISE EXCEPTION 'Repair schema version is not authorised' USING ERRCODE='42501';
 END IF;
 IF j.target_type IS DISTINCT FROM 'table' OR j.target_id::text IS DISTINCT FROM t.id
   OR j.input->>'orgId' IS DISTINCT FROM organisation_arg
   OR j.input->>'databaseId' IS DISTINCT FROM d.id OR j.input->>'tableId' IS DISTINCT FROM t.id
   OR j.requester_id IS DISTINCT FROM (j.actor->>'kind')||':'||(j.actor->>'id')
   OR jsonb_typeof(j.input->'repair') IS DISTINCT FROM 'object'
   OR jsonb_typeof(j.input#>'{repair,reason}') IS DISTINCT FROM 'string'
   OR reason IS NULL OR reason='' OR char_length(reason)>512
   OR (SELECT sum(CASE WHEN ascii(code_point)>65535 THEN 2 ELSE 1 END)
       FROM regexp_split_to_table(reason,'') AS characters(code_point))>512
   OR reason<>btrim(reason,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||' '||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
   OR approval IS NULL OR approval !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
   OR saved_context->>'source' IS DISTINCT FROM 'operator'
   OR saved_context->'stepUpApproved' IS DISTINCT FROM 'true'::jsonb
   OR saved_context->'admissionStepUpApproved' IS DISTINCT FROM 'true'::jsonb
   OR saved_context->>'idempotencyKey' IS DISTINCT FROM j.idempotency_key
   OR coalesce(saved_context->>'admissionBinding','') !~ '^v1:[a-f0-9]{64}$'
   OR jsonb_typeof(saved_context->'admissionFields') IS DISTINCT FROM 'array'
   OR coalesce(saved_context->>'admissionSource','') NOT IN('browser','rest','mcp','operator')
   OR m.idempotency_key IS DISTINCT FROM 'job:'||job_arg||':operation'
   OR m.actor->>'role' IS DISTINCT FROM 'admin'
   OR coalesce(m.actor->>'kind','') NOT IN('session','personal_key','oauth','operator')
   OR coalesce(m.actor->>'id','')=''
   OR coalesce(m.actor->>'userId','') !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
   OR m.actor->>'orgId' IS DISTINCT FROM organisation_arg
   OR m.context->>'source' IS DISTINCT FROM 'operator' OR m.context->>'jobId' IS DISTINCT FROM job_arg
   OR m.context->>'requestId' IS DISTINCT FROM coalesce(saved_context->>'requestId',job_arg)
   OR m.schema_version<>t.schema_version
   OR schema_version_arg<>m.schema_version
   OR m.outcome IS NULL OR m.outcome->>'mutationId' IS DISTINCT FROM mutation_arg
   OR m.outcome->>'schemaVersion' IS DISTINCT FROM m.schema_version::text
   OR jsonb_typeof(m.outcome->'rows') IS DISTINCT FROM 'array'
   OR m.outcome->'deletedIds' IS DISTINCT FROM '[]'::jsonb
   OR jsonb_typeof(j.input->'mutations') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Repair provenance is not authorised' USING ERRCODE='42501';
 END IF;
 FOREACH principal_field IN ARRAY ARRAY['kind','id','orgId','userId','credentialId','clientId'] LOOP
   IF j.actor->>principal_field IS DISTINCT FROM m.actor->>principal_field THEN
     RAISE EXCEPTION 'Repair principal does not match' USING ERRCODE='42501';
   END IF;
 END LOOP;
 IF jsonb_array_length(j.input->'mutations') NOT BETWEEN 1 AND 1000
   OR jsonb_array_length(j.input->'mutations')<>jsonb_array_length(m.outcome->'rows')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(j.input->'mutations') WITH ORDINALITY op(value,position)
      WHERE op.value->>'type' IS DISTINCT FROM 'update'
        OR coalesce(op.value->>'rowId','') !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
        OR jsonb_typeof(op.value->'expectedVersion') IS DISTINCT FROM 'string'
        OR coalesce(op.value->>'expectedVersion','') !~ '^[1-9][0-9]{0,18}$'
        OR (length(op.value->>'expectedVersion')=19 AND
            (op.value->>'expectedVersion') COLLATE "C">'9223372036854775807' COLLATE "C")
        OR jsonb_typeof(op.value->'values') IS DISTINCT FROM 'object'
        OR op.value->>'rowId' IS DISTINCT FROM m.outcome->'rows'->(op.position::integer-1)->>'id') THEN
   RAISE EXCEPTION 'Repair outcome does not match its updates' USING ERRCODE='42501';
 END IF;
 summary:=jsonb_build_object('reason',reason,'approvalId',approval,'jobId',job_arg,'mutationId',mutation_arg);
 audit_context:=jsonb_build_object('requestId',m.context->>'requestId','source','operator','jobId',job_arg);
 FOR existing IN SELECT * FROM rootset_control.resource_history WHERE org_id=organisation_arg
   AND operation='operatorRepair' AND after_value->>'mutationId'=mutation_arg LOOP
   completion_count:=completion_count+1;
   IF completion_count>1 THEN
     RAISE EXCEPTION 'Repair completion is not singular' USING ERRCODE='42501';
   END IF;
   IF existing.database_id IS DISTINCT FROM d.id OR existing.table_id IS DISTINCT FROM t.id
      OR existing.resource_id IS DISTINCT FROM t.id OR existing.before_value IS NOT NULL
      OR existing.after_value IS DISTINCT FROM summary OR existing.actor IS DISTINCT FROM m.actor
      OR existing.context IS DISTINCT FROM audit_context THEN
     RAISE EXCEPTION 'Repair completion conflicts with its receipt' USING ERRCODE='42501';
   END IF;
 END LOOP;
 IF completion_count=1 THEN RETURN; END IF;
 INSERT INTO rootset_control.resource_history(org_id,database_id,table_id,resource_id,operation,before_value,after_value,actor,context)
 VALUES(organisation_arg,d.id,t.id,t.id,'operatorRepair',NULL,summary,m.actor,audit_context);
END $_$;


CREATE FUNCTION rootset_control.canonical_json(v jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE output text;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN
   SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||rootset_control.canonical_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO output FROM jsonb_each(v);
   RETURN output;
 WHEN 'array' THEN
   SELECT '['||coalesce(string_agg(rootset_control.canonical_json(value),',' ORDER BY ord),'')||']' INTO output FROM jsonb_array_elements(v) WITH ORDINALITY item(value,ord);
   RETURN output;
 WHEN 'number' THEN RETURN rootset_control.canonical_number(v::text::numeric);
 ELSE RETURN v::text;
 END CASE;
END $$;


CREATE FUNCTION rootset_control.canonical_number(value_arg numeric) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE original float8:=value_arg::float8; approximate numeric; candidate numeric; magnitude integer;
 precision_arg integer; output text; integer_part text; fraction_part text; digits text; exponent_arg integer; negative_arg text;
BEGIN
 IF original=0 THEN RETURN '0'; END IF;
 approximate:=original::text::numeric;
 magnitude:=floor(log(10::numeric,abs(approximate)))::integer;
 FOR precision_arg IN 1..17 LOOP
   candidate:=round(approximate,precision_arg-1-magnitude);
   BEGIN
     IF candidate::float8=original THEN EXIT; END IF;
   EXCEPTION WHEN numeric_value_out_of_range THEN NULL;
   END;
 END LOOP;
 negative_arg:=CASE WHEN candidate<0 THEN '-' ELSE '' END;
 output:=abs(candidate)::text;
 integer_part:=split_part(output,'.',1);
 fraction_part:=rtrim(split_part(output,'.',2),'0');
 IF integer_part='0' THEN exponent_arg:=-1-(length(fraction_part)-length(ltrim(fraction_part,'0')));
 ELSE exponent_arg:=length(integer_part)-1; END IF;
 IF exponent_arg>=-6 AND exponent_arg<21 THEN
   RETURN negative_arg||integer_part||CASE WHEN fraction_part<>'' THEN '.'||fraction_part ELSE '' END;
 END IF;
 digits:=rtrim(ltrim(integer_part||fraction_part,'0'),'0');
 RETURN negative_arg||left(digits,1)||CASE WHEN length(digits)>1 THEN '.'||substr(digits,2) ELSE '' END
   ||'e'||CASE WHEN exponent_arg>=0 THEN '+' ELSE '' END||exponent_arg::text;
END $$;


CREATE FUNCTION rootset_control.canonical_row(record_json jsonb, table_id_arg character varying) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'rootset_control'
    AS $$
DECLARE result jsonb:='{}'; f record;
BEGIN
 FOR f IN SELECT id,definition FROM rootset_control.fields WHERE table_id=table_id_arg AND state='active' ORDER BY id COLLATE "C" LOOP
   result:=result||jsonb_build_object(f.id,rootset_control.cell_value(record_json,f.definition));
 END LOOP;
 RETURN result;
END $$;


CREATE FUNCTION rootset_control.cell_value(record_json jsonb, f jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
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


CREATE FUNCTION rootset_control.enforce_row() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'rootset_control'
    SET "TimeZone" TO 'UTC'
    AS $_$
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
     IF v='null'::jsonb THEN IF coalesce((f.definition->>'required')::boolean,false) THEN RAISE EXCEPTION 'required field is null' USING ERRCODE='23514',DETAIL=f.definition->>'name'; END IF; CONTINUE; END IF;
     CASE f.definition->>'type'
     WHEN 'text' THEN IF char_length(v#>>'{}')>coalesce((f.definition->>'charLimit')::integer,4096) THEN RAISE EXCEPTION 'text character limit exceeded' USING ERRCODE='23514',DETAIL=f.definition->>'name'; END IF;
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
   IF TG_OP<>'DELETE' AND prev IS DISTINCT FROM v THEN
     INSERT INTO rootset_control.cell_changes(org_id,database_id,table_id,row_id,field_id,mutation_id,old_value,new_value,field_definition,old_version,new_version,operation,actor,context)
     VALUES(tab.org_id,tab.database_id,tab.id,rid,f.id,mutation.id,prev,v,f.definition,oldrev,newrev,lower(TG_OP),mutation.actor,mutation.context);
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN
   DELETE FROM rootset_control.cell_changes WHERE org_id=tab.org_id AND table_id=tab.id AND row_id=rid;
   RETURN OLD;
 ELSE RETURN NEW; END IF;
END $_$;



CREATE FUNCTION rootset_control.json_depth(v jsonb) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE d integer;
BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT max(rootset_control.json_depth(value)) INTO d FROM jsonb_each(v); RETURN 1+coalesce(d,0); END IF;
 IF jsonb_typeof(v)='array' THEN SELECT max(rootset_control.json_depth(value)) INTO d FROM jsonb_array_elements(v); RETURN 1+coalesce(d,0); END IF;
 RETURN 0;
END $$;




CREATE FUNCTION rootset_control.new_ulid() RETURNS character varying
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE alphabet text:='0123456789ABCDEFGHJKMNPQRSTVWXYZ'; entropy bytea; value numeric; output text:=''; i integer;
BEGIN
 entropy:=public.gen_random_bytes(10);
 value:=floor(extract(epoch FROM clock_timestamp())*1000)*1208925819614629174706176;
 FOR i IN 0..9 LOOP value:=value+get_byte(entropy,i)::numeric*power(256::numeric,9-i); END LOOP;
 FOR i IN 1..26 LOOP output:=substr(alphabet,mod(value,32)::integer+1,1)||output;value:=trunc(value/32); END LOOP;
 RETURN output::varchar(26);
END $$;


CREATE FUNCTION rootset_control.oauth_grant_active(grant_id text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    SET "TimeZone" TO 'UTC'
    AS $$ SELECT EXISTS(SELECT 1 FROM rootset_control.oauth_grants g JOIN rootset_control.users u ON u.id=g.user_id JOIN rootset_control.memberships m ON m.user_id=u.id AND m.org_id=g.org_id WHERE g.id=grant_id AND g.revoked_at IS NULL AND u.email_verified) $$;


CREATE FUNCTION rootset_control.operator_metrics() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    SET "TimeZone" TO 'UTC'
    AS $_$
 WITH database_stats AS (
  SELECT * FROM pg_stat_database WHERE datname=current_database()
 ), connection_stats AS (
  SELECT count(*)::integer total,
   count(*) FILTER(WHERE state='active')::integer active,
   count(*) FILTER(WHERE state='idle')::integer idle,
   count(*) FILTER(WHERE state LIKE 'idle in transaction%')::integer idle_in_transaction,
   greatest(0,extract(epoch FROM (statement_timestamp()-min(xact_start)))) oldest_transaction_seconds
  FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend'
 ), job_stats AS (
  SELECT count(*) FILTER(WHERE state='queued')::integer queued,
   count(*) FILTER(WHERE state='running')::integer running,
   count(*) FILTER(WHERE state='failed')::integer failed,
   count(*) FILTER(WHERE state='running' AND lease_until<statement_timestamp())::integer expired_leases,
   greatest(0,extract(epoch FROM (statement_timestamp()-min(created_at) FILTER(WHERE state='queued')))) oldest_queued_seconds,
   count(*) FILTER(WHERE attempt>1)::integer retried
  FROM rootset_control.jobs
 ), email_stats AS (
  SELECT count(*) FILTER(WHERE state='pending')::integer pending,
   count(*) FILTER(WHERE state='sending')::integer sending,
   count(*) FILTER(WHERE state='failed')::integer failed,
   count(*) FILTER(WHERE state='pending' AND attempts>0)::integer retrying,
   greatest(0,extract(epoch FROM (statement_timestamp()-min(created_at) FILTER(WHERE state IN ('pending','sending'))))) oldest_pending_seconds
  FROM rootset_control.email_outbox
 ), schema_stats AS (
  SELECT count(*) FILTER(WHERE state NOT IN ('committed','failed','historical'))::integer pending,
   count(*) FILTER(WHERE state='failed')::integer failed FROM rootset_control.schema_operations
 ), native_stats AS (
  SELECT coalesce(sum(pg_table_size(c.oid)),0)::bigint data_bytes,
   coalesce(sum(pg_indexes_size(c.oid)),0)::bigint index_bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname ~ '^rsd_[a-z0-9]{26}$' AND c.relkind='r' AND c.relname ~ '^rst_[a-z0-9]{26}(_g[0-9]+)?$'
 ), invalid_index_stats AS (
  SELECT count(*)::integer invalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname ~ '^rsd_[a-z0-9]{26}$' AND NOT i.indisvalid
 ), table_stats AS (
  SELECT count(*) FILTER(WHERE state IN ('active','maintenance'))::integer active,
   count(*) FILTER(WHERE state='deleted')::integer retained,
   coalesce(sum(row_count) FILTER(WHERE state IN ('active','maintenance')),0)::bigint live_rows
  FROM rootset_control.tables
 ), history_stats AS (
  SELECT coalesce(sum(events),0)::bigint events,coalesce(sum(tuple_bytes),0)::bigint bytes FROM rootset_control.history_metrics
 ), artifact_stats AS (
  SELECT coalesce(sum(ciphertext_length),0)::bigint bytes FROM rootset_control.artifacts
  WHERE state NOT IN ('deleted','expired') AND expires_at>statement_timestamp()
 ), worker_stats AS (
  SELECT count(*) FILTER(WHERE state='ready' AND heartbeat_at>statement_timestamp()-interval '30 seconds')::integer fresh_ready,
   count(*) FILTER(WHERE heartbeat_at<=statement_timestamp()-interval '30 seconds')::integer stale,
   count(*) FILTER(WHERE state='degraded' AND heartbeat_at>statement_timestamp()-interval '30 seconds')::integer degraded
  FROM rootset_control.worker_heartbeats
 )
 SELECT jsonb_build_object(
  'databaseBytes',pg_database_size(current_database())::text,
  'temporaryBytes',coalesce(d.temp_bytes,0)::text,
  'temporaryFiles',coalesce(d.temp_files,0)::text,
  'walDirectoryBytes',NULL,
  'walGeneratedBytes',trunc(w.wal_bytes)::text,
  'walRecords',w.wal_records::text,
  'transactionsCommitted',coalesce(d.xact_commit,0)::text,
  'transactionsRolledBack',coalesce(d.xact_rollback,0)::text,
  'deadlocks',coalesce(d.deadlocks,0)::text,
  'connections',jsonb_build_object('total',c.total,'active',c.active,'idle',c.idle,'idleInTransaction',c.idle_in_transaction,'maximum',current_setting('max_connections')::integer,'oldestTransactionSeconds',c.oldest_transaction_seconds),
  'jobs',jsonb_build_object('queued',j.queued,'running',j.running,'failed',j.failed,'expiredLeases',j.expired_leases,'oldestQueuedSeconds',j.oldest_queued_seconds,'retried',j.retried),
  'email',jsonb_build_object('pending',e.pending,'sending',e.sending,'failed',e.failed,'retrying',e.retrying,'oldestPendingSeconds',e.oldest_pending_seconds),
  'schema',jsonb_build_object('pending',s.pending,'failed',s.failed,'invalidIndexes',ix.invalid),
  'workers',jsonb_build_object('freshReady',h.fresh_ready,'stale',h.stale,'degraded',h.degraded),
  'storage',jsonb_build_object('activeDatabases',(SELECT count(*) FROM rootset_control.databases WHERE state='active'),'activeTables',t.active,'retainedTables',t.retained,'liveRows',t.live_rows::text,'dataBytes',n.data_bytes::text,'indexBytes',n.index_bytes::text,'historyEvents',a.events::text,'historyBytes',a.bytes::text,'artifactBytes',o.bytes::text),
  'statisticsResetAt',d.stats_reset,
  'walStatisticsResetAt',w.stats_reset
 ) FROM connection_stats c CROSS JOIN job_stats j CROSS JOIN email_stats e CROSS JOIN schema_stats s CROSS JOIN invalid_index_stats ix CROSS JOIN native_stats n CROSS JOIN table_stats t CROSS JOIN history_stats a CROSS JOIN artifact_stats o CROSS JOIN worker_stats h CROSS JOIN pg_stat_wal w LEFT JOIN database_stats d ON true
$_$;


CREATE FUNCTION rootset_control.track_history_metrics() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO rootset_control.history_metrics(org_id,table_id,events,tuple_bytes) VALUES(NEW.org_id,NEW.table_id,1,pg_column_size(NEW))
  ON CONFLICT(org_id,table_id) DO UPDATE SET events=rootset_control.history_metrics.events+1,tuple_bytes=rootset_control.history_metrics.tuple_bytes+EXCLUDED.tuple_bytes;
  RETURN NEW;
 ELSE
  UPDATE rootset_control.history_metrics SET events=events-1,tuple_bytes=greatest(0,tuple_bytes-pg_column_size(OLD)) WHERE org_id=OLD.org_id AND table_id=OLD.table_id;
  RETURN OLD;
 END IF;
END $$;


CREATE FUNCTION rootset_control.unique_digest(tuple_arg text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$ SELECT encode(public.digest(convert_to(tuple_arg,'UTF8'),'sha256'),'hex') $$;


CREATE FUNCTION rootset_control.validate_json(v jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog'
    AS $$
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



SET LOCAL default_tablespace = '';

SET LOCAL default_table_access_method = heap;

CREATE TABLE rootset_control.account_actions (
    id character varying(26) NOT NULL,
    user_id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    actor_id text NOT NULL,
    client_id text,
    operation text NOT NULL,
    payload_encrypted text NOT NULL,
    digest text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_at timestamp with time zone,
    consumed_at timestamp with time zone,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY rootset_control.account_actions FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.api_admissions (
    id text NOT NULL,
    principal text NOT NULL,
    read_only boolean NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


CREATE TABLE rootset_control.api_keys (
    id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    user_id character varying(26) NOT NULL,
    creator_user_id character varying(26),
    name character varying(120) NOT NULL,
    secret_hash text NOT NULL,
    prefix text NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    rotated_from character varying(26),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY rootset_control.api_keys FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.api_rate_windows (
    principal text NOT NULL,
    window_start bigint NOT NULL,
    requests integer NOT NULL
);


CREATE TABLE rootset_control.artifacts (
    id character(26) NOT NULL,
    org_id character(26) NOT NULL,
    job_id character(26),
    requester_id text NOT NULL,
    target_type text NOT NULL,
    target_id character(26) NOT NULL,
    purpose text NOT NULL,
    object_key text NOT NULL,
    state text NOT NULL,
    format text NOT NULL,
    media_type text NOT NULL,
    declared_bytes bigint,
    byte_length bigint,
    ciphertext_length bigint,
    checksum text,
    ciphertext_checksum text,
    iv text,
    tag text,
    expected_checksum text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifacts_state_check CHECK ((state = ANY (ARRAY['upload_pending'::text, 'uploading'::text, 'ready'::text, 'expired'::text, 'deleting'::text, 'deleted'::text, 'failed'::text]))),
    CONSTRAINT artifacts_target_type_check CHECK ((target_type = ANY (ARRAY['table'::text, 'database'::text, 'organisation'::text])))
);

ALTER TABLE ONLY rootset_control.artifacts FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.auth_accounts (
    id character varying(26) NOT NULL,
    user_id character varying(26) NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.auth_passkeys (
    id character varying(26) NOT NULL,
    user_id character varying(26) NOT NULL,
    name character varying(120),
    public_key text NOT NULL,
    credential_id text NOT NULL,
    counter integer NOT NULL,
    device_type text NOT NULL,
    backed_up boolean NOT NULL,
    transports text,
    aaguid text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.auth_recovery_codes (
    user_id character varying(26) NOT NULL,
    code_hashes text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.auth_verifications (
    id character varying(26) NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.bootstrap (
    singleton boolean DEFAULT true NOT NULL,
    org_id character varying(26),
    user_id character varying(26),
    claimed_at timestamp with time zone,
    verified_at timestamp with time zone,
    claim_digest text,
    CONSTRAINT bootstrap_singleton_check CHECK (singleton)
);


CREATE TABLE rootset_control.cell_changes (
    id bigint NOT NULL,
    org_id character varying(26) NOT NULL,
    database_id character varying(26) NOT NULL,
    table_id character varying(26) NOT NULL,
    row_id character varying(26) NOT NULL,
    field_id character varying(26) NOT NULL,
    mutation_id character varying(26) NOT NULL,
    old_value jsonb,
    new_value jsonb,
    field_definition jsonb NOT NULL,
    old_version bigint,
    new_version bigint,
    operation text NOT NULL,
    actor jsonb NOT NULL,
    context jsonb NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    public_id character varying(26) DEFAULT rootset_control.new_ulid() NOT NULL
)
PARTITION BY RANGE (changed_at);

ALTER TABLE ONLY rootset_control.cell_changes FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.cell_changes_default (
    id bigint CONSTRAINT cell_changes_id_not_null NOT NULL,
    org_id character varying(26) CONSTRAINT cell_changes_org_id_not_null NOT NULL,
    database_id character varying(26) CONSTRAINT cell_changes_database_id_not_null NOT NULL,
    table_id character varying(26) CONSTRAINT cell_changes_table_id_not_null NOT NULL,
    row_id character varying(26) CONSTRAINT cell_changes_row_id_not_null NOT NULL,
    field_id character varying(26) CONSTRAINT cell_changes_field_id_not_null NOT NULL,
    mutation_id character varying(26) CONSTRAINT cell_changes_mutation_id_not_null NOT NULL,
    old_value jsonb,
    new_value jsonb,
    field_definition jsonb CONSTRAINT cell_changes_field_definition_not_null NOT NULL,
    old_version bigint,
    new_version bigint,
    operation text CONSTRAINT cell_changes_operation_not_null NOT NULL,
    actor jsonb CONSTRAINT cell_changes_actor_not_null NOT NULL,
    context jsonb CONSTRAINT cell_changes_context_not_null NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT cell_changes_changed_at_not_null NOT NULL,
    public_id character varying(26) DEFAULT rootset_control.new_ulid() CONSTRAINT cell_changes_public_id_not_null NOT NULL
);

ALTER TABLE ONLY rootset_control.cell_changes_default FORCE ROW LEVEL SECURITY;


ALTER TABLE rootset_control.cell_changes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME rootset_control.cell_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE rootset_control.control_mutation_replays (
    org_id character varying(26) NOT NULL,
    principal_binding character(64) NOT NULL,
    operation_id text NOT NULL,
    key_digest character(64) NOT NULL,
    input_digest character(64) NOT NULL,
    outcome jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT control_mutation_replays_operation_id_check CHECK (((length(operation_id) >= 1) AND (length(operation_id) <= 120)))
);

ALTER TABLE ONLY rootset_control.control_mutation_replays FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.databases (
    id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    schema_name text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT databases_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200))),
    CONSTRAINT databases_schema_name_check CHECK ((schema_name ~ '^rsd_[a-z0-9]{26}$'::text))
);

ALTER TABLE ONLY rootset_control.databases FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.email_changes (
    id character varying(26) NOT NULL,
    user_id character varying(26) NOT NULL,
    previous_email character varying(320) NOT NULL,
    new_email character varying(320) NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.email_outbox (
    id character varying(26) NOT NULL,
    to_address text NOT NULL,
    template text NOT NULL,
    payload_encrypted text NOT NULL,
    dedupe_key text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    last_error text,
    provider_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT email_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text])))
);


CREATE TABLE rootset_control.fields (
    id character varying(26) NOT NULL,
    table_id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    name character varying(64) NOT NULL,
    definition jsonb NOT NULL,
    "position" integer NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT fields_name_check CHECK ((((name)::text ~ '^[A-Za-z_]+$'::text) AND (lower((name)::text) <> ALL (ARRAY['id'::text, 'version'::text, 'createdat'::text, 'updatedat'::text, '__proto__'::text, 'prototype'::text, 'constructor'::text]))))
);

ALTER TABLE ONLY rootset_control.fields FORCE ROW LEVEL SECURITY;










CREATE TABLE rootset_control.history_metrics (
    org_id character varying(26) NOT NULL,
    table_id character varying(26) NOT NULL,
    events bigint NOT NULL,
    tuple_bytes bigint NOT NULL,
    CONSTRAINT history_metrics_events_check CHECK ((events >= 0)),
    CONSTRAINT history_metrics_tuple_bytes_check CHECK ((tuple_bytes >= 0))
);

ALTER TABLE ONLY rootset_control.history_metrics FORCE ROW LEVEL SECURITY;





CREATE TABLE rootset_control.identity_rate_limits (
    bucket_hash text NOT NULL,
    attempts integer NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


CREATE TABLE rootset_control.import_batches (
    job_id character(26) NOT NULL,
    org_id character(26) NOT NULL,
    start_record bigint NOT NULL,
    end_record bigint NOT NULL,
    plan jsonb NOT NULL,
    state text DEFAULT 'planned'::text NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT import_batches_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'committed'::text])))
);

ALTER TABLE ONLY rootset_control.import_batches FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.import_rejections (
    job_id character(26) NOT NULL,
    org_id character(26) NOT NULL,
    record_number bigint NOT NULL,
    code text NOT NULL,
    message text NOT NULL,
    field text
);

ALTER TABLE ONLY rootset_control.import_rejections FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.invitations (
    id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    email character varying(320) NOT NULL,
    role text NOT NULL,
    inviter_id character varying(26) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    accepted_by character varying(26),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text, 'viewer'::text]))),
    CONSTRAINT invitations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'accepted'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY rootset_control.invitations FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.jobs (
    id character(26) NOT NULL,
    org_id character(26) NOT NULL,
    kind text NOT NULL,
    operation_id text NOT NULL,
    actor jsonb NOT NULL,
    requester_id text NOT NULL,
    target_type text NOT NULL,
    target_id character(26) NOT NULL,
    input jsonb NOT NULL,
    input_digest text NOT NULL,
    idempotency_key text NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    stage text DEFAULT 'queued'::text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    lease_token character(26),
    lease_until timestamp with time zone,
    heartbeat_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    progress jsonb DEFAULT '{"rejected": 0, "committed": 0}'::jsonb NOT NULL,
    result jsonb,
    error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT jobs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'partially_completed'::text]))),
    CONSTRAINT jobs_target_type_check CHECK ((target_type = ANY (ARRAY['table'::text, 'database'::text, 'organisation'::text])))
);

ALTER TABLE ONLY rootset_control.jobs FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.key_requests (
    actor_id text NOT NULL,
    org_id character varying(26) NOT NULL,
    operation text NOT NULL,
    key text NOT NULL,
    digest text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY rootset_control.key_requests FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.memberships (
    id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    user_id character varying(26) NOT NULL,
    role text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text, 'viewer'::text])))
);

ALTER TABLE ONLY rootset_control.memberships FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.mutations (
    id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    table_id character varying(26) NOT NULL,
    idempotency_key text,
    input_hash text NOT NULL,
    actor jsonb NOT NULL,
    context jsonb NOT NULL,
    schema_version bigint NOT NULL,
    outcome jsonb,
    committed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY rootset_control.mutations FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.oauth_clients (
    client_id text NOT NULL,
    metadata jsonb NOT NULL,
    provenance text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_clients_provenance_check CHECK ((provenance = ANY (ARRAY['registered'::text, 'metadata'::text, 'dynamic'::text])))
);


CREATE TABLE rootset_control.oauth_codes (
    digest text NOT NULL,
    grant_id text NOT NULL,
    request_id text NOT NULL,
    redirect_uri text NOT NULL,
    challenge text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone
);


CREATE TABLE rootset_control.oauth_families (
    id text NOT NULL,
    grant_id text NOT NULL,
    absolute_expires_at timestamp with time zone NOT NULL,
    inactivity_expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.oauth_grants (
    id text NOT NULL,
    client_id text NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    resource text NOT NULL,
    scopes text[] NOT NULL,
    actor jsonb NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.oauth_requests (
    id text NOT NULL,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    resource text NOT NULL,
    scopes text[] NOT NULL,
    org_id text,
    user_id text,
    state text,
    challenge text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    CONSTRAINT oauth_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])))
);


CREATE TABLE rootset_control.oauth_tokens (
    digest text NOT NULL,
    family_id text NOT NULL,
    kind text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_tokens_kind_check CHECK ((kind = ANY (ARRAY['access'::text, 'refresh'::text])))
);


CREATE TABLE rootset_control.operation_outcomes (
    job_id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    operation_id text NOT NULL,
    job_input_digest text NOT NULL,
    result jsonb NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY rootset_control.operation_outcomes FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.organisations (
    id character varying(26) NOT NULL,
    name character varying(120) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    CONSTRAINT organisations_singleton_check CHECK (singleton)
);




CREATE TABLE rootset_control.query_sessions (
    id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    table_id character varying(26) NOT NULL,
    schema_version bigint NOT NULL,
    query_hash text NOT NULL,
    grant_hash text NOT NULL,
    anchors jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY rootset_control.query_sessions FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.resource_history (
    id bigint NOT NULL,
    org_id character varying(26) NOT NULL,
    database_id character varying(26),
    table_id character varying(26),
    resource_id character varying(26) NOT NULL,
    operation text NOT NULL,
    before_value jsonb,
    after_value jsonb,
    actor jsonb NOT NULL,
    context jsonb NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY rootset_control.resource_history FORCE ROW LEVEL SECURITY;


ALTER TABLE rootset_control.resource_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME rootset_control.resource_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);






CREATE TABLE rootset_control.schema_operations (
    id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    database_id character varying(26) NOT NULL,
    table_id character varying(26),
    idempotency_key text NOT NULL,
    input_hash text NOT NULL,
    expected_version bigint,
    kind text NOT NULL,
    before_definition jsonb,
    after_definition jsonb,
    plan jsonb,
    state text DEFAULT 'planned'::text NOT NULL,
    error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone
);

ALTER TABLE ONLY rootset_control.schema_operations FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.sessions (
    id character varying(26) NOT NULL,
    user_id character varying(26) NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE rootset_control.tables (
    id character varying(26) NOT NULL,
    database_id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    name text NOT NULL,
    physical_name text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    schema_version bigint DEFAULT 1 NOT NULL,
    row_count bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    description text DEFAULT ''::text NOT NULL,
    CONSTRAINT tables_description_check CHECK ((char_length(description) <= 4096)),
    CONSTRAINT tables_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200))),
    CONSTRAINT tables_physical_name_check CHECK ((physical_name ~ '^rst_[a-z0-9]{26}(_g[0-9]+)?$'::text)),
    CONSTRAINT tables_row_count_check CHECK (((row_count >= 0) AND (row_count <= 5000000)))
);

ALTER TABLE ONLY rootset_control.tables FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.unique_buckets (
    rule_id character varying(26) NOT NULL,
    digest text NOT NULL
);

ALTER TABLE ONLY rootset_control.unique_buckets FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.unique_entries (
    rule_id character varying(26) NOT NULL,
    row_id character varying(26) NOT NULL,
    digest text NOT NULL,
    tuple text NOT NULL COLLATE pg_catalog."C"
);

ALTER TABLE ONLY rootset_control.unique_entries FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.unique_rules (
    id character varying(26) NOT NULL,
    table_id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    name text NOT NULL,
    field_ids character varying(26)[] NOT NULL,
    strategy text NOT NULL,
    physical_name text,
    state text DEFAULT 'building'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    error jsonb,
    CONSTRAINT unique_rules_field_ids_check CHECK (((cardinality(field_ids) >= 1) AND (cardinality(field_ids) <= 8))),
    CONSTRAINT unique_rules_strategy_check CHECK ((strategy = ANY (ARRAY['native'::text, 'registry'::text])))
);

ALTER TABLE ONLY rootset_control.unique_rules FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.user_preferences (
    user_id character varying(26) NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    date_format text DEFAULT 'day-short-month-year'::text NOT NULL,
    time_format text DEFAULT '24-hour'::text NOT NULL,
    theme text DEFAULT 'system'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_preferences_date_format_check CHECK ((date_format = ANY (ARRAY['day-short-month-year'::text, 'short-month-day-year'::text, 'year-month-day'::text, 'day-month-year'::text, 'month-day-year'::text]))),
    CONSTRAINT user_preferences_theme_check CHECK ((theme = ANY (ARRAY['system'::text, 'light'::text, 'dark'::text]))),
    CONSTRAINT user_preferences_time_format_check CHECK ((time_format = ANY (ARRAY['24-hour'::text, '12-hour'::text, '24-hour-seconds'::text, '12-hour-seconds'::text])))
);


CREATE TABLE rootset_control.users (
    id character varying(26) NOT NULL,
    name character varying(120) NOT NULL,
    email character varying(320) NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    authentication_version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_email_check CHECK (((email)::text = lower(TRIM(BOTH FROM email))))
);


CREATE TABLE rootset_control.view_preferences (
    user_id character varying(26) NOT NULL,
    org_id character varying(26) NOT NULL,
    table_id character varying(26) NOT NULL,
    preferences jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY rootset_control.view_preferences FORCE ROW LEVEL SECURITY;


CREATE TABLE rootset_control.worker_heartbeats (
    id character varying(26) NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    state text NOT NULL,
    last_error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_heartbeats_state_check CHECK ((state = ANY (ARRAY['starting'::text, 'ready'::text, 'degraded'::text, 'stopped'::text])))
);


ALTER TABLE ONLY rootset_control.cell_changes ATTACH PARTITION rootset_control.cell_changes_default DEFAULT;

ALTER TABLE ONLY rootset_control.account_actions
    ADD CONSTRAINT account_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.api_admissions
    ADD CONSTRAINT api_admissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.api_rate_windows
    ADD CONSTRAINT api_rate_windows_pkey PRIMARY KEY (principal, window_start);

ALTER TABLE ONLY rootset_control.artifacts
    ADD CONSTRAINT artifacts_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY rootset_control.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.auth_accounts
    ADD CONSTRAINT auth_accounts_provider_id_account_id_key UNIQUE (provider_id, account_id);

ALTER TABLE ONLY rootset_control.auth_passkeys
    ADD CONSTRAINT auth_passkeys_credential_id_key UNIQUE (credential_id);

ALTER TABLE ONLY rootset_control.auth_passkeys
    ADD CONSTRAINT auth_passkeys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY rootset_control.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.bootstrap
    ADD CONSTRAINT bootstrap_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY rootset_control.control_mutation_replays
    ADD CONSTRAINT control_mutation_replays_pkey PRIMARY KEY (org_id, principal_binding, operation_id, key_digest);

ALTER TABLE ONLY rootset_control.databases
    ADD CONSTRAINT databases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.databases
    ADD CONSTRAINT databases_schema_name_key UNIQUE (schema_name);

ALTER TABLE ONLY rootset_control.email_changes
    ADD CONSTRAINT email_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.email_changes
    ADD CONSTRAINT email_changes_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY rootset_control.email_changes
    ADD CONSTRAINT email_changes_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY rootset_control.email_outbox
    ADD CONSTRAINT email_outbox_dedupe_key_key UNIQUE (dedupe_key);

ALTER TABLE ONLY rootset_control.email_outbox
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.fields
    ADD CONSTRAINT fields_pkey PRIMARY KEY (id);





ALTER TABLE ONLY rootset_control.history_metrics
    ADD CONSTRAINT history_metrics_pkey PRIMARY KEY (org_id, table_id);



ALTER TABLE ONLY rootset_control.identity_rate_limits
    ADD CONSTRAINT identity_rate_limits_pkey PRIMARY KEY (bucket_hash);

ALTER TABLE ONLY rootset_control.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (job_id, start_record);

ALTER TABLE ONLY rootset_control.import_rejections
    ADD CONSTRAINT import_rejections_pkey PRIMARY KEY (job_id, record_number);


ALTER TABLE ONLY rootset_control.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.jobs
    ADD CONSTRAINT jobs_org_id_requester_id_operation_id_idempotency_key_key UNIQUE (org_id, requester_id, operation_id, idempotency_key);

ALTER TABLE ONLY rootset_control.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.key_requests
    ADD CONSTRAINT key_requests_pkey PRIMARY KEY (actor_id, org_id, operation, key);

ALTER TABLE ONLY rootset_control.memberships
    ADD CONSTRAINT memberships_org_id_user_id_key UNIQUE (org_id, user_id);

ALTER TABLE ONLY rootset_control.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.memberships
    ADD CONSTRAINT memberships_user_unique UNIQUE (user_id);

ALTER TABLE ONLY rootset_control.mutations
    ADD CONSTRAINT mutations_org_id_table_id_idempotency_key_key UNIQUE (org_id, table_id, idempotency_key);

ALTER TABLE ONLY rootset_control.mutations
    ADD CONSTRAINT mutations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id);

ALTER TABLE ONLY rootset_control.oauth_codes
    ADD CONSTRAINT oauth_codes_pkey PRIMARY KEY (digest);

ALTER TABLE ONLY rootset_control.oauth_families
    ADD CONSTRAINT oauth_families_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.oauth_grants
    ADD CONSTRAINT oauth_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.oauth_requests
    ADD CONSTRAINT oauth_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.oauth_tokens
    ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (digest);

ALTER TABLE ONLY rootset_control.operation_outcomes
    ADD CONSTRAINT operation_outcomes_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY rootset_control.organisations
    ADD CONSTRAINT organisations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.organisations
    ADD CONSTRAINT organisations_singleton_key UNIQUE (singleton);

ALTER TABLE ONLY rootset_control.query_sessions
    ADD CONSTRAINT query_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.resource_history
    ADD CONSTRAINT resource_history_pkey PRIMARY KEY (id);


ALTER TABLE ONLY rootset_control.schema_operations
    ADD CONSTRAINT schema_operations_org_id_idempotency_key_key UNIQUE (org_id, idempotency_key);

ALTER TABLE ONLY rootset_control.schema_operations
    ADD CONSTRAINT schema_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.sessions
    ADD CONSTRAINT sessions_token_key UNIQUE (token);

ALTER TABLE ONLY rootset_control.tables
    ADD CONSTRAINT tables_database_id_physical_name_key UNIQUE (database_id, physical_name);

ALTER TABLE ONLY rootset_control.tables
    ADD CONSTRAINT tables_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.unique_buckets
    ADD CONSTRAINT unique_buckets_pkey PRIMARY KEY (rule_id, digest);

ALTER TABLE ONLY rootset_control.unique_entries
    ADD CONSTRAINT unique_entries_pkey PRIMARY KEY (rule_id, row_id);

ALTER TABLE ONLY rootset_control.unique_rules
    ADD CONSTRAINT unique_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY rootset_control.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY rootset_control.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rootset_control.view_preferences
    ADD CONSTRAINT view_preferences_pkey PRIMARY KEY (user_id, table_id);

ALTER TABLE ONLY rootset_control.worker_heartbeats
    ADD CONSTRAINT worker_heartbeats_pkey PRIMARY KEY (id);

CREATE INDEX api_admissions_principal ON rootset_control.api_admissions USING btree (principal, read_only, expires_at);

CREATE INDEX artifacts_expiry ON rootset_control.artifacts USING btree (expires_at) WHERE (state = ANY (ARRAY['upload_pending'::text, 'ready'::text]));

CREATE INDEX auth_verifications_identifier_idx ON rootset_control.auth_verifications USING btree (identifier);

CREATE INDEX cell_changes_browse ON ONLY rootset_control.cell_changes USING btree (org_id, table_id, changed_at, id);


CREATE INDEX cell_changes_default_org_id_database_id_id_idx ON rootset_control.cell_changes_default USING btree (org_id, database_id, id);

CREATE INDEX cell_changes_mutation ON ONLY rootset_control.cell_changes USING btree (org_id, mutation_id);

CREATE INDEX cell_changes_default_org_id_mutation_id_idx ON rootset_control.cell_changes_default USING btree (org_id, mutation_id);

CREATE INDEX cell_changes_default_org_id_table_id_changed_at_id_idx ON rootset_control.cell_changes_default USING btree (org_id, table_id, changed_at, id);

CREATE INDEX cell_changes_public_lookup ON ONLY rootset_control.cell_changes USING btree (org_id, table_id, public_id);

CREATE INDEX cell_changes_default_org_id_table_id_public_id_idx ON rootset_control.cell_changes_default USING btree (org_id, table_id, public_id);

CREATE INDEX cell_changes_lookup ON ONLY rootset_control.cell_changes USING btree (org_id, table_id, row_id, field_id, changed_at, id);

CREATE INDEX cell_changes_default_org_id_table_id_row_id_field_id_change_idx ON rootset_control.cell_changes_default USING btree (org_id, table_id, row_id, field_id, changed_at, id);

CREATE UNIQUE INDEX cell_changes_public_id ON ONLY rootset_control.cell_changes USING btree (public_id, changed_at);

CREATE UNIQUE INDEX cell_changes_default_public_id_changed_at_idx ON rootset_control.cell_changes_default USING btree (public_id, changed_at);

CREATE INDEX control_mutation_replays_expiry ON rootset_control.control_mutation_replays USING btree (expires_at);

CREATE INDEX email_outbox_next_attempt_at_idx ON rootset_control.email_outbox USING btree (next_attempt_at) WHERE (state = ANY (ARRAY['pending'::text, 'sending'::text]));

CREATE INDEX email_outbox_verification_recipient ON rootset_control.email_outbox USING btree (to_address, created_at DESC) WHERE (template = 'account-verification'::text);

CREATE UNIQUE INDEX fields_active_name ON rootset_control.fields USING btree (table_id, lower((name)::text)) WHERE (state = 'active'::text);





CREATE INDEX jobs_org_target ON rootset_control.jobs USING btree (org_id, target_id, created_at DESC);

CREATE INDEX jobs_poll ON rootset_control.jobs USING btree (next_attempt_at, created_at) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text]));


CREATE INDEX oauth_grants_user ON rootset_control.oauth_grants USING btree (user_id, org_id);

CREATE INDEX oauth_tokens_family ON rootset_control.oauth_tokens USING btree (family_id);

CREATE INDEX resource_history_lookup ON rootset_control.resource_history USING btree (org_id, table_id, changed_at, id);






CREATE INDEX sessions_user_id_idx ON rootset_control.sessions USING btree (user_id);

CREATE INDEX tables_database ON rootset_control.tables USING btree (org_id, database_id);

CREATE INDEX unique_entries_bucket ON rootset_control.unique_entries USING btree (rule_id, digest);




ALTER INDEX rootset_control.cell_changes_mutation ATTACH PARTITION rootset_control.cell_changes_default_org_id_mutation_id_idx;

ALTER INDEX rootset_control.cell_changes_browse ATTACH PARTITION rootset_control.cell_changes_default_org_id_table_id_changed_at_id_idx;

ALTER INDEX rootset_control.cell_changes_public_lookup ATTACH PARTITION rootset_control.cell_changes_default_org_id_table_id_public_id_idx;

ALTER INDEX rootset_control.cell_changes_lookup ATTACH PARTITION rootset_control.cell_changes_default_org_id_table_id_row_id_field_id_change_idx;

ALTER INDEX rootset_control.cell_changes_public_id ATTACH PARTITION rootset_control.cell_changes_default_public_id_changed_at_idx;

CREATE TRIGGER history_usage AFTER INSERT OR DELETE ON rootset_control.cell_changes FOR EACH ROW EXECUTE FUNCTION rootset_control.track_history_metrics();

ALTER TABLE ONLY rootset_control.account_actions
    ADD CONSTRAINT account_actions_org_id_fkey FOREIGN KEY (org_id) REFERENCES rootset_control.organisations(id);

ALTER TABLE ONLY rootset_control.account_actions
    ADD CONSTRAINT account_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id);

ALTER TABLE ONLY rootset_control.api_keys
    ADD CONSTRAINT api_keys_creator_user_id_fkey FOREIGN KEY (creator_user_id) REFERENCES rootset_control.users(id);

ALTER TABLE ONLY rootset_control.api_keys
    ADD CONSTRAINT api_keys_org_id_fkey FOREIGN KEY (org_id) REFERENCES rootset_control.organisations(id);

ALTER TABLE ONLY rootset_control.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id);

ALTER TABLE ONLY rootset_control.artifacts
    ADD CONSTRAINT artifacts_job_id_fkey FOREIGN KEY (job_id) REFERENCES rootset_control.jobs(id);

ALTER TABLE ONLY rootset_control.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY rootset_control.auth_passkeys
    ADD CONSTRAINT auth_passkeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY rootset_control.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY rootset_control.databases
    ADD CONSTRAINT databases_org_id_fkey FOREIGN KEY (org_id) REFERENCES rootset_control.organisations(id);

ALTER TABLE ONLY rootset_control.email_changes
    ADD CONSTRAINT email_changes_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id);

ALTER TABLE ONLY rootset_control.fields
    ADD CONSTRAINT fields_table_id_fkey FOREIGN KEY (table_id) REFERENCES rootset_control.tables(id);







ALTER TABLE ONLY rootset_control.import_batches
    ADD CONSTRAINT import_batches_job_id_fkey FOREIGN KEY (job_id) REFERENCES rootset_control.jobs(id);

ALTER TABLE ONLY rootset_control.import_rejections
    ADD CONSTRAINT import_rejections_job_id_fkey FOREIGN KEY (job_id) REFERENCES rootset_control.jobs(id);


ALTER TABLE ONLY rootset_control.invitations
    ADD CONSTRAINT invitations_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES rootset_control.users(id);

ALTER TABLE ONLY rootset_control.invitations
    ADD CONSTRAINT invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES rootset_control.organisations(id);

ALTER TABLE ONLY rootset_control.memberships
    ADD CONSTRAINT memberships_org_id_fkey FOREIGN KEY (org_id) REFERENCES rootset_control.organisations(id);

ALTER TABLE ONLY rootset_control.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id);

ALTER TABLE ONLY rootset_control.oauth_codes
    ADD CONSTRAINT oauth_codes_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES rootset_control.oauth_grants(id);

ALTER TABLE ONLY rootset_control.oauth_codes
    ADD CONSTRAINT oauth_codes_request_id_fkey FOREIGN KEY (request_id) REFERENCES rootset_control.oauth_requests(id);

ALTER TABLE ONLY rootset_control.oauth_families
    ADD CONSTRAINT oauth_families_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES rootset_control.oauth_grants(id);

ALTER TABLE ONLY rootset_control.oauth_tokens
    ADD CONSTRAINT oauth_tokens_family_id_fkey FOREIGN KEY (family_id) REFERENCES rootset_control.oauth_families(id);

ALTER TABLE ONLY rootset_control.operation_outcomes
    ADD CONSTRAINT operation_outcomes_job_id_fkey FOREIGN KEY (job_id) REFERENCES rootset_control.jobs(id);

ALTER TABLE ONLY rootset_control.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY rootset_control.tables
    ADD CONSTRAINT tables_database_id_fkey FOREIGN KEY (database_id) REFERENCES rootset_control.databases(id);

ALTER TABLE ONLY rootset_control.tables
    ADD CONSTRAINT tables_org_id_fkey FOREIGN KEY (org_id) REFERENCES rootset_control.organisations(id);

ALTER TABLE ONLY rootset_control.unique_buckets
    ADD CONSTRAINT unique_buckets_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES rootset_control.unique_rules(id);

ALTER TABLE ONLY rootset_control.unique_entries
    ADD CONSTRAINT unique_entries_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES rootset_control.unique_rules(id);

ALTER TABLE ONLY rootset_control.unique_rules
    ADD CONSTRAINT unique_rules_table_id_fkey FOREIGN KEY (table_id) REFERENCES rootset_control.tables(id);

ALTER TABLE ONLY rootset_control.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY rootset_control.view_preferences
    ADD CONSTRAINT view_preferences_org_id_fkey FOREIGN KEY (org_id) REFERENCES rootset_control.organisations(id);

ALTER TABLE ONLY rootset_control.view_preferences
    ADD CONSTRAINT view_preferences_table_id_fkey FOREIGN KEY (table_id) REFERENCES rootset_control.tables(id);

ALTER TABLE ONLY rootset_control.view_preferences
    ADD CONSTRAINT view_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES rootset_control.users(id);

ALTER TABLE rootset_control.account_actions ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.api_keys ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.cell_changes ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.cell_changes_default ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.control_mutation_replays ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.databases ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.fields ENABLE ROW LEVEL SECURITY;



ALTER TABLE rootset_control.history_metrics ENABLE ROW LEVEL SECURITY;


CREATE POLICY identity_org_isolation ON rootset_control.account_actions USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY identity_org_isolation ON rootset_control.api_keys USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY identity_org_isolation ON rootset_control.invitations USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY identity_org_isolation ON rootset_control.key_requests USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY identity_org_isolation ON rootset_control.memberships USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));


ALTER TABLE rootset_control.import_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.import_rejections ENABLE ROW LEVEL SECURITY;


ALTER TABLE rootset_control.invitations ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.key_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.mutations ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.operation_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON rootset_control.artifacts USING ((org_id = ((SELECT rootset_control.current_org_id()))::character(26))) WITH CHECK ((org_id = ((SELECT rootset_control.current_org_id()))::character(26)));

CREATE POLICY org_isolation ON rootset_control.cell_changes USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY org_isolation ON rootset_control.databases USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY org_isolation ON rootset_control.fields USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));


CREATE POLICY org_isolation ON rootset_control.import_batches USING ((org_id = ((SELECT rootset_control.current_org_id()))::character(26))) WITH CHECK ((org_id = ((SELECT rootset_control.current_org_id()))::character(26)));

CREATE POLICY org_isolation ON rootset_control.import_rejections USING ((org_id = ((SELECT rootset_control.current_org_id()))::character(26))) WITH CHECK ((org_id = ((SELECT rootset_control.current_org_id()))::character(26)));


CREATE POLICY org_isolation ON rootset_control.jobs USING ((org_id = ((SELECT rootset_control.current_org_id()))::character(26))) WITH CHECK ((org_id = ((SELECT rootset_control.current_org_id()))::character(26)));

CREATE POLICY org_isolation ON rootset_control.mutations USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY org_isolation ON rootset_control.query_sessions USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY org_isolation ON rootset_control.resource_history USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));


CREATE POLICY org_isolation ON rootset_control.schema_operations USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY org_isolation ON rootset_control.tables USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY org_isolation ON rootset_control.unique_rules USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

CREATE POLICY organisation_boundary ON rootset_control.control_mutation_replays USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));


CREATE POLICY organisation_boundary ON rootset_control.history_metrics USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));


CREATE POLICY organisation_boundary ON rootset_control.operation_outcomes USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));



CREATE POLICY partition_organisation_boundary ON rootset_control.cell_changes_default USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));

ALTER TABLE rootset_control.query_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.resource_history ENABLE ROW LEVEL SECURITY;


CREATE POLICY rule_organisation_boundary ON rootset_control.unique_buckets USING ((EXISTS ( SELECT 1
   FROM rootset_control.unique_rules r
  WHERE (((r.id)::text = (unique_buckets.rule_id)::text) AND ((r.org_id)::text = (SELECT rootset_control.current_org_id())))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM rootset_control.unique_rules r
  WHERE (((r.id)::text = (unique_buckets.rule_id)::text) AND ((r.org_id)::text = (SELECT rootset_control.current_org_id()))))));

CREATE POLICY rule_organisation_boundary ON rootset_control.unique_entries USING ((EXISTS ( SELECT 1
   FROM rootset_control.unique_rules r
  WHERE (((r.id)::text = (unique_entries.rule_id)::text) AND ((r.org_id)::text = (SELECT rootset_control.current_org_id())))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM rootset_control.unique_rules r
  WHERE (((r.id)::text = (unique_entries.rule_id)::text) AND ((r.org_id)::text = (SELECT rootset_control.current_org_id()))))));

ALTER TABLE rootset_control.schema_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.tables ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.unique_buckets ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.unique_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.unique_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE rootset_control.view_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY view_preferences_org_isolation ON rootset_control.view_preferences USING (((org_id)::text = (SELECT rootset_control.current_org_id()))) WITH CHECK (((org_id)::text = (SELECT rootset_control.current_org_id())));








































































































































INSERT INTO rootset_control.bootstrap(singleton) VALUES(true);


CREATE FUNCTION rootset_control.retain_cell_history() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'rootset_control'
    AS $$
BEGIN
 DELETE FROM rootset_control.cell_changes
 WHERE org_id=NEW.org_id AND table_id=NEW.table_id AND row_id=NEW.row_id AND field_id=NEW.field_id
   AND id IN (
     SELECT id FROM rootset_control.cell_changes
     WHERE org_id=NEW.org_id AND table_id=NEW.table_id AND row_id=NEW.row_id AND field_id=NEW.field_id
     ORDER BY changed_at DESC,id DESC OFFSET 200
   );
 RETURN NEW;
END $$;

CREATE TRIGGER retain_cell_history AFTER INSERT ON rootset_control.cell_changes
 FOR EACH ROW EXECUTE FUNCTION rootset_control.retain_cell_history();
