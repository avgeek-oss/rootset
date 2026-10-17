CREATE TABLE rootset_control.saved_views (
  id varchar(26) PRIMARY KEY,
  org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
  table_id varchar(26) NOT NULL REFERENCES rootset_control.tables(id),
  owner_user_id varchar(26) REFERENCES rootset_control.users(id) ON DELETE SET NULL,
  owner_name_snapshot text NOT NULL,
  name varchar(120) NOT NULL CHECK (length(btrim(name))>0),
  visibility text NOT NULL CHECK (visibility IN ('personal','shared')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  schema_version integer NOT NULL CHECK (schema_version>0),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX saved_views_personal_name ON rootset_control.saved_views(org_id,table_id,owner_user_id,lower(name)) WHERE visibility='personal' AND deleted_at IS NULL;
CREATE UNIQUE INDEX saved_views_shared_name ON rootset_control.saved_views(org_id,table_id,lower(name)) WHERE visibility='shared' AND deleted_at IS NULL;
CREATE INDEX saved_views_collection ON rootset_control.saved_views(org_id,table_id,visibility,owner_user_id) WHERE deleted_at IS NULL;
ALTER TABLE rootset_control.saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.saved_views FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_boundary ON rootset_control.saved_views
  USING (org_id=(SELECT rootset_control.current_org_id()))
  WITH CHECK (org_id=(SELECT rootset_control.current_org_id()));
