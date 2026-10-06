import type { AccountActionTicket } from "../api";

const personalAccountActions = new Set([
  "createPersonalKey",
  "rotatePersonalKey",
  "changeEmail",
  "changePassword",
  "registerPasskey",
  "removePasskey",
  "enableTwoFactor",
  "disableTwoFactor",
]);

export function usesAccountConfirmation(
  ticket: AccountActionTicket | undefined,
  review: {
    id: string;
    type?: AccountActionTicket["type"];
    state?: string;
    result?: { operationId?: string };
  } | null,
): boolean {
  return Boolean(
    ticket?.operationId &&
    personalAccountActions.has(ticket.operationId) &&
    review?.id === ticket.id &&
    review.type === ticket.type &&
    (review.state === "consumed" ||
      review.result?.operationId === ticket.operationId),
  );
}
