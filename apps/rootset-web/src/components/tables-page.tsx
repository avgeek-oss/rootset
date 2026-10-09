"use client";

// Adapted from Mill's boards page and shared widget layout (Apache-2.0).
import Link from "next/link";
import { Skeleton } from "@heroui/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, TableIcon } from "@hugeicons/core-free-icons";
import type { Table } from "@rootset/contracts";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { AppShell } from "@avgeek-oss/design-system";
import { dataHref } from "./settings/navigation";

export function TablesPage({
  databaseId,
  tables,
  pending,
  error,
  canCreate,
  onCreate,
  onRetry,
}: {
  databaseId: string;
  tables: Table[];
  pending: boolean;
  error: string;
  canCreate: boolean;
  onCreate: () => void;
  onRetry: () => void;
}) {
  return (
    <AppShell.Content className="pt-0 sm:pt-0" variant="broad">
      <section className="grid min-w-0" aria-busy={pending}>
        <div className="py-5">
          <header className="flex flex-nowrap items-center gap-2">
            <h1 className="inline-flex min-w-0 items-center gap-2 text-xl font-medium">
              <HugeiconsIcon icon={TableIcon} size={20} aria-hidden />
              Tables
            </h1>
            {canCreate && (
              <Button
                aria-label="Create table"
                variant="ghost"
                isIconOnly
                className="size-8 text-muted"
                onPress={onCreate}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} aria-hidden />
              </Button>
            )}
          </header>
        </div>
        {error && (
          <div className="grid justify-items-start gap-2">
            <p className="error-message" role="alert">
              {error}
            </p>
            <Button variant="secondary" isDisabled={pending} onPress={onRetry}>
              Retry loading tables
            </Button>
          </div>
        )}
        {tables.length ? (
          <ul
            aria-label="Tables"
            className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          >
            {tables.map((table) => (
              <li key={table.id} className="min-w-0">
                <Link
                  href={dataHref(databaseId, table.id)}
                  aria-label={table.name}
                  className="block h-full w-full min-w-0 rounded-2xl no-underline outline-none transition-colors hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <div className="widget h-full">
                    <div className="widget__content flex flex-col gap-5">
                      <h2 className="min-w-0 break-words text-base font-medium">
                        {table.name}
                      </h2>
                      <dl className="mt-auto grid gap-1">
                        <dt className="text-xs text-muted">Rows</dt>
                        <dd className="text-lg font-medium tabular-nums text-foreground">
                          {table.rowCount.toLocaleString()}
                        </dd>
                      </dl>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : pending ? (
          <div
            aria-label="Loading tables"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : !error ? (
          <div className="empty-state">
            <HugeiconsIcon icon={TableIcon} size={32} aria-hidden />
            <h2>No tables yet</h2>
            <p>
              {canCreate
                ? "Create a table to start organising your data."
                : "Ask an administrator to create a table."}
            </p>
            {canCreate && (
              <Button onPress={onCreate}>Create your first table</Button>
            )}
          </div>
        ) : null}
      </section>
    </AppShell.Content>
  );
}
