LOCK TABLE rootset_control.unique_entries IN ACCESS EXCLUSIVE MODE;
UPDATE rootset_control.unique_entries
 SET tuple=rootset_control.canonical_json(tuple::jsonb),
     digest=rootset_control.unique_digest(rootset_control.canonical_json(tuple::jsonb));
INSERT INTO rootset_control.unique_buckets(rule_id,digest)
 SELECT DISTINCT rule_id,digest FROM rootset_control.unique_entries ON CONFLICT DO NOTHING;
