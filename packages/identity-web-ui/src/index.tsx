"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";

// Adapted from Towbar identity-web-ui at bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2.
export function IdentityAuthFrame({
  title,
  children,
  description,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="identity-shell">
      <a className="identity-brand" href="/" aria-label="Rootset home">
        <span aria-hidden="true" className="rootset-symbol">
          r
        </span>
        Rootset
      </a>
      <section className="identity-panel">
        <header className="identity-heading">
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        {children}
      </section>
      <footer className="identity-footer">
        Structured data, a clear source of truth.
      </footer>
    </main>
  );
}

export function IdentityCredentialsForm({
  onSubmit,
  error,
  submitLabel = "Sign in",
  defaultEmail = "",
  passwordAction,
  nameRequired = false,
  emailReadOnly = false,
}: {
  onSubmit: (credentials: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<void>;
  error?: string | null;
  submitLabel?: string;
  defaultEmail?: string;
  passwordAction?: ReactNode;
  nameRequired?: boolean;
  emailReadOnly?: boolean;
}) {
  const id = useId();
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setLocalError(null);
    try {
      await onSubmit({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        ...(nameRequired ? { name: String(form.get("name") ?? "") } : {}),
      });
    } catch (failure) {
      setLocalError(
        failure instanceof Error
          ? failure.message
          : "The request could not be completed",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="identity-form" onSubmit={submit}>
      {nameRequired && (
        <TextField isRequired name="name">
          <Label>Name</Label>
          <Input autoComplete="name" />
        </TextField>
      )}
      <TextField
        isRequired
        name="email"
        type="email"
        defaultValue={defaultEmail}
        isReadOnly={emailReadOnly}
      >
        <Label>Email address</Label>
        <Input autoComplete="username" />
      </TextField>
      <TextField isRequired name="password" type="password">
        <div className="label-actions">
          <Label>Password</Label>
          {passwordAction}
        </div>
        <Input
          autoComplete={nameRequired ? "new-password" : "current-password"}
          minLength={nameRequired ? 15 : undefined}
        />
      </TextField>
      {(error ?? localError) && (
        <p id={`${id}-error`} className="error-message" role="alert">
          {error ?? localError}
        </p>
      )}
      <Button
        type="submit"
        isDisabled={pending}
        className="primary-action"
        aria-describedby={error || localError ? `${id}-error` : undefined}
      >
        {pending ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}
