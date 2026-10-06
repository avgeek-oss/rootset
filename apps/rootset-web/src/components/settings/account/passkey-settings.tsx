"use client";
import { useState } from "react";
import { PasskeySettings as LibraryPasskeySettings } from "@avgeek-oss/design-system";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import {
  useAccess,
  refreshApiQueries,
  useApiQuery,
  api,
  useDateDisplay,
  registerPasskey,
  passkeyError,
} from "./adapter";

type Passkey = { id: string; name: string | null; createdAt: string };
export function PasskeySettings() {
  const { user } = useAccess();
  const displayDate = useDateDisplay();
  const keys = useApiQuery<{ passkeys: Passkey[] }>(
    "/v1/core/profile/passkeys",
  );
  const [codes, setCodes] = useState<string[]>([]);
  function changed() {
    refreshApiQueries();
    keys.refresh();
    window.dispatchEvent(new Event("rootset:identity-changed"));
  }
  if (keys.error) return <QueryError message={keys.error} />;
  if (!keys.data) return <QueryLoading />;
  return (
    <LibraryPasskeySettings
      items={keys.data.passkeys.map((key) => ({
        ...key,
        name: key.name || "Passkey",
      }))}
      formatDate={displayDate}
      maxNameLength={120}
      onAdd={async (name) => {
        if (!user) throw new Error("Sign in to add a passkey.");
        try {
          const result = await registerPasskey(name);
          if (result.recoveryCodes) setCodes(result.recoveryCodes);
        } catch (error) {
          throw new Error(passkeyError(error));
        }
        changed();
      }}
      onRename={async (id, name) => {
        await api.post("/v1/public/auth/identity/passkey/update-passkey", {
          id,
          name,
        });
        changed();
      }}
      onRemove={async (id) => {
        await api.post("/v1/public/auth/identity/passkey/delete-passkey", {
          id,
        });
        changed();
      }}
      onReplaceRecoveryCodes={async () => {
        const result = await api.post<{ recoveryCodes: string[] }>(
          "/v1/core/profile/passkeys/recovery-codes",
          {},
        );
        setCodes(result.recoveryCodes);
      }}
      recoveryCodes={codes}
      recoveryCodesFilename="rootset-recovery-codes.txt"
      onDismissRecoveryCodes={() => setCodes([])}
    />
  );
}
