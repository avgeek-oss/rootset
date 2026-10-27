import { assertAccess, roleAllows } from "@rootset/access";
import {
  IdSchema,
  RootsetError,
  SavedViewDefinitionSchema,
  SavedViewVisibilitySchema,
  AccountNameSchema,
  VersionSchema,
  newId,
  normalizeSavedViewDefinition,
  resolveSavedViewDefinition,
  savedViewLimits,
  type Actor,
  type FieldDefinition,
  type SavedView,
  type SavedViewDefinition,
  type SavedViewSummary,
} from "@rootset/contracts";
import type { PoolClient } from "@rootset/database";

interface StoredView {
  id: string;
  table_id: string;
  owner_user_id: string | null;
  owner_name_snapshot: string;
  name: string;
  visibility: "personal" | "shared";
  definition: SavedViewDefinition;
  schema_version: number;
  version: string;
  created_at: Date;
  updated_at: Date;
}
type StoredSummary = Omit<StoredView, "definition">;
function missing(): never {
  throw new RootsetError("RESOURCE_NOT_FOUND", "View was not found", 404);
}
function writable(actor: Actor): boolean {
  return (
    roleAllows(actor.role, "rows:write") &&
    (!["personal_key", "workspace_key", "oauth"].includes(actor.kind) ||
      actor.scopes.includes("rows:write"))
  );
}
function canEdit(actor: Actor, view: StoredSummary): boolean {
  return view.visibility === "personal"
    ? view.owner_user_id === actor.userId
    : writable(actor) &&
        (actor.role === "admin" || view.owner_user_id === actor.userId);
}
function summary(actor: Actor, view: StoredSummary): SavedViewSummary {
  return {
    id: view.id,
    tableId: view.table_id,
    ownerUserId: view.owner_user_id,
    ownerName: view.owner_name_snapshot,
    name: view.name,
    visibility: view.visibility,
    version: String(view.version),
    schemaVersion: view.schema_version,
    canEdit: canEdit(actor, view),
    canChangeVisibility: view.owner_user_id === actor.userId && writable(actor),
    createdAt: view.created_at.toISOString(),
    updatedAt: view.updated_at.toISOString(),
  };
}
function full(
  actor: Actor,
  view: StoredView,
  fields: readonly FieldDefinition[],
): SavedView {
  return {
    ...summary(actor, view),
    ...resolveSavedViewDefinition(
      SavedViewDefinitionSchema.parse(view.definition),
      fields,
    ),
  };
}
async function reserveScope(
  client: PoolClient,
  actor: Actor,
  tableId: string,
  visibility: string,
  ownerId: string,
  exceptId: string | null,
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `rootset:saved-views:${actor.orgId}:${tableId}:${visibility === "shared" ? "shared" : ownerId}`,
  ]);
  const count = (
    await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rootset_control.saved_views WHERE org_id=$1 AND table_id=$2 AND visibility=$3 AND ($3='shared' OR owner_user_id=$4) AND deleted_at IS NULL AND ($5::varchar IS NULL OR id<>$5)",
      [actor.orgId, tableId, visibility, ownerId, exceptId],
    )
  ).rows[0]!;
  if (Number(count.count) >= savedViewLimits.perScope)
    throw new RootsetError(
      "CAPACITY_LIMIT",
      "This table already has 100 views in this scope. Remove an unused view before adding another.",
      409,
    );
}

