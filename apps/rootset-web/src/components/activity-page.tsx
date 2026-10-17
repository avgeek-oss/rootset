"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Input, Label, TextField } from "@heroui/react";
import {
  ApplicationPage,
  AppShell,
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  RefreshIcon,
  Search01Icon,
  TransactionHistoryIcon,
} from "@hugeicons/core-free-icons";
import { client } from "@rootset/web-client";
import type {
  ActivityCategory,
  ActivityEvent,
  ActivityPage as ActivityResult,
} from "@rootset/contracts";
import {
  RelativeTime,
  RelativeTimeProvider,
} from "./settings/account/last-synced-time";
import { PageSelectionTitle } from "./settings/account/page-selection-title";
import { Choice } from "./settings/ui";
import { dataHref, settingsHref } from "./settings/navigation";
import type { SettingsPanelProps } from "./settings/types";
import { statusColor, statusLabel } from "./settings/status";

const categoryLabels: Record<ActivityCategory, string> = {
  records: "Records",
  schema: "Schema",
  imports: "Imports",
  exports: "Exports",
  backups: "Backups",
  restores: "Restores",
};
export function activityHref(event: ActivityEvent): string | null {
  if (
    !event.destination ||
    event.database?.state !== "active" ||
    (event.table && event.table.state !== "active")
  )
    return null;
  const context = { databaseId: event.database.id, tableId: event.table?.id };
  switch (event.destination) {
    case "record":
      return event.table && event.rowId
        ? `${dataHref(context.databaseId, context.tableId)}?row=${encodeURIComponent(event.rowId)}`
        : null;
    case "table":
      return event.table ? dataHref(context.databaseId, context.tableId) : null;
    case "database":
      return dataHref(context.databaseId);
    case "imports":
    case "exports":
      return event.table ? settingsHref(event.destination, context) : null;
    default:
      return settingsHref(event.destination, context);
  }
}

export function ActivitySettings(props: SettingsPanelProps) {
  return (
    <ActivityContents
      orgId={props.orgId}
      databaseId={props.databaseId}
      tableId={props.section === "table-activity" ? props.tableId : undefined}
      embedded
    />
  );
}
export function ActivityPage({ orgId }: { orgId: string }) {
  return (
    <AppShell.Content variant="broad" className="pt-0 sm:pt-0">
      <ApplicationPage
        title="Activity"
        breadcrumbAncestors={[{ label: "Rootset", href: "/" }]}
        titleContent={
          <span className="inline-flex items-center gap-2">
            <HugeiconsIcon
              icon={TransactionHistoryIcon}
              size={24}
              className="shrink-0"
              aria-hidden
            />
            Activity
          </span>
        }
      >
        <RelativeTimeProvider>
          <ActivityContents orgId={orgId} />
        </RelativeTimeProvider>
      </ApplicationPage>
    </AppShell.Content>
  );
}

