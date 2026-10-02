"use client";

import { Button, Modal } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { RepairIntentReview } from "../repair-intent-review";
import {
  repairReviewUnavailable,
  repairReviewError,
} from "../repair-review-status";
import type { OperatorRepairIntent } from "@rootset/contracts";
import { authClient } from "../../lib/auth-client";
import {
  performAction,
  registerApprovalHandler,
  useMutation,
  useResource,
  write,
  type AccountActionTicket,
} from "./api";
import {
  DateLabel,
  Empty,
  Feedback,
  Field,
  Form,
  Loading,
  Record,
  RecordList,
  Section,
  useConfirmation,
} from "./ui";
import type { SecurityStatus, SettingsPanelProps } from "./types";

interface InteractiveProof {
  actionId: string;
  proofUrl?: string;
}
interface Completion {
  id: string;
  status: string;
  result?: unknown;
}

export function AccountActionApproval({ orgId }: { orgId: string }) {
  const [ticket, setTicket] = useState<AccountActionTicket>();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
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
    operationId: string;
    result?: { input?: unknown; requestDigest?: string; clientId?: string };
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
          setTicket(next);
          setNeedsProof(false);
          setApproved(false);
          setPassword("");
          setCode("");
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
  async function approve() {
    if (!ticket) return;
    if (
      repairUnavailable ||
      review.loading ||
      review.error ||
      review.data?.id !== ticket.id
    )
      return;
    const result = await mutation.run(async () => {
      if (needsProof) {
        const response = await fetch("/v1/auth/reauthenticate", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password, ...(code ? { code } : {}) }),
        });
        const body: unknown = await response.json();
        if (!response.ok) throw body;
      }
      if (!approved) {
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
    if (result.ok) {
      pending.current?.resolve(result.value);
      pending.current = undefined;
      setTicket(undefined);
      setPassword("");
      setCode("");
    } else if (
      ["STEP_UP_REQUIRED", "RECENT_AUTH_REQUIRED", "UNAUTHENTICATED"].includes(
        result.error.code,
      )
    )
      setNeedsProof(true);
  }
  return (
    <Modal
      isOpen={Boolean(ticket)}
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
                onPress={approve}
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

function proofHeaders(actionId: string) {
  return { headers: { "X-Rootset-Action-ID": actionId } };
}
function checkResult<T extends { error?: { message?: string } | null }>(
  result: T,
) {
  if (result.error)
    throw new Error(
      result.error.message ?? "The authentication operation failed.",
    );
  return result;
}

export function SecuritySettings(props: SettingsPanelProps) {
  const resource = useResource<SecurityStatus | null>("/me/security", null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const confirmation = useConfirmation();
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [totpAction, setTotpAction] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const factorEnabled =
    resource.data?.twoFactorEnabled ?? resource.data?.totpEnabled ?? false;
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      <Section
        title="Password"
        description="A password change requires recent authentication and revokes relevant sessions and delegated grants. It does not disable your second factor."
      >
        <Form
          busy={mutation.busy}
          submit="Change password"
          onSubmit={async () => {
            const result = await mutation.run(
              () =>
                performAction("changePassword", {
                  currentPassword: password,
                  newPassword,
                }),
              "Password changed.",
            );
            if (result.ok) {
              setPassword("");
              setNewPassword("");
            }
          }}
        >
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            required
          />
          <Field
            label="New password"
            type="password"
            minLength={15}
            maxLength={1024}
            description="Use at least 15 characters."
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
            required
          />
        </Form>
      </Section>
      <Section
        title="Authenticator app"
        description="A password login requires your authenticator or a single-use recovery code when two-factor authentication is enabled."
      >
        <p>
          Two-factor authentication:{" "}
          <strong>{factorEnabled ? "Enabled" : "Disabled"}</strong>
        </p>
        <Field
          label="Current password for factor changes"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <div className="settings-actions">
          {!factorEnabled && !totpUri && (
            <Button
              isDisabled={mutation.busy || !password}
              onPress={async () => {
                const result = await mutation.run(async () => {
                  const proof = await performAction<InteractiveProof>(
                    "enableTwoFactor",
                    {},
                  );
                  const enabled = checkResult(
                    await authClient.twoFactor.enable({
                      password,
                      fetchOptions: proofHeaders(proof.actionId),
                    }),
                  );
                  return { actionId: proof.actionId, ...(enabled.data ?? {}) };
                }, "Authenticator setup started. Confirm a code before relying on this factor.");
                if (result.ok) {
                  const setup = result.value as {
                    actionId: string;
                    totpURI?: string;
                    backupCodes?: string[];
                  };
                  setTotpAction(setup.actionId);
                  setTotpUri(setup.totpURI ?? "");
                  setRecoveryCodes(setup.backupCodes ?? []);
                }
              }}
            >
              Set up authenticator
            </Button>
          )}
          {factorEnabled && (
            <Button
              variant="danger-soft"
              isDisabled={mutation.busy || !password}
              onPress={async () => {
                if (
                  await confirmation.confirm(
                    "Disable two-factor authentication?",
                    "Password logins will no longer require an authenticator or recovery code.",
                    "Disable factor",
                  )
                )
                  await mutation.run(async () => {
                    const proof = await performAction<InteractiveProof>(
                      "disableTwoFactor",
                      {},
                    );
                    checkResult(
                      await authClient.twoFactor.disable({
                        password,
                        fetchOptions: proofHeaders(proof.actionId),
                      }),
                    );
                  }, "Two-factor authentication disabled.");
              }}
            >
              Disable authenticator
            </Button>
          )}
        </div>
        {totpUri && (
          <div className="settings-preview">
            <Field
              label="Authenticator provisioning URI"
              value={totpUri}
              onChange={() => undefined}
              readOnly
              description="Add this account to your authenticator app. Keep this URI private."
            />
            <Button
              variant="secondary"
              onPress={() =>
                mutation
                  .run(
                    () => navigator.clipboard.writeText(totpUri),
                    "Provisioning URI copied.",
                  )
                  .then(() => undefined)
              }
            >
              Copy provisioning URI
            </Button>
            <Form
              busy={mutation.busy}
              submit="Confirm authenticator code"
              onSubmit={async () => {
                const result = await mutation.run(async () => {
                  checkResult(
                    await authClient.twoFactor.verifyTotp({
                      code: totpCode,
                      fetchOptions: proofHeaders(totpAction),
                    }),
                  );
                }, "Authenticator confirmed.");
                if (result.ok) {
                  setTotpUri("");
                  setTotpCode("");
                  setPassword("");
                }
              }}
            >
              <Field
                label="Six-digit code"
                value={totpCode}
                onChange={setTotpCode}
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
              />
            </Form>
          </div>
        )}
      </Section>
      <Section
        title="Recovery codes"
        description="Each code works once. Rotating codes invalidates the previous set."
      >
        <Button
          variant="secondary"
          isDisabled={mutation.busy || !password || !factorEnabled}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Replace recovery codes?",
                "Existing recovery codes stop working after this operation succeeds.",
                "Replace codes",
              )
            ) {
              const result = await mutation.run(async () => {
                const proof = await performAction<InteractiveProof>(
                  "rotateRecoveryCodes",
                  {},
                );
                return checkResult(
                  await authClient.twoFactor.generateBackupCodes({
                    password,
                    fetchOptions: proofHeaders(proof.actionId),
                  }),
                ).data;
              }, "Recovery codes replaced. Save the new codes.");
              if (result.ok)
                setRecoveryCodes(
                  (result.value as { backupCodes?: string[] } | null)
                    ?.backupCodes ?? [],
                );
            }
          }}
        >
          Generate replacement codes
        </Button>
        {recoveryCodes.length > 0 && (
          <div className="settings-preview">
            <p>Save these codes securely. They are displayed once.</p>
            <ul className="settings-recovery-codes">
              {recoveryCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            <div className="settings-actions">
              <Button
                variant="secondary"
                onPress={() =>
                  mutation
                    .run(
                      () =>
                        navigator.clipboard.writeText(recoveryCodes.join("\n")),
                      "Recovery codes copied.",
                    )
                    .then(() => undefined)
                }
              >
                Copy recovery codes
              </Button>
              <Button variant="ghost" onPress={() => setRecoveryCodes([])}>
                Dismiss codes
              </Button>
            </div>
          </div>
        )}
      </Section>
      <Section
        title="Passkeys"
        description="Passkeys are bound to this Rootset installation and require user verification. Register a device you control."
      >
        <Form
          busy={mutation.busy}
          submit="Register passkey"
          onSubmit={async () => {
            const result = await mutation.run(async () => {
              const proof = await performAction<InteractiveProof>(
                "registerPasskey",
                {},
              );
              checkResult(
                await authClient.passkey.addPasskey({
                  name: passkeyName || "My passkey",
                  fetchOptions: proofHeaders(proof.actionId),
                }),
              );
            }, "Passkey registered.");
            if (result.ok) setPasskeyName("");
          }}
        >
          <Field
            label="Passkey name"
            value={passkeyName}
            onChange={setPasskeyName}
            required
          />
        </Form>
        <RecordList>
          {resource.data?.passkeys?.map((passkey) => (
            <Record
              key={passkey.id}
              title={passkey.name ?? "Passkey"}
              description={
                <>
                  Added <DateLabel value={passkey.createdAt} /> · last used{" "}
                  <DateLabel value={passkey.lastUsedAt} />
                </>
              }
            >
              <Button
                variant="danger-soft"
                size="sm"
                isDisabled={mutation.busy}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Remove passkey?",
                      "This credential will no longer sign in to Rootset.",
                      "Remove passkey",
                    )
                  )
                    await mutation.run(async () => {
                      const proof = await performAction<InteractiveProof>(
                        "removePasskey",
                        { id: passkey.id },
                      );
                      checkResult(
                        await authClient.passkey.deletePasskey({
                          id: passkey.id,
                          fetchOptions: proofHeaders(proof.actionId),
                        }),
                      );
                    }, "Passkey removed.");
                }}
              >
                Remove
              </Button>
            </Record>
          ))}
        </RecordList>
        {resource.data?.passkeys?.length === 0 && (
          <Empty>No passkeys registered.</Empty>
        )}
      </Section>
      <Section
        title="Delete your account"
        description="Account deletion requires identity approval and obeys last-owner and retention rules."
      >
        <Button
          variant="danger-soft"
          isDisabled={mutation.busy}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Delete your account?",
                "Your memberships, credentials and delegated grants will be removed. Rootset preserves data attribution under its retention policy.",
                "Delete account",
              )
            )
              await mutation.run(
                () =>
                  performAction("deleteAccount", { confirmation: "DELETE" }),
                "Account deletion requested.",
              );
          }}
        >
          Delete account
        </Button>
      </Section>
      {confirmation.dialog}
    </>
  );
}
