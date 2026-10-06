"use client";

import { Modal } from "@heroui/react";
import { ReauthenticationFields } from "./account/reauthentication-fields";
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
import { authClient } from "../../lib/auth-client";
import {
  registerApprovalHandler,
  useMutation,
  useResource,
  write,
  type AccountActionTicket,
} from "./api";
import { DateLabel, Feedback, Field, Loading } from "./ui";

interface Completion {
  id: string;
  status: string;
  result?: unknown;
}

export function AccountActionApproval({ orgId }: { orgId: string }) {
  const { user } = useAccess();
  const attemptedAccountAction = useRef<string | null>(null);
  const [ticket, setTicket] = useState<AccountActionTicket>();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsProof, setNeedsProof] = useState(false);
  const [requirePassword, setRequirePassword] = useState(false);
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
      (next, options) =>
        new Promise((resolve, reject) => {
          pending.current?.reject(
            new Error("The previous account action was cancelled."),
          );
          pending.current = { resolve, reject };
          attemptedAccountAction.current = null;
          setTicket(next);
          setNeedsProof(Boolean(options?.requirePassword));
          setRequirePassword(Boolean(options?.requirePassword));
          setApproved(false);
          setPassword("");
          setCode(options?.code ?? "");
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
    setPassword("");
    setCode("");
  }
  async function approve(credentials?: { password: string; code: string }) {
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
      if (needsProof) {
        const response = await fetch("/v1/auth/reauthenticate", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: credentials?.password ?? password,
            ...((credentials?.code ?? code)
              ? { code: credentials?.code ?? code }
              : {}),
          }),
        });
        const body: unknown = await response.json();
        if (!response.ok) throw body;
      }
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
      pending.current?.resolve(
        requirePassword
          ? {
              ...(result.value as object),
              password: credentials?.password ?? password,
            }
          : result.value,
      );
      pending.current = undefined;
      setTicket(undefined);
      setPassword("");
      setCode("");
    } else {
      const needsReauthentication = [
        "STEP_UP_REQUIRED",
        "RECENT_AUTH_REQUIRED",
        "UNAUTHENTICATED",
      ].includes(result.error.code);
      if (needsReauthentication) setNeedsProof(true);
      if (credentials) throw new Error(result.error.message);
      if (
        !needsReauthentication &&
        usesAccountConfirmation(ticket, review.data)
      ) {
        pending.current?.reject(new Error(result.error.message));
        pending.current = undefined;
        setTicket(undefined);
        setPassword("");
        setCode("");
      }
    }
  }
  const accountAction = usesAccountConfirmation(ticket, review.data);
  useEffect(() => {
    if (
      !accountAction ||
      !ticket ||
      needsProof ||
      requirePassword ||
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
    requirePassword,
    review.loading,
    review.error,
    review.data,
  ]);
  if (accountAction)
    return (
      <Modal.Backdrop
        isOpen={Boolean(ticket) && (needsProof || requirePassword)}
        onOpenChange={(open) => {
          if (!open && !mutation.busy) cancel();
        }}
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Confirm it’s you</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <p className="mb-4 text-sm text-muted">
                Confirm your password to continue with this sensitive action.
              </p>
              {(needsProof || requirePassword) && (
                <ReauthenticationFields
                  key={ticket?.id}
                  email={user?.email ?? ""}
                  twoFactorEnabled={Boolean(user?.twoFactorEnabled)}
                  initialCode={code}
                  onConfirm={approve}
                />
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    );
  return (
    <Modal
      isOpen={Boolean(ticket) && !review.loading}
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
                    <dd>{review.data.result.clientId ?? "Rootset browser"}</dd>
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
                    <dd>{review.data.result.requestDigest ?? "Unavailable"}</dd>
                  </dl>
                )}
              <Feedback {...mutation} />
              {needsProof && (
                <>
                  <Field
                    label="Current password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={setPassword}
                    required
                  />
                  <Field
                    label="Authenticator code (if enabled)"
                    value={code}
                    onChange={setCode}
                    autoComplete="one-time-code"
                  />
                  {!requirePassword && (
                    <Button
                      variant="secondary"
                      isDisabled={mutation.busy}
                      onPress={async () => {
                        const result = await mutation.run(async () => {
                          const signed = await authClient.signIn.passkey();
                          if (signed.error) throw signed.error;
                          setNeedsProof(false);
                        }, "Passkey verified. Approve the action to continue.");
                        if (result.ok) setPassword("");
                      }}
                    >
                      Verify with a passkey
                    </Button>
                  )}
                </>
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
  );
}
