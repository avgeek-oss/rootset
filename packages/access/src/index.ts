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

export const ALL_SCOPES = scopeNames;

export function roleAllows(role: Role, scope: string): boolean {
  return (
    scope === "viewer" ||
    (scope === "member" && role !== "viewer") ||
    (scope === "admin" && role === "admin")
  );
}

export function roleScopes(role: Role): string[] {
  return scopeNames.filter((scope) => roleAllows(role, scope));
}

export function scopesAllow(
  scopes: readonly string[],
  required: string,
): boolean {
  return (
    scopeNames.includes(required as (typeof scopeNames)[number]) &&
    (scopes.includes(required) ||
      scopes.includes("admin") ||
      (required === "viewer" && scopes.includes("member")))
  );
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
  return roleScopes(
    access === "read" ? "viewer" : includeAdmin ? "admin" : "member",
  );
}

export function scopedRole(role: Role, scopes: readonly string[]): Role {
  return keyRole(
    role,
    scopesAllow(scopes, "member") ? "edit" : "read",
    scopesAllow(scopes, "admin"),
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
  if (
    (requirement.roles && !requirement.roles.includes(actor.role)) ||
    !roleAllows(actor.role, requirement.scope)
  )
    throw new AccessError(
      "FORBIDDEN",
      "Your role does not allow this operation",
    );
  if (
    (actor.kind === "oauth" ||
      actor.kind === "personal_key" ||
      actor.kind === "workspace_key") &&
    !scopesAllow(actor.scopes, requirement.scope)
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
          actor.kind === "workspace_key") &&
          !scopesAllow(actor.scopes, scope)),
    )
  )
    throw new AccessError(
      "DELEGATION_EXCEEDS_AUTHORITY",
      "Requested OAuth operations exceed current authority",
    );
}
