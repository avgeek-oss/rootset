-- The app can append only a completion derived from its approved job and
-- native receipt. It receives no direct history INSERT/UPDATE/DELETE grant.
GRANT UPDATE(id) ON rootset_control.jobs TO rootset_managed_owner;

CREATE FUNCTION rootset_control.append_operator_repair_completion(
 organisation_arg varchar, job_arg varchar, lease_arg varchar, mutation_arg varchar
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET timezone='UTC' SET row_security=on AS $$
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
   OR m.actor->'operator' IS DISTINCT FROM 'true'::jsonb
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
END $$;
ALTER FUNCTION rootset_control.append_operator_repair_completion(varchar,varchar,varchar,varchar) OWNER TO rootset_managed_owner;
REVOKE ALL ON FUNCTION rootset_control.append_operator_repair_completion(varchar,varchar,varchar,varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.append_operator_repair_completion(varchar,varchar,varchar,varchar) TO rootset_app;
