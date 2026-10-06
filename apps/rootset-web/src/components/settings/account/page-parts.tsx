"use client";
import {
  useId,
  useState,
  type ReactNode,
  type FormEvent,
  type ComponentProps,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FloppyDiskIcon } from "@hugeicons/core-free-icons";
import { Button } from "../../ui/towbar/design-system/buttons/button";
import { Widget } from "../../ui/towbar/design-system/data-display/widget";
import {
  Field,
  FieldLabel,
  FieldDescription,
} from "../../ui/towbar/design-system/forms/field";
import {
  Input,
  type InputProps,
} from "../../ui/towbar/design-system/forms/input";
import { PasswordInput } from "../../ui/towbar/design-system/forms/password-input";
import { Textarea } from "../../ui/towbar/design-system/forms/textarea";
import { Alert } from "../../ui/towbar/design-system/feedback/alert";
import { Spinner } from "../../ui/towbar/design-system/feedback/spinner";
import { AlertDialog } from "../../ui/towbar/design-system/overlays/alert-dialog";
import { toast } from "../../ui/towbar/design-system/overlays/toast";
import type { HeadingDocumentation } from "../../ui/towbar/design-system/overlays/heading-help";
import { cn } from "../../ui/towbar/design-system/lib/utils";
import { refreshApiQueries } from "./adapter";
export function ActionButton<T>({
  action,
  ariaLabel,
  children,
  confirm,
  isIconOnly = false,
  isDisabled = false,
  onSuccess,
  pendingLabel = "Working…",
  preserveLabelWhilePending = false,
  redirectOnSuccess,
  success,
  variant = "secondary",
}: {
  action: () => Promise<T>;
  ariaLabel?: string;
  children: ReactNode;
  confirm?: {
    actionLabel?: string;
    description: string;
    title: ReactNode;
  };
  isIconOnly?: boolean;
  isDisabled?: boolean;
  onSuccess?: (result: T) => void;
  pendingLabel?: string;
  preserveLabelWhilePending?: boolean;
  redirectOnSuccess?: (result: T) => string;
  success: string;
  variant?: "danger" | "primary" | "secondary" | "warning";
}) {
  const [busy, setBusy] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  async function runAction() {
    setBusy(true);
    try {
      const result = await action();
      if (redirectOnSuccess) {
        window.location.assign(redirectOnSuccess(result));
        await new Promise<never>(() => undefined);
      }
      toast.success(success);
      onSuccess?.(result);
      refreshApiQueries();
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const showPendingState = busy && !preserveLabelWhilePending;
  const triggerContent =
    showPendingState && isIconOnly ? (
      <Spinner aria-label={pendingLabel} size="sm" />
    ) : showPendingState ? (
      <>
        <Spinner aria-label={pendingLabel} size="sm" />
        {pendingLabel}
      </>
    ) : (
      children
    );
  const trigger = (
    <Button
      aria-label={ariaLabel}
      isDisabled={busy || isDisabled}
      isIconOnly={isIconOnly}
      variant={variant}
      onPress={confirm ? () => setIsConfirming(true) : runAction}
    >
      {triggerContent}
    </Button>
  );
  if (!confirm) {
    return trigger;
  }

  return (
    <>
      {trigger}
      <AlertDialog.Backdrop
        isOpen={isConfirming}
        onOpenChange={setIsConfirming}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>{confirm.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>{confirm.description}</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                isDisabled={busy || isDisabled}
                variant="secondary"
                onPress={() => setIsConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                isDisabled={busy || isDisabled}
                variant={
                  variant === "danger"
                    ? "danger"
                    : variant === "warning"
                      ? "warning"
                      : "primary"
                }
                onPress={() => {
                  setIsConfirming(false);
                  void runAction();
                }}
              >
                {showPendingState ? (
                  <>
                    <Spinner aria-label={pendingLabel} size="sm" />
                    {pendingLabel}
                  </>
                ) : confirm.actionLabel ? (
                  confirm.actionLabel
                ) : (
                  children
                )}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}

export function FormCard({
  children,
  className,
  headerEnd,
  help,
  icon,
  title,
  ...props
}: Omit<ComponentProps<typeof Widget>, "children" | "title"> & {
  children: ReactNode;
  headerEnd?: ReactNode;
  help?: HeadingDocumentation | false;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <Widget {...props} className={className}>
      <Widget.Header endContent={headerEnd}>
        <Widget.Title help={help} icon={icon}>
          {title}
        </Widget.Title>
      </Widget.Header>
      <Widget.Content>{children}</Widget.Content>
    </Widget>
  );
}

export function SimpleForm({
  fields,
  onSubmit,
  successMessage = "Saved",
  submitLabel,
  errorPresentation = "inline",
}: {
  fields: Array<{
    autoComplete?: string;
    className?: string;
    defaultValue?: string;
    description?: string;
    disabled?: boolean;
    label: string;
    maxLength?: number;
    minLength?: number;
    name: string;
    placeholder?: string;
    required?: boolean;
    rows?: number;
    spellCheck?: boolean;
    type?: string;
    variant?: InputProps["variant"];
  }>;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  successMessage?: string;
  submitLabel: string;
  errorPresentation?: "inline" | "toast";
}) {
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const formData = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      fields
        .filter((field) => !field.disabled)
        .map(({ name }) => {
          const value = formData.get(name);
          return [name, typeof value === "string" ? value : ""];
        }),
    );
    try {
      await onSubmit(values);
      toast.success(successMessage);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Could not save";
      if (errorPresentation === "toast") toast.danger(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="content-grid max-w-xl" onSubmit={submit}>
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Couldn&apos;t save</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {fields.map((field) => (
        <Field key={field.name}>
          <FieldLabel
            htmlFor={`${formId}-${field.name}`}
            isRequired={field.required}
          >
            {field.label}
          </FieldLabel>
          {field.type === "textarea" ? (
            <Textarea
              id={`${formId}-${field.name}`}
              autoComplete={field.autoComplete}
              className={cn("w-full", field.className)}
              defaultValue={field.defaultValue}
              disabled={field.disabled}
              maxLength={field.maxLength}
              minLength={field.minLength}
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              rows={field.rows ?? 6}
              spellCheck={field.spellCheck}
              variant={field.variant}
            />
          ) : field.type === "password" ? (
            <PasswordInput
              id={`${formId}-${field.name}`}
              autoComplete={field.autoComplete}
              defaultValue={field.defaultValue}
              disabled={field.disabled}
              maxLength={field.maxLength}
              minLength={field.minLength}
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              variant={field.variant}
            />
          ) : (
            <Input
              id={`${formId}-${field.name}`}
              autoComplete={field.autoComplete}
              className={field.className}
              defaultValue={field.defaultValue}
              disabled={field.disabled}
              maxLength={field.maxLength}
              minLength={field.minLength}
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              type={field.type}
              variant={field.variant}
            />
          )}
          {field.description ? (
            <FieldDescription>{field.description}</FieldDescription>
          ) : null}
        </Field>
      ))}
      <Button className="w-fit" isDisabled={busy} type="submit">
        <HugeiconsIcon
          aria-hidden="true"
          icon={FloppyDiskIcon}
          className="size-4 shrink-0"
        />
        {busy ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
