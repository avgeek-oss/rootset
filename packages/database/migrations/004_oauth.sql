CREATE TABLE IF NOT EXISTS rootset_control.oauth_clients (
  client_id text PRIMARY KEY,
  metadata jsonb NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('registered','metadata','dynamic')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rootset_control.oauth_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  targets jsonb NOT NULL,
  org_id text NOT NULL,
  user_id text,
  state text,
  challenge text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rootset_control.oauth_grants (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  user_id text NOT NULL,
  org_id text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  targets jsonb NOT NULL,
  actor jsonb NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_grants_user ON rootset_control.oauth_grants(user_id,org_id);
CREATE TABLE IF NOT EXISTS rootset_control.oauth_codes (
  digest text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES rootset_control.oauth_grants(id),
  request_id text NOT NULL REFERENCES rootset_control.oauth_requests(id),
  redirect_uri text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS rootset_control.oauth_families (
  id text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES rootset_control.oauth_grants(id),
  absolute_expires_at timestamptz NOT NULL,
  inactivity_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rootset_control.oauth_tokens (
  digest text PRIMARY KEY,
  family_id text NOT NULL REFERENCES rootset_control.oauth_families(id),
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON rootset_control.oauth_tokens(family_id);
CREATE TABLE IF NOT EXISTS rootset_control.api_rate_windows (
  principal text NOT NULL,
  window_start bigint NOT NULL,
  requests integer NOT NULL,
  PRIMARY KEY (principal,window_start)
);
CREATE TABLE IF NOT EXISTS rootset_control.api_admissions (
  id text PRIMARY KEY,
  principal text NOT NULL,
  read_only boolean NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS api_admissions_principal ON rootset_control.api_admissions(principal,read_only,expires_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.oauth_clients,rootset_control.oauth_requests,rootset_control.oauth_grants,rootset_control.oauth_codes,rootset_control.oauth_families,rootset_control.oauth_tokens TO rootset_identity;
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.api_rate_windows,rootset_control.api_admissions TO rootset_app,rootset_identity;
CREATE FUNCTION rootset_control.oauth_grant_active(grant_id text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,rootset_control AS $$
 SELECT EXISTS(SELECT 1 FROM rootset_control.oauth_grants g
 JOIN rootset_control.users u ON u.id=g.user_id
 JOIN rootset_control.memberships m ON m.user_id=u.id AND m.org_id=g.org_id
 JOIN rootset_control.organisations o ON o.id=m.org_id
 WHERE g.id=grant_id AND g.revoked_at IS NULL AND NOT u.disabled AND m.state='active' AND o.state='active')
$$;
REVOKE ALL ON FUNCTION rootset_control.oauth_grant_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.oauth_grant_active(text) TO rootset_identity;
CREATE FUNCTION rootset_control.oauth_table_database(table_id text, organisation_id text) RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,rootset_control AS $$
 SELECT database_id::text FROM rootset_control.tables WHERE id=table_id AND org_id=organisation_id AND state='active'
$$;
CREATE FUNCTION rootset_control.oauth_database_exists(database_id text, organisation_id text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,rootset_control AS $$
 SELECT EXISTS(SELECT 1 FROM rootset_control.databases WHERE id=database_id AND org_id=organisation_id AND state='active')
$$;
REVOKE ALL ON FUNCTION rootset_control.oauth_table_database(text,text),rootset_control.oauth_database_exists(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.oauth_table_database(text,text),rootset_control.oauth_database_exists(text,text) TO rootset_identity;
