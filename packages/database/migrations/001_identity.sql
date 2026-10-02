CREATE SCHEMA IF NOT EXISTS rootset_control;
CREATE TABLE rootset_control.users (
 id varchar(26) PRIMARY KEY, name varchar(120) NOT NULL, email varchar(320) NOT NULL UNIQUE CHECK(email=lower(trim(email))),
 email_verified boolean NOT NULL DEFAULT false, image text, disabled boolean NOT NULL DEFAULT false,
 authentication_version bigint NOT NULL DEFAULT 1, two_factor_enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.organisations (
 id varchar(26) PRIMARY KEY, name varchar(120) NOT NULL, description text NOT NULL DEFAULT '',
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','suspended','deleting','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.memberships (
 id varchar(26) PRIMARY KEY, org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id), role text NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','disabled')), version bigint NOT NULL DEFAULT 1,
 restricted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,user_id)
);
CREATE TABLE rootset_control.user_preferences (
 user_id varchar(26) PRIMARY KEY REFERENCES rootset_control.users(id) ON DELETE CASCADE,
 timezone text NOT NULL DEFAULT 'UTC',locale text NOT NULL DEFAULT 'en',date_format text NOT NULL DEFAULT 'YYYY-MM-DD',
 time_format text NOT NULL DEFAULT '24h' CHECK(time_format IN ('12h','24h')),theme text NOT NULL DEFAULT 'system' CHECK(theme IN ('system','light','dark')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.sessions (
 id varchar(26) PRIMARY KEY,user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id) ON DELETE CASCADE,
 token text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,ip_address text,user_agent text,active_organization_id varchar(26),
 authenticated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rootset_control.sessions(user_id);
CREATE TABLE rootset_control.auth_accounts (
 id varchar(26) PRIMARY KEY,user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id) ON DELETE CASCADE,
 account_id text NOT NULL,provider_id text NOT NULL,access_token text,refresh_token text,id_token text,
 access_token_expires_at timestamptz,refresh_token_expires_at timestamptz,scope text,password text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_id,account_id)
);
CREATE TABLE rootset_control.auth_verifications (
 id varchar(26) PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rootset_control.auth_verifications(identifier);
CREATE TABLE rootset_control.auth_passkeys (
 id varchar(26) PRIMARY KEY,user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id) ON DELETE CASCADE,name varchar(120),
 public_key text NOT NULL,credential_id text NOT NULL UNIQUE,counter integer NOT NULL,device_type text NOT NULL,backed_up boolean NOT NULL,
 transports text,aaguid text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.auth_two_factors (
 id varchar(26) PRIMARY KEY,user_id varchar(26) NOT NULL UNIQUE REFERENCES rootset_control.users(id) ON DELETE CASCADE,
 secret text NOT NULL,backup_codes text NOT NULL,verified boolean NOT NULL DEFAULT false,
 failed_verification_count integer NOT NULL DEFAULT 0,locked_until timestamptz
);
CREATE TABLE rootset_control.resource_grants (
 id varchar(26) PRIMARY KEY,org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id),database_id varchar(26),table_id varchar(26),
 level text NOT NULL CHECK(level IN ('read','edit','manage')),version bigint NOT NULL DEFAULT 1
);
CREATE INDEX ON rootset_control.resource_grants(org_id,user_id);
CREATE TABLE rootset_control.invitations (
 id varchar(26) PRIMARY KEY,org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),email varchar(320) NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','editor','viewer')),inviter_id varchar(26) NOT NULL REFERENCES rootset_control.users(id),
 token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','cancelled')),
 accepted_by varchar(26),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.api_keys (
 id varchar(26) PRIMARY KEY,org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),owner_kind text NOT NULL CHECK(owner_kind IN ('personal','team')),
 owner_user_id varchar(26) REFERENCES rootset_control.users(id),creator_user_id varchar(26) REFERENCES rootset_control.users(id),
 name varchar(120) NOT NULL,secret_hash text NOT NULL,prefix text NOT NULL,scopes jsonb NOT NULL,targets jsonb NOT NULL,unrestricted boolean NOT NULL DEFAULT false,
 expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz,rotated_from varchar(26),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((owner_kind='personal' AND owner_user_id IS NOT NULL) OR (owner_kind='team' AND owner_user_id IS NULL))
);
CREATE TABLE rootset_control.key_requests (
 actor_id text NOT NULL,org_id varchar(26) NOT NULL,operation text NOT NULL,key text NOT NULL,digest text NOT NULL,result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,org_id,operation,key)
);
CREATE TABLE rootset_control.account_actions (
 id varchar(26) PRIMARY KEY,user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id),org_id varchar(26) NOT NULL REFERENCES rootset_control.organisations(id),
 actor_id text NOT NULL,client_id text,operation text NOT NULL,payload_encrypted text NOT NULL,digest text NOT NULL,
 expires_at timestamptz NOT NULL,approved_at timestamptz,consumed_at timestamptz,result jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.account_audit (
 id varchar(26) PRIMARY KEY,org_id varchar(26),actor_kind text NOT NULL,actor_id text NOT NULL,user_id varchar(26),credential_id text,client_id text,
 operation text NOT NULL,target_id text,request_id text,outcome jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rootset_control.account_audit(org_id,created_at,id);
CREATE TABLE rootset_control.email_outbox (
 id varchar(26) PRIMARY KEY,to_address text NOT NULL,template text NOT NULL,payload_encrypted text NOT NULL,dedupe_key text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed')),attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,last_error text,provider_id text,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,expires_at timestamptz
);
CREATE INDEX ON rootset_control.email_outbox(next_attempt_at) WHERE state IN ('pending','sending');
CREATE TABLE rootset_control.bootstrap (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),org_id varchar(26),user_id varchar(26),claimed_at timestamptz,
 verified_at timestamptz,claim_digest text
);
INSERT INTO rootset_control.bootstrap(singleton) VALUES(true);
CREATE TABLE rootset_control.operator_bindings (
 user_id varchar(26) PRIMARY KEY REFERENCES rootset_control.users(id),bound_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL,revoked_at timestamptz
);
CREATE TABLE rootset_control.email_changes (
 id varchar(26) PRIMARY KEY,user_id varchar(26) NOT NULL UNIQUE REFERENCES rootset_control.users(id),previous_email varchar(320) NOT NULL,new_email varchar(320) NOT NULL,
 token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rootset_control.factor_proofs (
 user_id varchar(26) NOT NULL REFERENCES rootset_control.users(id),proof_hash text NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,proof_hash)
);
CREATE TABLE rootset_control.identity_rate_limits (
 bucket_hash text PRIMARY KEY,attempts integer NOT NULL,expires_at timestamptz NOT NULL
);
GRANT USAGE ON SCHEMA rootset_control TO rootset_identity;
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.users,rootset_control.sessions,rootset_control.auth_accounts,rootset_control.auth_verifications,rootset_control.auth_passkeys,rootset_control.auth_two_factors,rootset_control.user_preferences,rootset_control.factor_proofs,rootset_control.identity_rate_limits,rootset_control.email_outbox,rootset_control.email_changes,rootset_control.bootstrap,rootset_control.operator_bindings TO rootset_identity;
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.organisations,rootset_control.memberships,rootset_control.resource_grants,rootset_control.invitations,rootset_control.api_keys,rootset_control.key_requests,rootset_control.account_actions,rootset_control.account_audit TO rootset_identity;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['organisations','memberships','resource_grants','invitations','api_keys','key_requests','account_actions','account_audit'] LOOP
 EXECUTE format('ALTER TABLE rootset_control.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE rootset_control.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY identity_org_isolation ON rootset_control.%I TO rootset_identity USING (%I::text = current_setting(''rootset.org_id'',true)) WITH CHECK (%I::text = current_setting(''rootset.org_id'',true))',t,CASE WHEN t='organisations' THEN 'id' ELSE 'org_id' END,CASE WHEN t='organisations' THEN 'id' ELSE 'org_id' END);
 END LOOP;
