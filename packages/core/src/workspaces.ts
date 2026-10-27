import {
  RootsetError,
  newId,
  type Actor,
  type Workspace,
} from "@rootset/contracts";
import { withOrg, type Pool, type PoolClient } from "@rootset/database";

const missing = () =>
  new RootsetError("RESOURCE_NOT_FOUND", "Workspace was not found", 404);
const publicWorkspace = (row: Record<string, unknown>): Workspace => ({
  id: String(row.id),
  orgId: String(row.org_id),
  name: String(row.name),
  description: String(row.description),
  isDefault: Boolean(row.is_default),
  memberCount: Number(row.member_count),
  createdAt: new Date(row.created_at as string).toISOString(),
  updatedAt: new Date(row.updated_at as string).toISOString(),
});
export class Workspaces {
  constructor(private readonly pool: Pool) {}
  async assertAccess(
    actor: Actor,
    workspaceId: string,
    client?: PoolClient,
  ): Promise<void> {
    const check = async (c: PoolClient) => {
      const result = await c.query(
        `SELECT w.id FROM rootset_control.workspaces w WHERE w.org_id=$1 AND w.id=$2 AND w.deleted_at IS NULL AND (w.is_default OR (w.id=$4 AND $4 IS NOT NULL) OR EXISTS(SELECT 1 FROM rootset_control.workspace_members m WHERE m.org_id=w.org_id AND m.workspace_id=w.id AND m.user_id=$3))`,
        [
          actor.orgId,
          workspaceId,
          actor.userId ?? null,
          actor.kind === "workspace_key" ? actor.workspaceId : null,
        ],
      );
      if (!result.rowCount) throw missing();
    };
    if (client) await check(client);
    else await withOrg(this.pool, actor.orgId, check);
  }
  async execute(
    id: string,
    actor: Actor,
    input: Record<string, unknown>,
    transaction?: PoolClient,
  ): Promise<unknown> {
    const run = async (c: PoolClient) => {
      if (
        [
          "createWorkspace",
          "updateWorkspace",
          "deleteWorkspace",
          "addWorkspaceMember",
          "removeWorkspaceMember",
        ].includes(id)
      ) {
        const authority = await c.query(
          "SELECT user_id FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2 AND role='admin' FOR SHARE",
          [actor.orgId, actor.userId],
        );
        if (!authority.rowCount)
          throw new RootsetError(
            "FORBIDDEN",
            "Admin authority is required",
            403,
          );
      }
      const workspaceId = String(input.workspaceId ?? "");
      if (
        ![
          "listWorkspaces",
          "listTeamWorkspaces",
          "createWorkspace",
          "listWorkspaceMembers",
        ].includes(id)
      )
        await this.assertAccess(actor, workspaceId, c);
      if (id === "createWorkspace") {
        const created = newId();
        await c.query(
          "INSERT INTO rootset_control.workspaces(id,org_id,name,description) VALUES($1,$2,$3,$4)",
          [created, actor.orgId, input.name, input.description],
        );
        await c.query(
          "INSERT INTO rootset_control.workspace_members(org_id,workspace_id,user_id) VALUES($1,$2,$3)",
          [actor.orgId, created, actor.userId],
        );
        return this.get(c, actor, created);
      }
      if (id === "listWorkspaces" || id === "listTeamWorkspaces") {
        const result = await c.query(
          `SELECT w.*,CASE WHEN w.is_default THEN (SELECT count(*) FROM rootset_control.memberships m WHERE m.org_id=w.org_id) ELSE (SELECT count(*) FROM rootset_control.workspace_members m WHERE m.workspace_id=w.id) END member_count FROM rootset_control.workspaces w WHERE w.org_id=$1 AND w.deleted_at IS NULL AND ($4::varchar IS NULL OR w.id=$4) AND ($3::boolean OR w.id=$4 OR w.is_default OR EXISTS(SELECT 1 FROM rootset_control.workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2)) ORDER BY w.is_default DESC,lower(w.name),w.id`,
          [
            actor.orgId,
            actor.userId ?? null,
            id === "listTeamWorkspaces",
            actor.kind === "workspace_key" ? actor.workspaceId : null,
          ],
        );
        return { data: result.rows.map(publicWorkspace) };
      }
      if (id === "deleteWorkspace") {
        const workspace = await this.get(c, actor, workspaceId, true);
        await this.assertAccess(actor, workspaceId, c);
        if (workspace.isDefault)
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Default cannot be deleted",
          );
        const databases = await c.query(
          "SELECT 1 FROM rootset_control.databases WHERE workspace_id=$1 AND state<>'deleted' LIMIT 1",
          [workspaceId],
        );
        if (databases.rowCount)
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Delete the databases in this workspace before deleting it",
          );
        await c.query(
          "UPDATE rootset_control.workspaces SET deleted_at=now() WHERE id=$1",
          [workspaceId],
        );
        await c.query(
          "UPDATE rootset_control.api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=$1",
          [workspaceId],
        );
        return { deleted: true };
      }
      if (id === "getWorkspace") return this.get(c, actor, workspaceId);
      if (id === "updateWorkspace") {
        const workspace = await this.get(c, actor, workspaceId, true);
        await this.assertAccess(actor, workspaceId, c);
        if (
          workspace.isDefault &&
          input.name !== undefined &&
          input.name !== "Default"
        )
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Default cannot be renamed",
          );
        await c.query(
          "UPDATE rootset_control.workspaces SET name=$3,description=$4,updated_at=now() WHERE org_id=$1 AND id=$2",
          [
            actor.orgId,
            workspaceId,
            input.name ?? workspace.name,
            input.description ?? workspace.description,
          ],
        );
        return this.get(c, actor, workspaceId);
      }
      const workspace = await this.get(
        c,
        actor,
        workspaceId,
        id !== "listWorkspaceMembers",
      );
      if (id === "listWorkspaceMembers") {
        const result = await c.query(
          `SELECT m.user_id AS "userId",u.name,u.email,m.role FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.org_id=$1 AND ($3::boolean OR EXISTS(SELECT 1 FROM rootset_control.workspace_members wm WHERE wm.workspace_id=$2 AND wm.user_id=m.user_id)) ORDER BY lower(u.name),u.id`,
          [actor.orgId, workspaceId, workspace.isDefault],
        );
        return { data: result.rows };
      }
      if (workspace.isDefault)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Default is shared by all team members",
        );
      // Serialise membership changes with the workspace row and recheck the managing admin.
      await this.assertAccess(actor, workspaceId, c);
      if (id === "removeWorkspaceMember") {
        await c.query(
          "DELETE FROM rootset_control.workspace_members WHERE org_id=$1 AND workspace_id=$2 AND user_id=$3",
          [actor.orgId, workspaceId, input.userId],
        );
        return { deleted: true };
      }
      if (id === "addWorkspaceMember") {
        const result = await c.query(
          `SELECT m.user_id AS "userId",u.name,u.email,m.role FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 FOR KEY SHARE OF m`,
          [actor.orgId, input.userId],
        );
        if (!result.rowCount)
          throw new RootsetError(
            "RESOURCE_NOT_FOUND",
            "Team member was not found",
            404,
          );
        await c.query(
          "INSERT INTO rootset_control.workspace_members(org_id,workspace_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [actor.orgId, workspaceId, input.userId],
        );
        return result.rows[0];
      }
      throw new Error(`Unknown workspace operation ${id}`);
    };
    try {
      return transaction
        ? await run(transaction)
        : await withOrg(this.pool, actor.orgId, run);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      )
        throw new RootsetError(
          "VALIDATION_FAILED",
          "A workspace with this name already exists",
        );
      throw error;
    }
  }
  private async get(
    c: PoolClient,
    actor: Actor,
    id: string,
    lock = false,
  ): Promise<Workspace> {
    const result = await c.query(
      `SELECT w.*,(CASE WHEN w.is_default THEN (SELECT count(*) FROM rootset_control.memberships m WHERE m.org_id=w.org_id) ELSE (SELECT count(*) FROM rootset_control.workspace_members m WHERE m.workspace_id=w.id) END) member_count FROM rootset_control.workspaces w WHERE w.org_id=$1 AND w.id=$2 AND w.deleted_at IS NULL ${lock ? "FOR UPDATE OF w" : ""}`,
      [actor.orgId, id],
    );
    if (!result.rowCount) throw missing();
    return publicWorkspace(result.rows[0]!);
  }
}