export async function executeSavedViews(
  client: PoolClient,
  operation: string,
  actor: Actor,
  input: Record<string, unknown>,
): Promise<unknown> {
  assertAccess(actor, {
    scope: "rows:read",
    orgId: String(input.orgId),
    personal: true,
  });
  const userId = IdSchema.parse(actor.userId),
    tableId = IdSchema.parse(input.tableId),
    databaseId = IdSchema.parse(input.databaseId);
  const database = (
    await client.query(
      "SELECT id FROM rootset_control.databases WHERE id=$1 AND org_id=$2 AND state='active' FOR SHARE",
      [databaseId, actor.orgId],
    )
  ).rows[0];
  if (!database) missing();
  const table = (
    await client.query<{ schema_version: number; state: string }>(
      "SELECT schema_version::integer AS schema_version,state FROM rootset_control.tables WHERE id=$1 AND database_id=$2 AND org_id=$3 AND state IN ('active','maintenance') FOR SHARE",
      [tableId, databaseId, actor.orgId],
    )
  ).rows[0];
  if (!table) missing();
  const modifying = [
    "createSavedView",
    "updateSavedView",
    "deleteSavedView",
  ].includes(operation);
  if (modifying && operation !== "deleteSavedView") {
    if (table.state !== "active")
      throw new RootsetError(
        "SCHEMA_MAINTENANCE",
        "Wait for table maintenance to finish",
        409,
      );
    if (input.expectedSchemaVersion !== table.schema_version)
      throw new RootsetError(
        "SCHEMA_VERSION_CONFLICT",
        "The fields changed. Reload this table before saving the view.",
        409,
      );
  }
  if (operation === "listSavedViews") {
    const result = await client.query<StoredSummary>(
      "SELECT id,table_id,owner_user_id,owner_name_snapshot,name,visibility,schema_version,version,created_at,updated_at FROM rootset_control.saved_views WHERE org_id=$1 AND table_id=$2 AND deleted_at IS NULL AND (visibility='shared' OR owner_user_id=$3) ORDER BY lower(name),id",
      [actor.orgId, tableId, userId],
    );
    return { data: result.rows.map((view) => summary(actor, view)) };
  }
  const fields = (
    await client.query<{ definition: FieldDefinition }>(
      "SELECT definition FROM rootset_control.fields WHERE table_id=$1 AND org_id=$2 AND state='active' ORDER BY position,id",
      [tableId, actor.orgId],
    )
  ).rows.map((row) => row.definition);
  let view: StoredView | undefined;
  if (operation !== "createSavedView") {
    view = (
      await client.query<StoredView>(
        `SELECT * FROM rootset_control.saved_views WHERE id=$1 AND org_id=$2 AND table_id=$3 AND deleted_at IS NULL AND (visibility='shared' OR owner_user_id=$4) ${modifying ? "FOR UPDATE" : ""}`,
        [IdSchema.parse(input.viewId), actor.orgId, tableId, userId],
      )
    ).rows[0];
    if (!view) missing();
    if (operation === "getSavedView") return full(actor, view, fields);
    if (!canEdit(actor, view))
      throw new RootsetError(
        "ACCESS_DENIED",
        "You cannot change this view",
        403,
      );
    if (VersionSchema.parse(input.expectedVersion) !== String(view.version))
      throw new RootsetError(
        "VIEW_VERSION_CONFLICT",
        "This view changed. Reload its saved settings before trying again.",
        409,
        { currentVersion: String(view.version) },
      );
  }
  if (operation === "deleteSavedView") {
    const deleted = (
      await client.query<{ version: string }>(
        "UPDATE rootset_control.saved_views SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND org_id=$2 RETURNING version::text",
        [view!.id, actor.orgId],
      )
    ).rows[0]!;
    return { id: view!.id, deleted: true, version: deleted.version };
  }
  const creating = operation === "createSavedView";
  const name =
    creating || input.name !== undefined
      ? AccountNameSchema.parse(input.name)
      : view!.name;
  const visibility =
    creating || input.visibility !== undefined
      ? SavedViewVisibilitySchema.parse(input.visibility)
      : view!.visibility;
  if (visibility === "shared")
    assertAccess(actor, {
      scope: "rows:write",
      orgId: actor.orgId,
      personal: true,
    });
  if (view && view.visibility !== visibility && view.owner_user_id !== userId)
    throw new RootsetError(
      "ACCESS_DENIED",
      "Only the owner can change this view’s visibility",
      403,
    );
  const definition =
    creating || input.definition !== undefined
      ? normalizeSavedViewDefinition(input.definition, fields)
      : view!.definition;
  await reserveScope(
    client,
    actor,
    tableId,
    visibility,
    view?.owner_user_id ?? userId,
    view?.id ?? null,
  );
  try {
    if (!view) {
      const owner = (
        await client.query<{ name: string }>(
          "SELECT name FROM rootset_control.users WHERE id=$1",
          [userId],
        )
      ).rows[0];
      if (!owner)
        throw new RootsetError(
          "UNAUTHENTICATED",
          "View owner is unavailable",
          401,
        );
      view = (
        await client.query<StoredView>(
          "INSERT INTO rootset_control.saved_views(id,org_id,table_id,owner_user_id,owner_name_snapshot,name,visibility,definition,schema_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            newId(),
            actor.orgId,
            tableId,
            userId,
            owner.name,
            name,
            visibility,
            JSON.stringify(definition),
            table.schema_version,
          ],
        )
      ).rows[0]!;
    } else {
      view = (
        await client.query<StoredView>(
          "UPDATE rootset_control.saved_views SET name=$3,visibility=$4,definition=$5,schema_version=$6,version=version+1,updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *",
          [
            view.id,
            actor.orgId,
            name,
            visibility,
            JSON.stringify(definition),
            input.definition === undefined
              ? view.schema_version
              : table.schema_version,
          ],
        )
      ).rows[0]!;
    }
  } catch (error) {
    const conflict = error as { code?: string; constraint?: string };
    if (
      conflict.code === "23505" &&
      ["saved_views_shared_name", "saved_views_personal_name"].includes(
        conflict.constraint ?? "",
      )
    )
      throw new RootsetError(
        "VIEW_NAME_CONFLICT",
        "A view with this name already exists in this scope",
        409,
      );
    throw error;
  }
  return full(actor, view, fields);
}