END $$;
CREATE FUNCTION rootset_control.memberships_for_user(identity_user_id text)
RETURNS TABLE(id varchar(26),org_id varchar(26),user_id varchar(26),role text,state text,version bigint,restricted boolean,name varchar(120),organisation_state text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,rootset_control AS $$
 SELECT m.id,m.org_id,m.user_id,m.role,m.state,m.version,m.restricted,o.name,o.state FROM rootset_control.memberships m JOIN rootset_control.organisations o ON o.id=m.org_id WHERE m.user_id=identity_user_id;
$$;
REVOKE ALL ON FUNCTION rootset_control.memberships_for_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.memberships_for_user(text) TO rootset_identity;
CREATE FUNCTION rootset_control.key_locator(key_id text) RETURNS TABLE(org_id varchar(26)) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,rootset_control AS $$ SELECT org_id FROM rootset_control.api_keys WHERE id=key_id; $$;
REVOKE ALL ON FUNCTION rootset_control.key_locator(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.key_locator(text) TO rootset_identity;
CREATE FUNCTION rootset_control.invitation_locator(invitation_hash text) RETURNS TABLE(org_id varchar(26)) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,rootset_control AS $$ SELECT org_id FROM rootset_control.invitations WHERE token_hash=invitation_hash; $$;
REVOKE ALL ON FUNCTION rootset_control.invitation_locator(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.invitation_locator(text) TO rootset_identity;
