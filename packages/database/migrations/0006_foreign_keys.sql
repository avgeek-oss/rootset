CREATE TABLE rootset_control.foreign_keys (
 id varchar(26) PRIMARY KEY,
 org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 table_id varchar(26) NOT NULL REFERENCES rootset_control.tables(id),
 field_ids varchar(26)[] NOT NULL CHECK (cardinality(field_ids) BETWEEN 1 AND 8),
 referenced_table_id varchar(26) NOT NULL REFERENCES rootset_control.tables(id),
 referenced_rule_id varchar(26) NOT NULL REFERENCES rootset_control.unique_rules(id),
 referenced_field_ids varchar(26)[] NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (cardinality(field_ids)=cardinality(referenced_field_ids))
);
CREATE INDEX foreign_keys_source ON rootset_control.foreign_keys(table_id) WHERE state='active';
CREATE INDEX foreign_keys_target ON rootset_control.foreign_keys(referenced_table_id) WHERE state='active';

-- A stable row identity lets PostgreSQL protect references even for keys too
-- wide for a native B-tree. Full tuples disambiguate digest collisions.
CREATE TABLE rootset_control.foreign_key_targets (
 unique_rule_id varchar(26) NOT NULL REFERENCES rootset_control.unique_rules(id),
 row_id varchar(26) NOT NULL,
 org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 digest text NOT NULL,
 tuple text COLLATE "C" NOT NULL,
 PRIMARY KEY(unique_rule_id,row_id)
);
CREATE INDEX foreign_key_target_lookup ON rootset_control.foreign_key_targets(unique_rule_id,digest);
CREATE TABLE rootset_control.foreign_key_entries (
 rule_id varchar(26) NOT NULL REFERENCES rootset_control.foreign_keys(id),
 row_id varchar(26) NOT NULL,
 org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 target_rule_id varchar(26) NOT NULL,
 target_row_id varchar(26) NOT NULL,
 PRIMARY KEY(rule_id,row_id),
 CONSTRAINT rootset_foreign_key_reference FOREIGN KEY(target_rule_id,target_row_id)
 REFERENCES rootset_control.foreign_key_targets(unique_rule_id,row_id) ON DELETE RESTRICT
);
CREATE INDEX foreign_key_entry_target ON rootset_control.foreign_key_entries(target_rule_id,target_row_id);

ALTER TABLE rootset_control.foreign_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.foreign_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_boundary ON rootset_control.foreign_keys
 USING (org_id=(SELECT rootset_control.current_org_id()))
 WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));
ALTER TABLE rootset_control.foreign_key_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.foreign_key_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_boundary ON rootset_control.foreign_key_targets
 USING (org_id=(SELECT rootset_control.current_org_id()))
 WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));
ALTER TABLE rootset_control.foreign_key_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.foreign_key_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_boundary ON rootset_control.foreign_key_entries
 USING (org_id=(SELECT rootset_control.current_org_id()))
 WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));

CREATE FUNCTION rootset_control.reference_tuple(cells jsonb, ids varchar[]) RETURNS text
 LANGUAGE plpgsql STABLE SET search_path TO 'pg_catalog','rootset_control' AS $$
DECLARE result jsonb := '[]'; fid varchar(26); definition jsonb; value jsonb;
BEGIN
 FOREACH fid IN ARRAY ids LOOP
   value := cells->fid;
   IF value IS NULL OR value='null'::jsonb THEN RETURN NULL; END IF;
   SELECT f.definition INTO STRICT definition FROM rootset_control.fields f WHERE f.id=fid AND f.state='active';
   result := result || jsonb_build_array(jsonb_build_array(definition->>'type',value));
 END LOOP;
 RETURN rootset_control.canonical_json(result);
END $$;

CREATE FUNCTION rootset_control.enforce_references() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO 'pg_catalog','rootset_control' AS $$
DECLARE tab rootset_control.tables%ROWTYPE; rid varchar(26); cells jsonb; rule record;
 tuple_arg text; previous_tuple text; target_id varchar(26);
BEGIN
 SELECT * INTO STRICT tab FROM rootset_control.tables WHERE id=TG_ARGV[0];
 IF tab.org_id IS DISTINCT FROM rootset_control.current_org_id() THEN
   RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN rid:=OLD.row_id; ELSE rid:=NEW.row_id; cells:=rootset_control.canonical_row(to_jsonb(NEW),tab.id); END IF;
 -- Remove outgoing edges first so deleting a self-referencing row is valid.
 DELETE FROM rootset_control.foreign_key_entries e USING rootset_control.foreign_keys k
 WHERE e.rule_id=k.id AND k.table_id=tab.id AND e.row_id=rid;
 FOR rule IN SELECT u.* FROM rootset_control.unique_rules u
 WHERE u.table_id=tab.id AND u.state='active' AND EXISTS (
   SELECT 1 FROM rootset_control.foreign_keys k WHERE k.referenced_rule_id=u.id AND k.state='active'
 ) ORDER BY u.id LOOP
   tuple_arg:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE rootset_control.reference_tuple(cells,rule.field_ids) END;
   previous_tuple:=NULL;
   SELECT t.tuple INTO previous_tuple FROM rootset_control.foreign_key_targets t
   WHERE t.unique_rule_id=rule.id AND t.row_id=rid;
   IF previous_tuple IS DISTINCT FROM tuple_arg THEN
     DELETE FROM rootset_control.foreign_key_targets WHERE unique_rule_id=rule.id AND row_id=rid;
     IF tuple_arg IS NOT NULL THEN
       INSERT INTO rootset_control.foreign_key_targets(unique_rule_id,row_id,org_id,digest,tuple)
       VALUES(rule.id,rid,tab.org_id,rootset_control.unique_digest(tuple_arg),tuple_arg);
     END IF;
   END IF;
 END LOOP;
 IF TG_OP<>'DELETE' THEN
   FOR rule IN SELECT * FROM rootset_control.foreign_keys WHERE table_id=tab.id AND state='active' ORDER BY id LOOP
     tuple_arg:=rootset_control.reference_tuple(cells,rule.field_ids);
     IF tuple_arg IS NULL THEN CONTINUE; END IF;
     target_id:=NULL;
     SELECT t.row_id INTO target_id FROM rootset_control.foreign_key_targets t
     WHERE t.unique_rule_id=rule.referenced_rule_id AND t.digest=rootset_control.unique_digest(tuple_arg)
       AND t.tuple=tuple_arg COLLATE "C" FOR KEY SHARE;
     IF target_id IS NULL THEN
       RAISE EXCEPTION 'foreign key target missing' USING ERRCODE='23503',DETAIL=rule.id;
     END IF;
     INSERT INTO rootset_control.foreign_key_entries(rule_id,row_id,org_id,target_rule_id,target_row_id)
     VALUES(rule.id,rid,tab.org_id,rule.referenced_rule_id,target_id);
   END LOOP;
 END IF;
 RETURN NULL;
END $$;
