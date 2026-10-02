import { RootsetError, type Actor, type Role } from "@rootset/contracts";
export type { Actor, Role } from "@rootset/contracts";
export type GrantLevel = "read" | "edit" | "manage";
export interface TargetGrant {
  databaseId?: string;
  tableId?: string;
  level: GrantLevel;
}
export class AccessError extends RootsetError {
  constructor(code: string, message: string, status = 403) {
    super(code, message, status);
    this.name = "AccessError";
  }
}
const ranks: Record<GrantLevel, number> = { read: 1, edit: 2, manage: 3 };
const personalScopes = new Set([
  "profile:manage",
  "account:security",
  "ownership:manage",
]);
const administrationScopes = new Set([
  "members:manage",
  "members:read",
  "org:manage",
  "grants:manage",
  "backups:manage",
  "audit:read",
]);
export const ALL_SCOPES = [
  "org:read",
  "org:manage",
  "ownership:manage",
  "members:read",
  "members:manage",
  "grants:manage",
  "audit:read",
  "profile:manage",
  "account:security",
  "keys:manage",
  "databases:read",
  "databases:manage",
  "tables:read",
  "tables:manage",
  "schema:manage",
  "rows:read",
  "rows:write",
  "history:read",
  "imports:write",
  "exports:read",
  "backups:read",
  "backups:manage",
  "jobs:read",
  "jobs:cancel",
  "jobs:retry",
  "installation:read",
  "installation:manage",
] as const;
export function roleAllows(
  role: Role,
  scope: string,
  explicitManage = false,
): boolean {
  if (scope.startsWith("installation:")) return false;
  if (!ALL_SCOPES.includes(scope as (typeof ALL_SCOPES)[number])) return false;
  if (scope === "ownership:manage") return role === "owner";
  if (role === "owner" || role === "admin") return true;
  if (
    personalScopes.has(scope) ||
    scope === "keys:manage" ||
    scope === "org:read"
  )
    return true;
  if (administrationScopes.has(scope)) return false;
  if (["databases:manage", "tables:manage", "schema:manage"].includes(scope))
    return role === "editor" && explicitManage;
  if (scope.endsWith(":read")) return true;
  if (["jobs:cancel", "jobs:retry"].includes(scope)) return true;
  return (
    role === "editor" &&
    ["rows:write", "imports:write", "jobs:cancel", "jobs:retry"].includes(scope)
  );
}
export function targetAllows(
  actor: Actor,
  target: { databaseId?: string; tableId?: string },
  level: GrantLevel,
): boolean {
  if (!target.databaseId && !target.tableId) return true;
  if (actor.unrestricted) return true;
  return actor.targets.some(
    (g) =>
      (!g.databaseId || g.databaseId === target.databaseId) &&
      (!g.tableId || g.tableId === target.tableId) &&
      ranks[g.level] >= ranks[level],
  );
}
export function assertAccess(
  actor: Actor,
  requirement: {
    scope: string;
    orgId?: string;
    databaseId?: string;
    tableId?: string;
    level?: GrantLevel;
    roles?: Role[];
    personal?: boolean;
    operator?: boolean;
  },
): void {
  const explicitManage = actor.targets.some(
    (g) =>
      g.level === "manage" &&
      (!g.databaseId || g.databaseId === requirement.databaseId) &&
      (!g.tableId || g.tableId === requirement.tableId),
  );
  if (requirement.orgId && actor.orgId !== requirement.orgId)
    throw new AccessError("RESOURCE_NOT_FOUND", "Resource was not found", 404);
  if (requirement.personal && (!actor.userId || actor.kind === "team_key"))
    throw new AccessError(
      "PERSONAL_IDENTITY_REQUIRED",
      "This operation requires a user identity",
    );
  if (requirement.roles && !requirement.roles.includes(actor.role))
    throw new AccessError(
      "FORBIDDEN",
      "Your role does not allow this operation",
    );
  if (requirement.operator || requirement.scope.startsWith("installation:")) {
    if (!actor.operator || actor.kind === "team_key")
      throw new AccessError(
        "OPERATOR_REQUIRED",
        "Installation operator authority is required",
      );
  } else if (!roleAllows(actor.role, requirement.scope, explicitManage))
    throw new AccessError(
      "FORBIDDEN",
      "Your role does not allow this operation",
    );
  if (actor.kind === "team_key" && personalScopes.has(requirement.scope))
    throw new AccessError(
      "PERSONAL_IDENTITY_REQUIRED",
      "A team key cannot act as a person",
    );
  if (!actor.scopes.includes(requirement.scope))
    throw new AccessError(
      "INSUFFICIENT_SCOPE",
      "The credential does not have the required scope",
    );
  if (!targetAllows(actor, requirement, requirement.level ?? "read"))
    throw new AccessError("RESOURCE_NOT_FOUND", "Resource was not found", 404);
}
export function intersectTargets(
  a: TargetGrant[],
  b: TargetGrant[],
): TargetGrant[] {
  const result: TargetGrant[] = [];
  for (const x of a)
    for (const y of b) {
      if (x.databaseId && y.databaseId && x.databaseId !== y.databaseId)
        continue;
      if (x.tableId && y.tableId && x.tableId !== y.tableId) continue;
      const grant = {
        databaseId: x.databaseId ?? y.databaseId,
        tableId: x.tableId ?? y.tableId,
        level: ranks[x.level] <= ranks[y.level] ? x.level : y.level,
      };
      if (!result.some((g) => JSON.stringify(g) === JSON.stringify(grant)))
        result.push(grant);
    }
  return result;
}
export function assertDelegation(
  actor: Actor,
  scopes: string[],
  targets: TargetGrant[],
  unrestricted = false,
): void {
  if (
    scopes.some(
      (scope) =>
        !actor.scopes.includes(scope) ||
        (!scope.startsWith("installation:") &&
          !roleAllows(
            actor.role,
            scope,
            actor.targets.some((g) => g.level === "manage"),
          )),
    )
  )
    throw new AccessError(
      "DELEGATION_EXCEEDS_AUTHORITY",
      "Requested scopes exceed current authority",
    );
  if (
    scopes.some((s) => s.startsWith("installation:")) &&
    (!actor.operator || actor.kind === "team_key")
  )
    throw new AccessError(
      "OPERATOR_REQUIRED",
      "Installation operator authority is required",
    );
  if (unrestricted && !actor.unrestricted)
    throw new AccessError(
      "DELEGATION_EXCEEDS_AUTHORITY",
      "Requested targets exceed current authority",
    );
  for (const target of targets)
    if (
      !target.databaseId && !target.tableId
        ? !actor.unrestricted &&
          !actor.targets.some(
            (grant) =>
              !grant.databaseId &&
              !grant.tableId &&
              ranks[grant.level] >= ranks[target.level],
          )
        : !targetAllows(actor, target, target.level)
    )
      throw new AccessError(
        "DELEGATION_EXCEEDS_AUTHORITY",
        "Requested targets exceed current authority",
      );
  if (actor.role === "viewer" && targets.some((t) => t.level !== "read"))
    throw new AccessError(
      "DELEGATION_EXCEEDS_AUTHORITY",
      "Viewers can delegate read access only",
    );
}
