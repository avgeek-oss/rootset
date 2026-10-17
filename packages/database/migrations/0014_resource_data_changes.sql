ALTER TABLE rootset_control.tables ADD COLUMN last_data_change_at timestamptz;

WITH changes AS (
  SELECT org_id,table_id,max(changed_at) changed_at
  FROM rootset_control.cell_changes
  WHERE coalesce(context->>'source','')<>'schema' AND operation IN ('insert','update')
  GROUP BY org_id,table_id
  UNION ALL
  SELECT org_id,table_id,committed_at
  FROM rootset_control.mutations
  WHERE coalesce(context->>'source','')<>'schema'
    AND ((jsonb_typeof(outcome->'deletedIds')='array' AND outcome->'deletedIds'<>'[]'::jsonb)
      OR (jsonb_typeof(outcome->'createdIds')='array' AND outcome->'createdIds'<>'[]'::jsonb))
  UNION ALL
  SELECT m.org_id,m.table_id,max((r.value->>'createdAt')::timestamptz)
  FROM rootset_control.mutations m
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.outcome->'rows')='array' THEN m.outcome->'rows' ELSE '[]'::jsonb END) r(value)
  WHERE coalesce(m.context->>'source','')<>'schema' AND r.value->>'version'='1'
  GROUP BY m.org_id,m.table_id
), latest AS (
  SELECT org_id,table_id,max(changed_at) changed_at FROM changes GROUP BY org_id,table_id
)
UPDATE rootset_control.tables t SET last_data_change_at=latest.changed_at
FROM latest WHERE t.org_id=latest.org_id AND t.id=latest.table_id;

CREATE OR REPLACE FUNCTION rootset_control.enforce_row() RETURNS trigger
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
     IF f.definition->>'type'='text' AND jsonb_typeof(f.definition->'allowedValues')='array'
        AND NOT (f.definition->'allowedValues' @> jsonb_build_array(v)) THEN
       RAISE EXCEPTION 'allowed value constraint violated' USING ERRCODE='23514',DETAIL=f.definition->>'id';
     END IF;
     CASE f.definition->>'type'
     WHEN 'text' THEN IF char_length(v#>>'{}')>coalesce((f.definition->>'charLimit')::integer,4096) THEN RAISE EXCEPTION 'text character limit exceeded' USING ERRCODE='23514',DETAIL=f.definition->>'name'; END IF;
     WHEN 'integer' THEN IF abs((v#>>'{}')::numeric)>9007199254740991 THEN RAISE EXCEPTION 'integer outside safe transport range' USING ERRCODE='23514'; END IF;
       UPDATE rootset_control.integer_counters SET next_value=GREATEST(next_value,(v#>>'{}')::bigint+1) WHERE field_id=f.definition->>'id' AND table_id=tab.id AND org_id=tab.org_id;
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
 IF TG_OP IN ('INSERT','DELETE') OR coalesce(mutation.context->>'source','')<>'schema' THEN
   UPDATE rootset_control.tables
     SET row_count=row_count+CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END,
       last_data_change_at=CASE WHEN coalesce(mutation.context->>'source','')<>'schema' THEN clock_timestamp() ELSE last_data_change_at END
     WHERE id=tab.id;
 END IF;
 FOR bucket IN
   SELECT rule.id AS rule_id, dg.digest FROM rootset_control.unique_rules rule
   CROSS JOIN LATERAL (
     SELECT rootset_control.canonical_json(jsonb_agg(jsonb_build_array(field.definition->>'type',old_cells->field.id) ORDER BY ord)) AS tup
     FROM unnest(rule.field_ids) WITH ORDINALITY ids(id,ord) JOIN rootset_control.fields field ON field.id=ids.id
     HAVING rootset_control.unique_rule_matches(old_cells,rule.condition) AND bool_and(old_cells->field.id IS NOT NULL AND old_cells->field.id<>'null'::jsonb)
     UNION
     SELECT rootset_control.canonical_json(jsonb_agg(jsonb_build_array(field.definition->>'type',new_cells->field.id) ORDER BY ord))
     FROM unnest(rule.field_ids) WITH ORDINALITY ids(id,ord) JOIN rootset_control.fields field ON field.id=ids.id
     HAVING rootset_control.unique_rule_matches(new_cells,rule.condition) AND bool_and(new_cells->field.id IS NOT NULL AND new_cells->field.id<>'null'::jsonb)
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
   IF tuple_arg IS NOT NULL AND TG_OP<>'DELETE' AND rootset_control.unique_rule_matches(new_cells,r.condition) THEN
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
