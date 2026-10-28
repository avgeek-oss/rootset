import {
  StorageConflictError,
  type AgentStorage,
  type ConversationRecord,
  type StoredMessage,
} from "@avgeek-oss/agent-core";
import { withOrg, type Pool } from "@rootset/database";

type ConversationRow = {
  id: string;
  owner_id: string;
  title: string;
  version: number;
  pending: ConversationRecord["pending"];
  created_at: Date;
  updated_at: Date;
};
const record = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  version: row.version,
  pending: row.pending,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Conversation storage uses the same transaction-local organisation context as
// other Rootset control data. Every query also checks the private human owner.
export function assistantStorage(
  pool: Pool,
  orgId: string,
  ownerId: string,
): AgentStorage {
  return {
    async createConversation(input) {
      if (input.ownerId !== ownerId)
        throw new Error("Conversation owner mismatch");
      return withOrg(pool, orgId, async (client) => {
        const result = await client.query<ConversationRow>(
          "INSERT INTO rootset_control.agent_conversations(id,owner_id,title) VALUES($1,$2,$3) RETURNING *",
          [input.id, ownerId, input.title],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Conversation insert returned no row");
        return record(row);
      });
    },
    async getConversation(id, owner) {
      if (owner !== ownerId) return null;
      return withOrg(pool, orgId, async (client) => {
        const result = await client.query<ConversationRow>(
          "SELECT * FROM rootset_control.agent_conversations WHERE id=$1 AND owner_id=$2",
          [id, ownerId],
        );
        return result.rows[0] ? record(result.rows[0]) : null;
      });
    },
    async listConversations(owner, options) {
      if (owner !== ownerId) return [];
      return withOrg(pool, orgId, async (client) =>
        (
          await client.query<ConversationRow>(
            "SELECT * FROM rootset_control.agent_conversations WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT $2",
            [ownerId, options.limit],
          )
        ).rows.map(record),
      );
    },
    async deleteConversation(id, owner) {
      if (owner !== ownerId) return false;
      return withOrg(
        pool,
        orgId,
        async (client) =>
          (
            await client.query(
              "DELETE FROM rootset_control.agent_conversations WHERE id=$1 AND owner_id=$2",
              [id, ownerId],
            )
          ).rowCount !== 0,
      );
    },
    async listMessages(id) {
      return withOrg(pool, orgId, async (client) => {
        const result = await client.query<{
          seq: number;
          role: StoredMessage["role"];
          content: StoredMessage["content"];
          model: string | null;
          meta: StoredMessage["meta"];
          created_at: Date;
        }>(
          "SELECT m.* FROM rootset_control.agent_messages m JOIN rootset_control.agent_conversations c ON c.id=m.conversation_id WHERE c.id=$1 AND c.owner_id=$2 ORDER BY m.seq",
          [id, ownerId],
        );
        return result.rows.map((row) => ({
          seq: row.seq,
          role: row.role,
          content: row.content,
          model: row.model,
          meta: row.meta,
          createdAt: row.created_at,
        }));
      });
    },
    async commit(id, change) {
      return withOrg(pool, orgId, async (client) => {
        const updated = await client.query<{ version: number }>(
          "UPDATE rootset_control.agent_conversations SET version=version+1,pending=$3,updated_at=now() WHERE id=$1 AND owner_id=$2 AND version=$4 RETURNING version",
          [id, ownerId, JSON.stringify(change.pending), change.expectedVersion],
        );
        const version = updated.rows[0]?.version;
        if (version === undefined) throw new StorageConflictError();
        const last = await client.query<{ seq: number }>(
          "SELECT coalesce(max(seq),0)::integer AS seq FROM rootset_control.agent_messages WHERE conversation_id=$1",
          [id],
        );
        let seq = last.rows[0]?.seq ?? 0;
        for (const message of change.append)
          await client.query(
            "INSERT INTO rootset_control.agent_messages(org_id,conversation_id,seq,role,content,model,usage,meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              orgId,
              id,
              ++seq,
              message.role,
              JSON.stringify(message.content),
              message.model ?? null,
              message.usage ? JSON.stringify(message.usage) : null,
              message.meta ? JSON.stringify(message.meta) : null,
            ],
          );
        return version;
      });
    },
  };
}
