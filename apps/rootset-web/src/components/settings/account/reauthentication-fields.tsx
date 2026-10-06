"use client";
import { useId, useRef, useState } from "react";
import { Button } from "../../ui/towbar/design-system/buttons/button";
import { Field, FieldError } from "../../ui/towbar/design-system/forms/field";
import { Input } from "../../ui/towbar/design-system/forms/input";
import { Label } from "../../ui/towbar/design-system/forms/label";
import { PasswordInput } from "../../ui/towbar/design-system/forms/password-input";
import { toast } from "../../ui/towbar/design-system/overlays/toast";

export function ReauthenticationFields({
  email,
  twoFactorEnabled,
  onConfirm,
  initialCode = "",
}: {
  email: string;
  twoFactorEnabled: boolean;
  onConfirm: (credentials: { password: string; code: string }) => Promise<void>;
  initialCode?: string;
}) {
  const passwordId = useId();
  const codeId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<"password" | "code" | null>(null);

  async function confirm() {
    if (busy) return;
    const password = passwordRef.current?.value ?? "";
    const code = codeRef.current?.value ?? "";
    if (!password) {
      setInvalid("password");
      passwordRef.current?.focus();
      return;
    }
    if (twoFactorEnabled && !/^\d{6}$/u.test(code)) {
      setInvalid("code");
      codeRef.current?.focus();
      return;
    }
    setInvalid(null);
    setBusy(true);
    try {
      await onConfirm({ password, code });
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "Unable to continue. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="form"
      aria-label="Confirm identity"
      aria-busy={busy}
      className="content-grid"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          void confirm();
        }
      }}
    >
      <input
        aria-hidden="true"
        autoComplete="username"
        className="sr-only"
        defaultValue={email}
        name="username"
        tabIndex={-1}
        type="text"
      />
      <Field>
        <Label htmlFor={passwordId} isRequired>
          Password
        </Label>
        <PasswordInput
          id={passwordId}
          ref={passwordRef}
          name="password"
          variant="secondary"
          autoComplete="current-password"
          maxLength={1024}
          aria-invalid={invalid === "password"}
          onChange={() => setInvalid(null)}
          disabled={busy}
        />
        {invalid === "password" ? (
          <FieldError>Enter your password.</FieldError>
        ) : null}
      </Field>
      {twoFactorEnabled ? (
        <Field>
          <Label htmlFor={codeId} isRequired>
            Authenticator code
          </Label>
          <Input
            id={codeId}
            ref={codeRef}
            name="code"
            defaultValue={initialCode}
            variant="secondary"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            aria-invalid={invalid === "code"}
            onInput={(event) => {
              if (!/^\d{0,6}$/u.test(event.currentTarget.value))
                event.currentTarget.value = "";
              setInvalid(null);
            }}
            disabled={busy}
          />
          {invalid === "code" ? (
            <FieldError>Enter the six-digit authenticator code.</FieldError>
          ) : null}
        </Field>
      ) : null}
      <div className="flex">
        <Button isDisabled={busy} onPress={() => void confirm()}>
          {busy ? "Please wait…" : "Confirm"}
        </Button>
      </div>
    </div>
  );
}
