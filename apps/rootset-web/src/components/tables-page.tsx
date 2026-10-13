"use client";

// Adapted from Mill's boards page and shared widget layout (Apache-2.0).
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { TableIcon } from "@hugeicons/core-free-icons";
import type { TableSummary } from "@rootset/contracts";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { AppShell } from "@avgeek-oss/design-system";
import { formatStorageBytes } from "../lib/format-storage";
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
  tables: TableSummary[];
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
          <header className="flex flex-nowrap items-center justify-between gap-4">
            <h1 className="inline-flex min-w-0 items-center gap-2 text-xl font-medium">
              <HugeiconsIcon icon={TableIcon} size={20} aria-hidden />
              Tables
            </h1>
            {canCreate && (
              <Button className="shrink-0" onPress={onCreate}>
                Create table
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
                  <Widget className="h-full">
                    <Widget.Content className="flex flex-col gap-5">
                      <h2 className="min-w-0 break-words text-base font-medium">
                        {table.name}
                      </h2>
                      <dl className="mt-auto grid grid-cols-2 gap-4">
                        <div className="grid gap-1">
                          <dt className="text-xs text-muted">Rows</dt>
                          <dd className="text-lg font-medium tabular-nums text-foreground">
                            {table.rowCount.toLocaleString()}
                          </dd>
                        </div>
                        <div className="grid gap-1">
                          <dt className="text-xs text-muted">Size</dt>
                          <dd className="text-lg font-medium tabular-nums">
                            {formatStorageBytes(table.storageBytes)}
                          </dd>
                        </div>
                      </dl>
                    </Widget.Content>
                  </Widget>
                </Link>
              </li>
            ))}
          </ul>
        ) : !pending && !error ? (
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
