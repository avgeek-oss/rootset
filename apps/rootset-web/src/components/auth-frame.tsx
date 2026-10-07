"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AuthScreen } from "@avgeek-oss/design-system";
import { BrandLockup } from "@avgeek-oss/design-system/media/brand-lockup";

export const authTextActionClassName =
  "w-fit text-sm/5 text-muted underline decoration-dashed underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus";

export function AuthBrand() {
  return (
    <Link
      aria-label="Rootset sign in"
      className="inline-flex w-fit text-foreground"
      href="/login"
    >
      <BrandLockup
        logo={<span className="rootset-symbol rootset-auth-symbol">r</span>}
      >
        Rootset
      </BrandLockup>
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
