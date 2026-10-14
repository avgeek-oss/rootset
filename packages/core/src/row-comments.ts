import { createHash } from "node:crypto";
import { assertAccess, roleAllows } from "@rootset/access";
import {
  ActorSchema,
  IdSchema,
  RootsetError,
  limits,
  newId,
  type Actor,
  type RowComment,
} from "@rootset/contracts";
import { runMutation } from "@rootset/idempotency";
import type { CoreOptions, OperationContext } from "./index.js";

interface StoredComment {
  id: string;
  row_id: string;
  author_user_id: string | null;
  author_name_snapshot: string;
  actor: Actor;
  body: string;
  created_at: Date;
  cursor_time: string;
}

function canDelete(
  actor: Actor,
  comment: Pick<StoredComment, "author_user_id" | "actor">,
): boolean {
  if (
    !roleAllows(actor.role, "rows:write") ||
    !actor.scopes.includes("rows:write")
  )
    return false;
  return (
    actor.role === "admin" ||
    (!!actor.userId && actor.userId === comment.author_user_id) ||
    (actor.kind === "team_key" &&
      comment.actor.kind === "team_key" &&
      actor.credentialId === comment.actor.credentialId)
  );
}

export async function rowComments(
  options: CoreOptions,
  operation: string,
  incoming: Actor,
  input: Record<string, unknown>,
  context: OperationContext,
): Promise<unknown> {
  const tableId = IdSchema.parse(input.tableId);
  const rowIds =
    operation === "countRowComments"
      ? (input.rowIds as string[])
      : [IdSchema.parse(input.rowId)];
  return options.storage.withCommentRows(
    incoming,
    tableId,
    rowIds,
    async (client, existing) => {
      const actor = await options.identity.refreshActor(incoming, client);
      const readOnly =
        operation === "listRowComments" || operation === "countRowComments";
      assertAccess(actor, {
        scope: readOnly ? "rows:read" : "rows:write",
        orgId: String(input.orgId),
      });
      if (operation === "countRowComments") {
        const counts = await client.query<{ row_id: string; count: string }>(
          "SELECT row_id,count(*)::text AS count FROM rootset_control.row_comments WHERE org_id=$1 AND table_id=$2 AND row_id=ANY($3::varchar[]) GROUP BY row_id",
          [actor.orgId, tableId, existing],
        );
        const byRow = new Map(
          counts.rows.map((row) => [row.row_id, Number(row.count)]),
        );
        return {
          data: existing.map((rowId) => ({
            rowId,
            count: byRow.get(rowId) ?? 0,
          })),
        };
      }
      const rowId = rowIds[0]!;
      if (!existing.includes(rowId))
        throw new RootsetError("RESOURCE_NOT_FOUND", "Row was not found", 404);
      if (operation === "listRowComments") {
        const limit = Number(input.limit ?? 50);
        const binding = {
          orgId: actor.orgId,
          tableId,
          schemaVersion: 1,
          membershipVersion: actor.membershipVersion ?? 0,
          actorId: actor.id,
          queryHash: createHash("sha256")
            .update(
              JSON.stringify({
                collection: "row-comments",
                rowId,
                limit,
                actor,
              }),
            )
            .digest("hex"),
        };
        const after = input.cursor
          ? options.storage.cursor.decode(String(input.cursor), binding)
          : null;
        if (
          after &&
          (after.length !== 2 ||
            typeof after[0] !== "string" ||
            !IdSchema.safeParse(after[1]).success)
        )
          throw new RootsetError(
            "CURSOR_INVALID",
            "Restart this discussion",
            400,
          );
        const result = await client.query<StoredComment>(
          `SELECT *,created_at::text AS cursor_time FROM rootset_control.row_comments WHERE org_id=$1 AND table_id=$2 AND row_id=$3 ${after ? "AND (created_at,id)>($4::timestamptz,$5::varchar)" : ""} ORDER BY created_at,id LIMIT $${after ? 6 : 4}`,
          [actor.orgId, tableId, rowId, ...(after ?? []), limit + 1],
        );
        const data: RowComment[] = [];
        const budget = Math.min(
          context.responseBudget ?? limits.restResultBytes,
          context.surface === "mcp"
            ? limits.mcpResultBytes
            : limits.restResultBytes,
        );
        let bytes = 4096; // Reserve the signed cursor, page envelope and transport wrapper.
        for (const comment of result.rows.slice(0, limit)) {
          const publicComment: RowComment = {
            id: comment.id,
            rowId: comment.row_id,
            authorUserId: comment.author_user_id,
            authorName: comment.author_name_snapshot,
            body: comment.body,
            createdAt: comment.created_at.toISOString(),
            canDelete: canDelete(actor, comment),
          };
          const size = Buffer.byteLength(JSON.stringify(publicComment)) + 1;
          if (bytes + size > budget) break;
          data.push(publicComment);
          bytes += size;
        }
        if (!data.length && result.rows.length)
          throw new RootsetError(
            "PAYLOAD_TOO_LARGE",
            "The comment exceeds the response byte budget",
            413,
          );
        const hasMore = result.rows.length > data.length;
        const last = result.rows[data.length - 1];
        return {
          data,
          hasMore,
          nextCursor:
            hasMore && last
              ? options.storage.cursor.encode(binding, [
                  last.cursor_time,
                  last.id,
                ])
              : null,
        };
      }
      // Receipts contain only IDs/status. Bodies live exclusively in row_comments.
      return runMutation(
        client,
        actor,
        operation,
        input,
        context.idempotencyKey!,
        options.config.keyHashSecret,
        async () => {
          if (operation === "createRowComment") {
            const identity = actor.userId
              ? await client.query<{ name: string }>(
                  "SELECT name FROM rootset_control.users WHERE id=$1",
                  [actor.userId],
                )
              : await client.query<{ name: string }>(
                  "SELECT name FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND scope='team'",
                  [actor.credentialId, actor.orgId],
                );
            if (!identity.rows[0])
              throw new RootsetError(
                "UNAUTHENTICATED",
                "Comment author is unavailable",
                401,
              );
            const id = newId();
            await client.query(
              "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_user_id,author_name_snapshot,actor,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
              [
                id,
                actor.orgId,
                tableId,
                rowId,
                actor.userId ?? null,
                identity.rows[0].name,
                JSON.stringify(ActorSchema.parse(actor)),
                input.body,
              ],
            );
            return { id };
          }
          const comment = (
            await client.query<StoredComment>(
              "SELECT * FROM rootset_control.row_comments WHERE org_id=$1 AND table_id=$2 AND row_id=$3 AND id=$4",
              [actor.orgId, tableId, rowId, input.commentId],
            )
          ).rows[0];
          if (!comment)
            throw new RootsetError(
              "RESOURCE_NOT_FOUND",
              "Comment was not found",
              404,
            );
          if (!canDelete(actor, comment))
            throw new RootsetError(
              "FORBIDDEN",
              "Only the author or an administrator can delete this comment",
              403,
            );
          await client.query(
            "DELETE FROM rootset_control.row_comments WHERE org_id=$1 AND id=$2",
            [actor.orgId, comment.id],
          );
          return { deleted: true };
        },
      );
    },
  );
}
