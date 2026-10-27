"use client";

import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import {
  ResourceName,
  ResourceTable,
} from "@avgeek-oss/design-system/patterns/resource-table";
import Link from "next/link";
import { RootsetEmptyState } from "./rootset-empty-state";
import type { DatabaseSummary } from "@rootset/contracts";
import {
  ApplicationPage,
  AppShell,
  Button,
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  DatabaseIcon,
  HardDriveIcon,
  RowsThreeIcon,
  TableIcon,
} from "@hugeicons/core-free-icons";
import { formatStorageBytes } from "../lib/format-storage";
import { dataHref } from "./settings/navigation";
import { Plus } from "./ui/icons";
import { ResourceViewToggle, useResourceView } from "./resource-view-toggle";
import {
  RelativeTime,
  RelativeTimeProvider,
} from "./settings/account/last-synced-time";

export function DatabasesPage({
  databases,
  pending,
  error,
  canCreate,
  onCreate,
  onRetry,
}: {
  databases: DatabaseSummary[];
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
        variant="broad"
        className="@container/resources pt-0 sm:pt-0"
      >
        <ApplicationPage
          breadcrumbAncestors={[{ label: "Rootset", href: "/" }]}
          title="Databases"
          titleContent={
            <span className="inline-flex items-center gap-2">
              <HugeiconsIcon
                icon={DatabaseIcon}
                size={19}
                className="shrink-0"
                aria-hidden
              />
              Databases
            </span>
          }
          actions={
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <ResourceViewToggle
                label="Databases"
                value={view}
                onChange={setView}
              />
              {canCreate && (
                <Button onPress={onCreate}>
                  <HugeiconsIcon icon={Add01Icon} size={16} aria-hidden />
                  Create database
                </Button>
              )}
            </div>
          }
        >
          {error ? (
            <QueryError message={error} onRetry={onRetry} />
          ) : pending ? (
            <QueryLoading />
          ) : databases.length && view === "table" ? (
            <ResourceTable
              ariaLabel="Databases"
              items={databases}
              getRowKey={(database) => database.id}
              getRowHref={(database) => dataHref(database.id)}
              tableClassName="min-w-2xl"
              columns={[
                {
                  key: "name",
                  header: "Name",
                  className: "min-w-56 max-w-sm [&_a]:max-w-full",
                  cell: (database) => (
                    <ResourceName
                      name={database.name}
                      description={database.description?.trim() || undefined}
                    />
                  ),
                },
                {
                  key: "tables",
                  header: "Tables",
                  cell: (database) => (
                    <span className="whitespace-nowrap tabular-nums">
                      {database.tableCount.toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "rows",
                  header: "Total rows",
                  cell: (database) => (
                    <span className="whitespace-nowrap tabular-nums">
                      {database.rowCount.toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "size",
                  header: "Size",
                  cell: (database) => (
                    <span className="whitespace-nowrap tabular-nums">
                      {formatStorageBytes(database.storageBytes)}
                    </span>
                  ),
                },
                {
                  key: "last-data-change",
                  header: "Last data change",
                  cell: (database) => (
                    <RelativeTime
                      label="Last data change"
                      value={database.lastDataChangeAt ?? database.createdAt}
                    />
                  ),
                },
              ]}
              emptyTitle="No databases yet"
              emptyDescription="Create a database to organise your data."
            />
          ) : databases.length ? (
            <ul
              aria-label="Databases"
              className="grid min-w-0 grid-cols-1 gap-4 @min-[40rem]/resources:grid-cols-2 @min-[62rem]/resources:grid-cols-3"
            >
              {databases.map((database) => (
                <li key={database.id} className="min-w-0">
                  <Link
                    href={dataHref(database.id)}
                    className="resource-card block h-full min-w-0 rounded-2xl no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <Widget className="h-full">
                      <Widget.Content className="flex flex-col gap-5">
                        <div className="min-w-0">
                          <h2 className="break-words text-base font-medium">
                            {database.name}
                          </h2>
                          {database.description?.trim() && (
                            <p className="mt-1 line-clamp-2 break-words text-xs text-muted">
                              {database.description}
                            </p>
                          )}
                        </div>
                        <dl className="mt-auto grid grid-cols-3 gap-x-4">
                          <div className="grid gap-1">
                            <dt className="text-xs text-muted">Tables</dt>
                            <dd className="flex items-center gap-2 text-sm font-medium tabular-nums">
                              <HugeiconsIcon
                                icon={TableIcon}
                                size={14}
                                className="shrink-0 text-muted"
                                aria-hidden
                              />
                              {database.tableCount.toLocaleString()}
                            </dd>
                          </div>
                          <div className="grid gap-1">
                            <dt className="text-xs text-muted">Total rows</dt>
                            <dd className="flex items-center gap-2 text-sm font-medium tabular-nums">
                              <HugeiconsIcon
                                icon={RowsThreeIcon}
                                size={14}
                                className="shrink-0 text-muted"
                                aria-hidden
                              />
                              {database.rowCount.toLocaleString()}
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
                              {formatStorageBytes(database.storageBytes)}
                            </dd>
                          </div>
                        </dl>
                      </Widget.Content>
                    </Widget>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <RootsetEmptyState
              title="No databases yet"
              description={
                canCreate
                  ? "Create a database to organise your data."
                  : "Ask an administrator to create a database."
              }
            >
              {canCreate ? (
                <Button onPress={onCreate}>
                  <Plus />
                  Create database
                </Button>
              ) : null}
            </RootsetEmptyState>
          )}
        </ApplicationPage>
      </AppShell.Content>
    </RelativeTimeProvider>
  );
}
