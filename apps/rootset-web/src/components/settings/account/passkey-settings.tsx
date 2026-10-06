"use client";

import { useState } from "react";
import { AuthForm } from "@avgeek-oss/design-system";
import { PasskeysTable } from "@avgeek-oss/design-system/patterns/settings/tables";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { FormCard, ActionButton } from "./page-parts";
import {
  api,
  useAccess,
  useApiQuery,
  useDateDisplay,
  registerPasskey,
  passkeyError,
  refreshApiQueries,
} from "./adapter";

type Passkey = { id: string; name: string; createdAt: string };
export function PasskeySettings() {
  const displayDate = useDateDisplay();
  const { user } = useAccess();
  const keys = useApiQuery<{ passkeys: Passkey[] }>(
    "/v1/core/profile/passkeys",
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Passkey | null>(null);
  const [busy, setBusy] = useState(false);
  function changed() {
    refreshApiQueries();
    keys.refresh();
    window.dispatchEvent(new Event("rootset:identity-changed"));
  }
  function edit(key: Passkey | null) {
    setEditing(key);
    setOpen(true);
  }
  if (keys.error)
    return <QueryError message={keys.error} onRetry={keys.refresh} />;
  if (!keys.data) return <QueryLoading />;
  return (
    <>
      <FormCard
        title="Passkeys"
        headerEnd={<Button onPress={() => edit(null)}>Add passkey</Button>}
      >
        <PasskeysTable
          items={keys.data.passkeys}
          formatDate={displayDate}
          actions={(key) => (
            <>
              <Button variant="secondary" onPress={() => edit(key)}>
                Rename
              </Button>
              <ActionButton
                variant="danger"
                success="Passkey removed"
                confirm={{
                  title: "Remove passkey?",
                  description: key.name || "Passkey",
                  actionLabel: "Remove",
                }}
                action={async () => {
                  await api.post(
                    "/v1/public/auth/identity/passkey/delete-passkey",
                    { id: key.id },
                  );
                  changed();
                }}
              >
                Remove
              </ActionButton>
            </>
          )}
        />
      </FormCard>
      <Modal.Backdrop
        isOpen={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>
                {editing ? "Rename passkey" : "Add passkey"}
              </Modal.Heading>
              <Modal.CloseTrigger isDisabled={busy} />
            </Modal.Header>
            <Modal.Body>
              <AuthForm
                key={editing?.id ?? "add"}
                variant="secondary"
                fields={[
                  {
                    name: "name",
                    label: "Name",
                    required: true,
                    maxLength: 120,
                    defaultValue: editing?.name ?? "",
                    autoComplete: "off",
                  },
                ]}
                submitLabel={editing ? "Update" : "Continue"}
                onCancel={() => {
                  if (!busy) setOpen(false);
                }}
                onSubmit={async (values) => {
                  setBusy(true);
                  try {
                    if (editing)
                      await api.post(
                        "/v1/public/auth/identity/passkey/update-passkey",
                        { id: editing.id, name: values.name },
                      );
                    else {
                      if (!user) throw new Error("Sign in to add a passkey.");
                      await registerPasskey(values.name ?? "");
                    }
                    setOpen(false);
                    changed();
                  } catch (error) {
                    throw new Error(passkeyError(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
