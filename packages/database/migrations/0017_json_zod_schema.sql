-- Rules are compiled from the restricted Zod grammar by the shared contract.
-- Field CHECK constraints embed the rule, so shadow-table conversions and
-- restores use the same enforcement as ordinary audited native writes.
CREATE FUNCTION rootset_control.json_matches_zod(value jsonb, rule jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'rootset_control'
    AS $$
DECLARE child record; item jsonb; size integer; numeric_value double precision;
BEGIN
 CASE rule->>'kind'
 WHEN 'optional' THEN
   RETURN value IS NULL OR rootset_control.json_matches_zod(value,rule->'inner');
 WHEN 'union' THEN
   FOR item IN SELECT jsonb_array_elements(rule->'options') LOOP
     IF rootset_control.json_matches_zod(value,item) THEN RETURN true; END IF;
   END LOOP;
   RETURN false;
 ELSE NULL;
 END CASE;
 IF value IS NULL THEN RETURN false; END IF;
 CASE rule->>'kind'
 WHEN 'null' THEN RETURN value='null'::jsonb;
 WHEN 'boolean' THEN RETURN jsonb_typeof(value)='boolean';
 WHEN 'literal' THEN RETURN value=rule->'value';
 WHEN 'string' THEN
   IF jsonb_typeof(value)<>'string' THEN RETURN false; END IF;
   -- Match the pinned Zod version's Unicode code-point length checks.
   size:=char_length(value#>>'{}');
 WHEN 'number' THEN
   IF jsonb_typeof(value)<>'number' THEN RETURN false; END IF;
   numeric_value:=(value#>>'{}')::double precision;
   IF coalesce((rule->>'integer')::boolean,false)
      AND (numeric_value<>trunc(numeric_value) OR abs(numeric_value)>9007199254740991) THEN RETURN false; END IF;
   RETURN (NOT (rule ? 'min') OR numeric_value>=(rule->>'min')::double precision)
      AND (NOT (rule ? 'max') OR numeric_value<=(rule->>'max')::double precision);
 WHEN 'array' THEN
   IF jsonb_typeof(value)<>'array' THEN RETURN false; END IF;
   size:=jsonb_array_length(value);
   IF (rule ? 'min' AND size<(rule->>'min')::bigint) OR (rule ? 'max' AND size>(rule->>'max')::bigint) THEN RETURN false; END IF;
   FOR item IN SELECT jsonb_array_elements(value) LOOP
     IF NOT rootset_control.json_matches_zod(item,rule->'item') THEN RETURN false; END IF;
   END LOOP;
   RETURN true;
 WHEN 'object' THEN
   IF jsonb_typeof(value)<>'object' THEN RETURN false; END IF;
   FOR child IN SELECT entry.key,entry.value FROM jsonb_each(rule->'properties') entry LOOP
     IF NOT rootset_control.json_matches_zod(value->child.key,child.value) THEN RETURN false; END IF;
   END LOOP;
   IF coalesce((rule->>'strict')::boolean,false) THEN
     FOR child IN SELECT entry.key FROM jsonb_each(value) entry LOOP
       IF NOT ((rule->'properties') ? child.key) THEN RETURN false; END IF;
     END LOOP;
   END IF;
   RETURN true;
 WHEN 'record' THEN
   IF jsonb_typeof(value)<>'object' THEN RETURN false; END IF;
   FOR item IN SELECT entry.value FROM jsonb_each(value) entry LOOP
     IF NOT rootset_control.json_matches_zod(item,rule->'value') THEN RETURN false; END IF;
   END LOOP;
   RETURN true;
 ELSE RETURN false;
 END CASE;
 RETURN (NOT (rule ? 'min') OR size>=(rule->>'min')::bigint)
    AND (NOT (rule ? 'max') OR size<=(rule->>'max')::bigint);
END $$;
