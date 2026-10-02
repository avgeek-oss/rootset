CREATE TABLE rootset_control.view_preferences (
 user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id),org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 table_id varchar(26) NOT NULL REFERENCES rootset_control.tables(id),preferences jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,table_id)
);
ALTER TABLE rootset_control.view_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.view_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY view_preferences_org_isolation ON rootset_control.view_preferences TO rootset_identity USING(org_id=current_setting('rootset.org_id',true)) WITH CHECK(org_id=current_setting('rootset.org_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.view_preferences TO rootset_identity;
GRANT SELECT ON rootset_control.fields TO rootset_identity;
