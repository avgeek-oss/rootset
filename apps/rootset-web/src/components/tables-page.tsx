"use client";

// Adapted from Mill's boards page and shared widget layout (Apache-2.0).
import Link from "next/link";
import { RootsetEmptyState } from "./rootset-empty-state";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  HardDriveIcon,
  RowsThreeIcon,
  TableIcon,
  TablePropertiesIcon,
} from "@hugeicons/core-free-icons";
import type { TableSummary } from "@rootset/contracts";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import {
  ResourceName,
  ResourceTable,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { AppShell, ContentPage } from "@avgeek-oss/design-system";
import { formatStorageBytes } from "../lib/format-storage";
import { dataHref } from "./settings/navigation";
import { Plus, RefreshCw } from "./ui/icons";
import { ResourceViewToggle, useResourceView } from "./resource-view-toggle";
import {
  RelativeTime,
  RelativeTimeProvider,
} from "./settings/account/last-synced-time";

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
  const [view, setView] = useResourceView();
  return (
    <RelativeTimeProvider>
      <AppShell.Content
        className="@container/resources pt-0 sm:pt-0"
        variant="broad"
      >
        <ContentPage
          title="Tables"
          breadcrumbAncestors={[]}
          aria-busy={pending}
          titleContent={
            <span className="inline-flex min-w-0 items-center gap-2">
              <HugeiconsIcon
                icon={TableIcon}
                size={19}
                className="shrink-0"
                aria-hidden
              />
              Tables
            </span>
          }
          actions={
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <ResourceViewToggle
                label="Tables"
                value={view}
                onChange={setView}
              />
              {canCreate && (
                <Button className="shrink-0" onPress={onCreate}>
                  <Plus />
                  Create table
                </Button>
              )}
            </div>
          }
        >
          {error && (
            <div className="grid justify-items-start gap-2">
              <p className="error-message" role="alert">
                {error}
              </p>
              <Button
                variant="secondary"
                isDisabled={pending}
                onPress={onRetry}
              >
                <RefreshCw />
                Retry loading tables
              </Button>
            </div>
          )}
          {tables.length && view === "table" ? (
            <ResourceTable
              ariaLabel="Tables"
              items={tables}
              getRowKey={(table) => table.id}
              getRowHref={(table) => dataHref(databaseId, table.id)}
              tableClassName="min-w-2xl"
              columns={[
                {
                  key: "name",
                  header: "Name",
                  className: "min-w-56 max-w-sm [&_a]:max-w-full",
                  cell: (table) => (
                    <ResourceName
                      name={table.name}
                      description={table.description?.trim() || undefined}
                    />
                  ),
                },
                {
                  key: "fields",
                  header: "Fields",
                  cell: (table) => (
                    <span className="whitespace-nowrap tabular-nums">
                      {table.fieldCount.toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "rows",
                  header: "Rows",
                  cell: (table) => (
                    <span className="whitespace-nowrap tabular-nums">
                      {table.rowCount.toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "size",
                  header: "Size",
                  cell: (table) => (
                    <span className="whitespace-nowrap tabular-nums">
                      {formatStorageBytes(table.storageBytes)}
                    </span>
                  ),
                },
                {
                  key: "last-data-change",
                  header: "Last data change",
                  cell: (table) => (
                    <RelativeTime
                      label="Last data change"
                      value={table.lastDataChangeAt ?? table.createdAt}
                    />
                  ),
                },
              ]}
              emptyTitle="No tables yet"
              emptyDescription="Create a table to start organising your data."
            />
          ) : tables.length ? (
            <ul
              aria-label="Tables"
              className="grid min-w-0 grid-cols-1 gap-4 @min-[40rem]/resources:grid-cols-2 @min-[62rem]/resources:grid-cols-3"
            >
              {tables.map((table) => (
                <li key={table.id} className="min-w-0">
                  <Link
                    href={dataHref(databaseId, table.id)}
                    aria-label={table.name}
                    className="resource-card block h-full w-full min-w-0 rounded-2xl no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Widget className="h-full">
                      <Widget.Content className="flex flex-col gap-5">
                        <div className="min-w-0">
                          <h2 className="break-words text-base font-medium">
                            {table.name}
                          </h2>
                          {table.description?.trim() && (
                            <p className="mt-1 line-clamp-2 break-words text-xs text-muted">
                              {table.description}
                            </p>
                          )}
                        </div>
                        <dl className="mt-auto grid grid-cols-3 gap-x-4">
                          <div className="grid gap-1">
                            <dt className="text-xs text-muted">Fields</dt>
                            <dd className="flex items-center gap-2 text-sm font-medium tabular-nums">
                              <HugeiconsIcon
                                icon={TablePropertiesIcon}
                                size={14}
                                className="shrink-0 text-muted"
                                aria-hidden
                              />
                              {table.fieldCount.toLocaleString()}
                            </dd>
                          </div>
                          <div className="grid gap-1">
                            <dt className="text-xs text-muted">Rows</dt>
                            <dd className="flex items-center gap-2 text-sm font-medium tabular-nums text-foreground">
                              <HugeiconsIcon
                                icon={RowsThreeIcon}
                                size={14}
                                className="shrink-0 text-muted"
                                aria-hidden
                              />
                              {table.rowCount.toLocaleString()}
                            </dd>
                          </div>
                          <div className="grid gap-1">
                            <dt className="text-xs text-muted">Size</dt>
                            <dd className="flex items-center gap-2 text-sm font-medium tabular-nums">
                              <HugeiconsIcon
                                icon={HardDriveIcon}
                                size={14}
                                className="shrink-0 text-muted"
                                aria-hidden
                              />
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
            <RootsetEmptyState
              title="No tables yet"
              description={
                canCreate
                  ? "Create a table to start organising your data."
                  : "Ask an administrator to create a table."
              }
            >
              {canCreate && (
                <Button onPress={onCreate}>
                  <Plus />
                  Create your first table
                </Button>
              )}
            </RootsetEmptyState>
          ) : null}
        </ContentPage>
      </AppShell.Content>
    </RelativeTimeProvider>
  );
}
