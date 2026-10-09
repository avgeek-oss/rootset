"use client";

import { Modal } from "@heroui/react";
import { ReauthenticationDialog } from "./account/reauthentication-dialog";
import { useAccess } from "./account/adapter";
import { usesAccountConfirmation } from "./account/approval-policy";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useEffect, useRef, useState } from "react";
import { RepairIntentReview } from "../repair-intent-review";
import {
  repairReviewUnavailable,
  repairReviewError,
} from "../repair-review-status";
import type { OperatorRepairIntent } from "@rootset/contracts";
import {
  registerApprovalHandler,
  useMutation,
  useResource,
  write,
  type AccountActionTicket,
} from "./api";
import { DateLabel, Loading } from "./ui";

interface Completion {
  id: string;
  status: string;
  result?: unknown;
}

export function AccountActionApproval({ orgId }: { orgId: string }) {
  const { user } = useAccess();
  const attemptedAccountAction = useRef<string | null>(null);
  const [ticket, setTicket] = useState<AccountActionTicket>();
  const [needsProof, setNeedsProof] = useState(false);
  const [approved, setApproved] = useState(false);
  const pending = useRef<
    | { resolve: (value: unknown) => void; reject: (error: unknown) => void }
    | undefined
  >(undefined);
  const mutation = useMutation();
  const review = useResource<{
    id: string;
    type?: AccountActionTicket["type"];
    state?: string;
    repairIntent?: OperatorRepairIntent;
    result?: {
      operationId?: string;
      input?: unknown;
      requestDigest?: string;
      clientId?: string;
    };
  } | null>(ticket ? `/me/actions/${ticket.id}` : undefined, null);
  const repairUnavailable = repairReviewUnavailable(
    review.data
      ? { ...review.data, type: review.data.type ?? ticket?.type }
      : ticket?.type === "operator_repair"
        ? { type: ticket.type }
        : undefined,
  );
  useEffect(() => {
    const unregister = registerApprovalHandler(
      (next) =>
        new Promise((resolve, reject) => {
          pending.current?.reject(
            new Error("The previous account action was cancelled."),
          );
          pending.current = { resolve, reject };
          attemptedAccountAction.current = null;
          setTicket(next);
          setNeedsProof(false);
          setApproved(false);
        }),
      orgId,
    );
    return () => {
      unregister();
      pending.current?.reject(new Error("The account action was cancelled."));
      pending.current = undefined;
    };
  }, [orgId]);
  function cancel() {
    pending.current?.reject(new Error("Account action cancelled."));
    pending.current = undefined;
    setTicket(undefined);
  }
  async function approve(proofVerified = false) {
    if (!ticket) return;
    if (
      repairUnavailable ||
      review.loading ||
      review.error ||
      review.data?.id !== ticket.id
    )
      return;
    const currentPending = pending.current;
    const result = await mutation.run(async () => {
      if (needsProof && !proofVerified)
        throw new Error("Confirm your identity before approving this action.");
      if (!approved && review.data?.state !== "consumed") {
        await write(`/account-actions/${ticket.id}/approve`, "POST", {});
        setApproved(true);
      }
      const completed = await write<Completion>(
        `/me/actions/${ticket.id}/complete`,
        "POST",
        { id: ticket.id },
      );
      return completed.result;
    }, "Account action approved.");
    if (pending.current !== currentPending) return;
    if (result.ok) {
      pending.current?.resolve(result.value);
      pending.current = undefined;
      setTicket(undefined);
    } else {
      const needsReauthentication = [
        "STEP_UP_REQUIRED",
        "RECENT_AUTH_REQUIRED",
        "UNAUTHENTICATED",
      ].includes(result.error.code);
      if (needsReauthentication) setNeedsProof(true);
      if (proofVerified) throw new Error(result.error.message);
      if (
        !needsReauthentication &&
        usesAccountConfirmation(ticket, review.data)
      ) {
        pending.current?.reject(new Error(result.error.message));
        pending.current = undefined;
        setTicket(undefined);
      }
    }
  }
  const accountAction = usesAccountConfirmation(ticket, review.data);
  useEffect(() => {
    if (
      !accountAction ||
      !ticket ||
      needsProof ||
      review.loading ||
      review.error ||
      review.data?.id !== ticket.id ||
      attemptedAccountAction.current === ticket.id
    )
      return;
    attemptedAccountAction.current = ticket.id;
    void approve();
  }, [
    accountAction,
    ticket,
    needsProof,
    review.loading,
    review.error,
    review.data,
  ]);
  const identityDialog = (
    <ReauthenticationDialog
      key={ticket?.id}
      isOpen={Boolean(ticket) && needsProof}
      onOpenChange={(open) => {
        if (!open && !mutation.busy) cancel();
      }}
      hasPasskey={Boolean(user?.twoFactorEnabled)}
      onConfirmed={async () => {
        if (accountAction) await approve(true);
        else setNeedsProof(false);
      }}
    />
  );
  if (accountAction) return identityDialog;
  return (
    <>
      {identityDialog}
      <Modal
        isOpen={Boolean(ticket) && !review.loading && !needsProof}
        onOpenChange={(open) => {
          if (!open && !mutation.busy) cancel();
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Approve account action</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p>
                  This approval is bound to the requested operation and can be
                  used once.
                </p>
                <p className="settings-muted">
                  {ticket?.operationId} · expires{" "}
                  <DateLabel value={ticket?.expiresAt} />
                </p>
                <Loading {...review} retry={review.reload} />
                {review.data?.type === "operator_repair" &&
                  review.data.repairIntent &&
                  !repairUnavailable && (
                    <RepairIntentReview
                      key={ticket?.id}
                      intent={review.data.repairIntent}
                    />
                  )}
                {repairUnavailable && (
                  <p role="alert" className="error-message">
                    {repairReviewError}
                  </p>
                )}
                {review.data?.type !== "operator_repair" &&
                  review.data?.result && (
                    <dl className="action-review">
                      <dt>Application</dt>
                      <dd>
                        {review.data.result.clientId ?? "Rootset browser"}
                      </dd>
                      <dt>Requested changes</dt>
                      <dd>
                        <pre>
                          {JSON.stringify(
                            review.data.result.input ?? {},
                            null,
                            2,
                          )}
                        </pre>
                      </dd>
                      <dt>Request fingerprint</dt>
                      <dd>
                        {review.data.result.requestDigest ?? "Unavailable"}
                      </dd>
                    </dl>
                  )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="secondary"
                  isDisabled={mutation.busy}
                  onPress={cancel}
                >
                  Cancel
                </Button>
                <Button
                  isPending={mutation.busy}
                  isDisabled={
                    mutation.busy ||
                    review.loading ||
                    !!review.error ||
                    !review.data ||
                    review.data.id !== ticket?.id ||
                    repairUnavailable
                  }
                  onPress={() => void approve()}
                >
                  {approved
                    ? "Complete approved action"
                    : needsProof
                      ? "Verify and approve"
                      : "Approve action"}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
