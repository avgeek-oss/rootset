"use client";

import type { ComponentProps, ReactNode } from "react";
import { AsyncActionButton, AuthForm } from "@avgeek-oss/design-system";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import type { HeadingDocumentation } from "@avgeek-oss/design-system/overlays/heading-help";
import type { InputProps } from "@avgeek-oss/design-system/forms/input";
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
  success,
  variant = "secondary",
}: {
  action: () => Promise<T>;
  ariaLabel?: string;
  children: ReactNode;
  confirm?: { actionLabel?: string; description: string; title: string };
  isIconOnly?: boolean;
  isDisabled?: boolean;
  onSuccess?: (result: T) => void;
  pendingLabel?: string;
  success: string;
  variant?: "danger" | "primary" | "secondary";
}) {
  return (
    <AsyncActionButton
      aria-label={ariaLabel}
      isIconOnly={isIconOnly}
      isDisabled={isDisabled}
      variant={variant}
      pendingLabel={pendingLabel}
      confirmation={
        confirm
          ? {
              title: confirm.title,
              description: confirm.description,
              confirmLabel: confirm.actionLabel,
              variant: variant === "danger" ? "danger" : "primary",
            }
          : undefined
      }
      onAction={async () => {
        const result = await action();
        toast.success(success);
        onSuccess?.(result);
        refreshApiQueries();
      }}
    >
      {children}
    </AsyncActionButton>
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
}: {
  fields: Array<
    ComponentProps<typeof AuthForm>["fields"][number] & {
      variant?: InputProps["variant"];
    }
  >;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  successMessage?: string;
  submitLabel: string;
}) {
  return (
    <AuthForm
      fields={fields.map((field) => {
        const input = { ...field };
        delete input.variant;
        return input;
      })}
      variant="secondary"
      submitLabel={submitLabel}
      busyLabel="Saving…"
      submitButtonClassName="w-auto"
      onSubmit={async (values) => {
        await onSubmit(values);
        toast.success(successMessage);
      }}
    />
  );
}
