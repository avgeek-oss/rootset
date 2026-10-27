CREATE TABLE rootset_control.workspaces (
  id varchar(26) PRIMARY KEY,
  org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description)<=4096),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (org_id,id)
);
CREATE UNIQUE INDEX workspaces_name ON rootset_control.workspaces(org_id,lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX workspaces_default ON rootset_control.workspaces(org_id) WHERE is_default;
CREATE TABLE rootset_control.workspace_members (
  org_id varchar(26) NOT NULL,
  workspace_id varchar(26) NOT NULL,
  user_id varchar(26) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(org_id,workspace_id) REFERENCES rootset_control.workspaces(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,user_id) REFERENCES rootset_control.memberships(org_id,user_id) ON DELETE CASCADE
);
CREATE INDEX workspace_members_user ON rootset_control.workspace_members(org_id,user_id,workspace_id);
INSERT INTO rootset_control.workspaces(id,org_id,name,is_default)
SELECT id,id,'Default',true FROM rootset_control.organisations;
CREATE FUNCTION rootset_control.create_default_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rootset_control.workspaces(id,org_id,name,is_default) VALUES(NEW.id,NEW.id,'Default',true);
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_default_workspace AFTER INSERT ON rootset_control.organisations
FOR EACH ROW EXECUTE FUNCTION rootset_control.create_default_workspace();
CREATE FUNCTION rootset_control.protect_default_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_default AND (TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.name<>'Default' OR NOT NEW.is_default OR NEW.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Default workspace cannot be deleted or renamed';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_default_workspace BEFORE UPDATE OR DELETE ON rootset_control.workspaces
FOR EACH ROW EXECUTE FUNCTION rootset_control.protect_default_workspace();
ALTER TABLE rootset_control.databases ADD COLUMN workspace_id varchar(26);
UPDATE rootset_control.databases SET workspace_id=org_id;
ALTER TABLE rootset_control.databases ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE rootset_control.databases ADD CONSTRAINT databases_workspace FOREIGN KEY(org_id,workspace_id) REFERENCES rootset_control.workspaces(org_id,id);
CREATE INDEX databases_workspace ON rootset_control.databases(org_id,workspace_id,id);
ALTER TABLE rootset_control.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_org ON rootset_control.workspaces USING (org_id=rootset_control.current_org_id()) WITH CHECK (org_id=rootset_control.current_org_id());
ALTER TABLE rootset_control.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_org ON rootset_control.workspace_members USING (org_id=rootset_control.current_org_id()) WITH CHECK (org_id=rootset_control.current_org_id());
ALTER TABLE rootset_control.databases ALTER COLUMN workspace_id SET DEFAULT rootset_control.current_org_id();
UPDATE rootset_control.api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE scope='team';
ALTER TABLE rootset_control.api_keys ADD COLUMN workspace_id varchar(26);
ALTER TABLE rootset_control.api_keys ADD CONSTRAINT api_keys_workspace FOREIGN KEY(org_id,workspace_id) REFERENCES rootset_control.workspaces(org_id,id);
ALTER TABLE rootset_control.api_keys DROP CONSTRAINT api_keys_scope_check;
ALTER TABLE rootset_control.api_keys DROP CONSTRAINT api_keys_owner;
ALTER TABLE rootset_control.api_keys ADD CONSTRAINT api_keys_scope_check CHECK(scope IN ('personal','team','workspace'));
ALTER TABLE rootset_control.api_keys ADD CONSTRAINT api_keys_owner CHECK ((scope='personal' AND user_id IS NOT NULL AND workspace_id IS NULL) OR (scope='team' AND revoked_at IS NOT NULL) OR (scope='workspace' AND user_id IS NULL AND workspace_id IS NOT NULL));
CREATE INDEX api_keys_workspace ON rootset_control.api_keys(org_id,workspace_id) WHERE scope='workspace';
