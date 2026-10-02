import { JobAcceptedSchema } from "./models";
import { getOperation, type OperationDefinition } from "./operations";
import { DeleteAccountInputSchema } from "./resources";

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
  | "operator"
  | "minimumRole"
  | "resource"
  | "inputSchema"
  | "outputSchema"
  | "description"
  | "auditEvent"
  | "errors"
  | "successStatus"
>;

const deleteAccount: RuntimeOperationDefinition = Object.freeze({
  id: "deleteAccount",
  scopes: ["account:security"],
  readOnly: false,
  destructive: true,
  idempotent: true,
  idempotencyRequired: true,
  stepUp: "required",
  job: true,
  personal: true,
  operator: false,
  minimumRole: "viewer",
  resource: "none",
  inputSchema: DeleteAccountInputSchema,
  outputSchema: JobAcceptedSchema,
  description:
    "Admit deletion of the current personal account through its explicitly confirmed, approved account action, preserving the last-Owner check and current authority.",
  auditEvent: "deleteAccount",
  errors: [
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "ACCESS_DENIED",
    "INSUFFICIENT_SCOPE",
    "PERSONAL_IDENTITY_REQUIRED",
    "STEP_UP_REQUIRED",
    "LAST_OWNER",
    "IDEMPOTENCY_CONFLICT",
    "DEPENDENCY_UNAVAILABLE",
  ],
  successStatus: 202,
});

export function getRuntimeOperation(
  idOrTool: string,
): RuntimeOperationDefinition {
  return idOrTool === "deleteAccount" ? deleteAccount : getOperation(idOrTool);
}