function ActivityContents({
  orgId,
  databaseId,
  tableId,
  embedded = false,
}: {
  orgId: string;
  databaseId?: string;
  tableId?: string;
  embedded?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [window, setWindow] = useState("all");
  const [revision, setRevision] = useState(0);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const from = useMemo(
    () =>
      window === "all"
        ? undefined
        : new Date(Date.now() - Number(window) * 86400000).toISOString(),
    [window, revision],
  );
  const input = {
    orgId,
    ...(databaseId ? { databaseId } : {}),
    ...(tableId ? { tableId } : {}),
    ...(search ? { q: search } : {}),
    ...(category === "all" ? {} : { category }),
    ...(from ? { from } : {}),
    limit: 25,
    cursor: cursors[page],
  };
  const activity = useQuery({
    queryKey: ["activity", input, revision],
    queryFn: ({ signal }) =>
      client.operation<ActivityResult>("listActivity", input, { signal }),
    retry: false,
    gcTime: 0,
  });
  function reset() {
    setCursors([null]);
    setPage(0);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draft.trim());
    reset();
    setRevision((value) => value + 1);
  }
  function refresh() {
    reset();
    setRevision((value) => value + 1);
  }
  const categories = activity.data?.availableCategories ?? [];
  const data = activity.data?.data ?? [];
  return (
    <div className="grid min-w-0 gap-5">
      {embedded && <PageSelectionTitle label="Activity" />}
      <p className="text-sm text-muted">
        Record changes, schema changes and background requests you can access.
        Search by activity, person, resource or import file.
      </p>
      <form
        onSubmit={submit}
        role="search"
        aria-label="Activity search"
        className="flex min-w-0 flex-wrap items-end gap-3"
      >
        <TextField
          className="min-w-0 flex-1 basis-60"
          value={draft}
          onChange={setDraft}
        >
          <Label>Search activity</Label>
          <Input
            variant={embedded ? "secondary" : "primary"}
            className="text-base"
            maxLength={200}
            placeholder="Activity, person or resource"
          />
        </TextField>
        <Button type="submit" variant="secondary">
          <HugeiconsIcon icon={Search01Icon} size={16} aria-hidden />
          Search
        </Button>
        <div className="min-w-40 flex-1 basis-40">
          <Choice
            label="Type"
            value={category}
            onChange={(value) => {
              setCategory(value);
              reset();
            }}
            options={[
              { value: "all", label: "All activity" },
              ...categories.map((value) => ({
                value,
                label: categoryLabels[value],
              })),
            ]}
          />
        </div>
        <div className="min-w-40 flex-1 basis-40">
          <Choice
            label="When"
            value={window}
            onChange={(value) => {
              setWindow(value);
              reset();
            }}
            options={[
              { value: "all", label: "Any time" },
              { value: "1", label: "Past 24 hours" },
              { value: "7", label: "Past 7 days" },
              { value: "30", label: "Past 30 days" },
            ]}
          />
        </div>
        <Button
          variant="secondary"
          onPress={refresh}
          isDisabled={activity.isFetching}
        >
          <HugeiconsIcon icon={RefreshIcon} size={16} aria-hidden />
          Refresh
        </Button>
      </form>
      {activity.isError ? (
        <QueryError
          message={activity.error.message}
          onRetry={() => void activity.refetch()}
        />
      ) : activity.isFetching ? (
        <QueryLoading />
      ) : (
        <>
          <ResourceTable
            ariaLabel="Activity"
            items={data}
            getRowKey={(event) => event.id}
            tableClassName="min-w-4xl"
            emptyTitle={
              search || category !== "all" || window !== "all"
                ? "No matching activity"
                : "No activity yet"
            }
            emptyDescription={
              search || category !== "all" || window !== "all"
                ? "Try a different search or filter."
                : "Changes and background requests will appear here."
            }
            columns={[
              {
                key: "when",
                header: "When",
                cell: (event) => (
                  <RelativeTime label="Occurred" value={event.occurredAt} />
                ),
              },
              {
                key: "activity",
                header: "Activity",
                cell: (event) => (
                  <div className="grid gap-1">
                    <span>{event.summary}</span>
                    <span className="text-xs text-muted">
                      {event.affectedRows !== null
                        ? `${event.affectedRows.toLocaleString()} ${event.affectedRows === 1 ? "record" : "records"}`
                        : categoryLabels[event.category]}
                    </span>
                    {event.fileName && (
                      <span className="max-w-64 break-words text-xs text-muted">
                        {event.fileName}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                key: "status",
                header: "Status",
                cell: (event) => (
                  <Chip
                    color={
                      event.status === "resolved"
                        ? "success"
                        : event.status === "requested"
                          ? "default"
                          : statusColor(event.status)
                    }
                  >
                    <Chip.Label>
                      {event.status === "requested"
                        ? "Requested"
                        : event.status === "resolved"
                          ? "Resolved"
                          : statusLabel(event.status)}
                    </Chip.Label>
                  </Chip>
                ),
              },
              { key: "actor", header: "By", cell: (event) => event.actor.name },
              {
                key: "resource",
                header: "Resource",
                cell: (event) => {
                  const href = activityHref(event);
                  const label =
                    event.table?.name ??
                    event.database?.name ??
                    "Unavailable resource";
                  return (
                    <div className="grid gap-1">
                      {href ? (
                        <Link
                          href={href}
                          className="inline-flex w-fit items-center gap-1 text-accent underline-offset-4 hover:underline"
                          aria-label={`Open ${label}${event.rowId ? " record" : ""}`}
                        >
                          <span>{label}</span>
                          <HugeiconsIcon
                            icon={ArrowUpRight01Icon}
                            size={16}
                            className="shrink-0"
                            aria-hidden
                          />
                        </Link>
                      ) : (
                        <span>{label}</span>
                      )}
                      {event.table && event.database && (
                        <span className="text-xs text-muted">
                          {event.database.name}
                        </span>
                      )}
                      {(event.database?.state === "deleted" ||
                        event.table?.state === "deleted") && (
                        <span className="text-xs text-muted">Deleted</span>
                      )}
                    </div>
                  );
                },
              },
            ]}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-sm text-muted">
              Page {page + 1} · {data.length}{" "}
              {data.length === 1 ? "event" : "events"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                isDisabled={page === 0}
                onPress={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                isDisabled={!activity.data?.hasMore}
                onPress={() => {
                  const cursor = activity.data?.nextCursor;
                  if (!cursor) return;
                  setCursors((values) => [
                    ...(page === 0
                      ? [activity.data!.startCursor]
                      : values.slice(0, page + 1)),
                    cursor,
                  ]);
                  setPage((value) => value + 1);
                }}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
