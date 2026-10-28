CREATE TABLE rootset_control.agent_conversations (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  user_id varchar(26) GENERATED ALWAYS AS (split_part(owner_id, ':', 1)) STORED REFERENCES rootset_control.users(id) ON DELETE CASCADE,
  workspace_id varchar(26) GENERATED ALWAYS AS (split_part(owner_id, ':', 2)) STORED,
  org_id varchar(26) GENERATED ALWAYS AS (split_part(owner_id, ':', 3)) STORED,
  title text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  pending jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,workspace_id) REFERENCES rootset_control.workspaces(org_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_conversations_owner_updated ON rootset_control.agent_conversations(owner_id,updated_at DESC);
ALTER TABLE rootset_control.agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.agent_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_conversations_org ON rootset_control.agent_conversations USING(org_id=rootset_control.current_org_id()) WITH CHECK(org_id=rootset_control.current_org_id());
CREATE TABLE rootset_control.agent_messages (
  org_id varchar(26) NOT NULL,
  conversation_id uuid NOT NULL,
  seq integer NOT NULL,
  role text NOT NULL CHECK(role IN ('user','assistant')),
  content jsonb NOT NULL,
  model text,
  usage jsonb,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,seq),
  FOREIGN KEY(org_id,conversation_id) REFERENCES rootset_control.agent_conversations(org_id,id) ON DELETE CASCADE
);
ALTER TABLE rootset_control.agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE rootset_control.agent_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_messages_org ON rootset_control.agent_messages USING(org_id=rootset_control.current_org_id()) WITH CHECK(org_id=rootset_control.current_org_id());
