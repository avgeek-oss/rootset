"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";

export function RootsetEmptyState({
  variant = "default",
  title,
  description,
  children,
}: {
  variant?: "default" | "sad" | "bucket";
  title?: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  const source = {
    default: "/mascot/elephant.webp",
    sad: "/mascot/elephant-sad.webp",
    bucket: "/mascot/elephant-bucket.webp",
  }[variant];
  return (
    <EmptyState>
      <EmptyState.Media>
        <Image
          src={source}
          alt=""
          aria-hidden="true"
          width={128}
          height={128}
          className="pointer-events-none h-32 w-32 select-none object-contain"
          unoptimized
        />
      </EmptyState.Media>
      <EmptyState.Header className="max-w-xl gap-2">
        {title && <EmptyState.Title>{title}</EmptyState.Title>}
        <EmptyState.Description className="text-pretty leading-relaxed">
          {description}
        </EmptyState.Description>
      </EmptyState.Header>
      {children && (
        <EmptyState.Content className="flex-wrap">
          {children}
        </EmptyState.Content>
      )}
    </EmptyState>
  );
}
