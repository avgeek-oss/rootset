"use client";

import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import Link from "next/link";
import type { DatabaseSummary } from "@rootset/contracts";
import {
  ApplicationPage,
  AppShell,
  Button,
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, DatabaseIcon, TableIcon } from "@hugeicons/core-free-icons";
import { formatStorageBytes } from "../lib/format-storage";
import { dataHref } from "./settings/navigation";

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
  return (
    <AppShell.Content variant="broad" className="pt-0 sm:pt-0">
      <ApplicationPage
        breadcrumbAncestors={[{ label: "Rootset", href: "/" }]}
        title="Databases"
        titleContent={
          <span className="inline-flex items-center gap-2">
            <HugeiconsIcon icon={DatabaseIcon} size={24} aria-hidden />
            Databases
          </span>
        }
        actions={
          canCreate ? (
            <Button onPress={onCreate}>
              <HugeiconsIcon icon={Add01Icon} size={16} aria-hidden />
              Create database
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <QueryError message={error} onRetry={onRetry} />
        ) : pending ? (
          <QueryLoading />
        ) : databases.length ? (
          <ul
            aria-label="Databases"
            className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          >
            {databases.map((database) => (
              <li key={database.id} className="min-w-0">
                <Link
                  href={dataHref(database.id)}
                  className="resource-card block h-full min-w-0 rounded-2xl no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Widget className="h-full">
                    <Widget.Content className="flex flex-col gap-5">
                      <h2 className="break-words text-base font-medium">
                        {database.name}
                      </h2>
                      <dl className="mt-auto grid grid-cols-2 gap-4">
                        <div className="grid gap-1">
                          <dt className="text-xs text-muted">Tables</dt>
                          <dd className="flex items-center gap-2 text-lg font-medium tabular-nums">
                            <HugeiconsIcon
                              icon={TableIcon}
                              size={20}
                              aria-hidden
                            />
                            {database.tableCount.toLocaleString()}
                          </dd>
                        </div>
                        <div className="grid gap-1">
                          <dt className="text-xs text-muted">Size</dt>
                          <dd className="text-lg font-medium tabular-nums">
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
          <div className="empty-state">
            <HugeiconsIcon icon={DatabaseIcon} size={32} aria-hidden />
            <h2>No databases yet</h2>
            <p>
              {canCreate
                ? "Create a database to organise your data."
                : "Ask an administrator to create a database."}
            </p>
            {canCreate ? (
              <Button onPress={onCreate}>Create database</Button>
            ) : null}
          </div>
        )}
      </ApplicationPage>
    </AppShell.Content>
  );
}
