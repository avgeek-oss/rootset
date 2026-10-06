"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AuthScreen } from "@avgeek-oss/design-system";

export const authTextActionClassName =
  "w-fit text-sm/5 text-muted underline decoration-dashed underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus";

export function AuthBrand() {
  return (
    <Link
      aria-label="Rootset sign in"
      className="inline-flex w-fit items-center gap-2.5 text-xl font-medium text-foreground"
      href="/login"
    >
      <span aria-hidden="true" className="rootset-symbol">
        r
      </span>
      Rootset
    </Link>
  );
}

export function AuthFrame({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <AuthScreen brand={<AuthBrand />} title={title} description={description}>
      {children}
    </AuthScreen>
  );
}
