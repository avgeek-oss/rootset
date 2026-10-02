CREATE TABLE rootset_control.installation_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision bigint NOT NULL DEFAULT 1,
  protected_configuration text NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}',
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.installation_audit (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  request_id text,
  revision bigint NOT NULL,
  changed_sections text[] NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON rootset_control.installation_settings,rootset_control.installation_audit FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON rootset_control.installation_settings TO rootset_identity;
GRANT SELECT,INSERT ON rootset_control.installation_audit TO rootset_identity;
