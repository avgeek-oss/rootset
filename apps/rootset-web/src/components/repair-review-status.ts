import { limits, type OperatorRepairIntent } from "@rootset/contracts";

export const repairReviewError =
  "The requested repair details are unavailable. Reload the request before approving.";
export function repairReviewUnavailable(
  action:
    | {
        type?: string;
        state?: string;
        repairIntent?: OperatorRepairIntent;
      }
    | undefined,
) {
  return (
    action?.type === "operator_repair" &&
    (action.state === undefined ||
      action.state === "pending" ||
      action.state === "approved") &&
    (!action.repairIntent ||
      action.repairIntent.updates.length < 1 ||
      action.repairIntent.updates.length > limits.mutationBatch)
  );
}
