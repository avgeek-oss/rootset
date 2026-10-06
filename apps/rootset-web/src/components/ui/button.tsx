// Adapted from the Apache-2.0 Towbar and Mill web design systems.
"use client";

import { Button as HeroButton } from "@heroui/react";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export type ButtonVariant =
  NonNullable<ComponentProps<typeof HeroButton>["variant"]> | "warning";
export type ButtonProps = Omit<
  ComponentProps<typeof HeroButton>,
  "size" | "variant"
> & {
  variant?: ButtonVariant;
};

export function Button({
  className,
  type = "button",
  variant,
  ...props
}: ButtonProps) {
  const variantClass =
    variant === "warning" ? "button--warning-soft" : undefined;
  const resolvedVariant =
    variant === "danger"
      ? "danger-soft"
      : variant === "warning"
        ? "secondary"
        : variant;
  return (
    <HeroButton
      {...props}
      type={type}
      size="sm"
      variant={resolvedVariant}
      className={
        typeof className === "function"
          ? (state) => cn(variantClass, className(state))
          : cn(variantClass, className)
      }
    />
  );
}
