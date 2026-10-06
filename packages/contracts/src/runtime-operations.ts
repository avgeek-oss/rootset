import { getOperation, type OperationDefinition } from "./operations";

export type RuntimeOperationDefinition = Pick<
  OperationDefinition,
  | "id"
  | "scopes"
  | "readOnly"
  | "destructive"
  | "idempotent"
  | "idempotencyRequired"
  | "stepUp"
  | "job"
  | "personal"
  | "minimumRole"
  | "resource"
  | "inputSchema"
  | "outputSchema"
  | "description"
  | "auditEvent"
  | "errors"
  | "successStatus"
>;

export function getRuntimeOperation(
  idOrTool: string,
): RuntimeOperationDefinition {
  return getOperation(idOrTool);
}
