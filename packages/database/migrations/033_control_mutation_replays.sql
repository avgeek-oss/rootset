CREATE TABLE rootset_control.control_mutation_replays (
 org_id varchar(26) NOT NULL,
 principal_binding char(64) NOT NULL,
 operation_id text NOT NULL,
 key_digest char(64) NOT NULL,
 input_digest char(64) NOT NULL,
 outcome jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(org_id,principal_binding,operation_id,key_digest),
 CHECK(length(operation_id) BETWEEN 1 AND 120)
);
ALTER TABLE rootset_control.control_mutation_replays OWNER TO rootset_managed_owner;
ALTER TABLE rootset_control.control_mutation_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.control_mutation_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_boundary ON rootset_control.control_mutation_replays
 USING(org_id=current_setting('rootset.org_id',true))
 WITH CHECK(org_id=current_setting('rootset.org_id',true));
CREATE INDEX control_mutation_replays_expiry ON rootset_control.control_mutation_replays(expires_at);
REVOKE ALL ON rootset_control.control_mutation_replays FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.control_mutation_replays TO rootset_app,rootset_ddl,rootset_identity;
