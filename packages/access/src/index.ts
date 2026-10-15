import {
  scopeNames,
  RootsetError,
  type Actor,
  type Role,
} from "@rootset/contracts";
export type { Actor, Role } from "@rootset/contracts";

export class AccessError extends RootsetError {
  constructor(code: string, message: string, status = 403) {
    super(code, message, status);
    this.name = "AccessError";
  }
}

export const ALL_SCOPES = Object.freeze([...scopeNames, "installation:manage"]);

const personalScopes = new Set([
  "profile:manage",
  "account:security",
  "keys:manage",
]);

export function roleAllows(role: Role, scope: string): boolean {
  if (!ALL_SCOPES.includes(scope as (typeof ALL_SCOPES)[number])) return false;
  if (role === "admin") return true;
  if (scope.startsWith("backups:")) return false;
  if (personalScopes.has(scope) || scope === "org:read") return true;
  if (scope === "members:read" || scope.startsWith("installation:"))
    return false;
  if (scope.endsWith(":read")) return true;
  // Job ownership and purpose authority are rechecked by the job service.
  if (scope === "jobs:cancel" || scope === "jobs:retry") return true;
  return (
    role === "member" &&
    [
      "rows:write",
      "databases:manage",
      "tables:manage",
      "schema:manage",
    ].includes(scope)
  );
}

export function roleScopes(role: Role): string[] {
  return ALL_SCOPES.filter((scope) => roleAllows(role, scope));
}

export function keyRole(
  membershipRole: Role,
  access: "read" | "edit",
  includeAdmin: boolean,
): Role {
  if (access === "read" || membershipRole === "viewer") return "viewer";
  return includeAdmin && membershipRole === "admin" ? "admin" : "member";
}

export function keyScopes(
  access: "read" | "edit",
  includeAdmin: boolean,
): string[] {
  if (access === "read")
    return ALL_SCOPES.filter((scope) => scope.endsWith(":read"));
  if (includeAdmin) return [...ALL_SCOPES];
  return roleScopes("member").filter((scope) => !personalScopes.has(scope));
}

export function teamKeyScopes(
  access: "read" | "edit",
  includeAdmin: boolean,
): string[] {
  return keyScopes(access, includeAdmin).filter(
    (scope) => !personalScopes.has(scope) && scope !== "team-keys:manage",
  );
}

export function assertAccess(
  actor: Actor,
  requirement: {
    scope: string;
    orgId?: string;
    roles?: Role[];
    personal?: boolean;
  },
): void {
  if (requirement.orgId && actor.orgId !== requirement.orgId)
    throw new AccessError("RESOURCE_NOT_FOUND", "Resource was not found", 404);
  if (requirement.personal && !actor.userId)
    throw new AccessError(
      "PERSONAL_IDENTITY_REQUIRED",
      "This operation requires a user identity",
    );
  if (actor.kind === "operator" && actor.role !== "admin")
    throw new AccessError("FORBIDDEN", "Admin authority is required");
  if (requirement.roles && !requirement.roles.includes(actor.role))
    throw new AccessError(
      "FORBIDDEN",
      "Your role does not allow this operation",
    );
  if (!roleAllows(actor.role, requirement.scope))
    throw new AccessError(
      "FORBIDDEN",
      "Your role does not allow this operation",
    );
  if (
    (actor.kind === "oauth" ||
      actor.kind === "personal_key" ||
      actor.kind === "team_key") &&
    !actor.scopes.includes(requirement.scope)
  )
    throw new AccessError(
      "INSUFFICIENT_SCOPE",
      "The credential does not have the required operation scope",
    );
}

export function assertDelegation(actor: Actor, scopes: string[]): void {
  if (
    !scopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) =>
        !roleAllows(actor.role, scope) ||
        ((actor.kind === "oauth" ||
          actor.kind === "personal_key" ||
          actor.kind === "team_key") &&
          !actor.scopes.includes(scope)),
    )
  )
    throw new AccessError(
      "DELEGATION_EXCEEDS_AUTHORITY",
      "Requested OAuth operations exceed current authority",
    );
}
