import { getOperation, type Actor } from "@rootset/contracts";

/** Existing synthetic fixtures live in Default; external calls still supply its ID explicitly. */
export function workspaceInput(
  operationId: string,
  actor: Actor,
  input: unknown,
): unknown {
  return getOperation(operationId).workspaceScoped &&
    input &&
    typeof input === "object"
    ? { workspaceId: actor.orgId, ...input }
    : input;
}
