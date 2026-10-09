import { describe, expect, it } from "vitest";
import type { AccountActionTicket } from "../api";
import { usesAccountConfirmation } from "./approval-policy";

const ticket: AccountActionTicket = {
  id: "requested-action",
  operationId: "registerPasskey",
  type: "register_passkey",
  expiresAt: "2026-10-05T12:00:00.000Z",
  approvalUrl: "/account-actions/requested-action",
};
const review = {
  id: ticket.id,
  type: ticket.type,
  state: "pending",
  result: { operationId: ticket.operationId },
};

describe("account confirmation boundary", () => {
  it("uses compact confirmation only for the matching account form request", () => {
    expect(usesAccountConfirmation(ticket, review)).toBe(true);
    expect(
      usesAccountConfirmation(ticket, { ...review, id: "other-action" }),
    ).toBe(false);
    expect(
      usesAccountConfirmation(ticket, { ...review, type: "delete_table" }),
    ).toBe(false);
    expect(
      usesAccountConfirmation(ticket, {
        ...review,
        result: { operationId: "changeEmail" },
      }),
    ).toBe(false);
  });
  it("retains manual review for delete and repair intents", () => {
    for (const operationId of ["mutateRows", "deleteDatabase", "deleteTable"])
      expect(
        usesAccountConfirmation(
          { ...ticket, operationId },
          { ...review, result: { operationId } },
        ),
      ).toBe(false);
  });
  it("does not implicitly approve external or unavailable requests", () => {
    expect(
      usesAccountConfirmation({ ...ticket, operationId: undefined }, review),
    ).toBe(false);
    expect(usesAccountConfirmation(undefined, review)).toBe(false);
    expect(usesAccountConfirmation(ticket, null)).toBe(false);
  });
  it("allows a consumed matching ticket to replay without approving it again", () => {
    expect(
      usesAccountConfirmation(ticket, {
        ...review,
        state: "consumed",
        result: undefined,
      }),
    ).toBe(true);
  });
});
