"use client";

import { usePageQuery } from "./page-navigation";
import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ApplicationPage,
  AppShell,
  QueryLoading,
} from "@avgeek-oss/design-system";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar01Icon,
  Calendar03Icon,
  Calendar04Icon,
  Clock01Icon,
  ViewIcon,
  Search01Icon,
  TransactionHistoryIcon,
} from "@hugeicons/core-free-icons";
import { client, currentWorkspaceId } from "@rootset/web-client";
import { activityEventCatalog } from "@rootset/contracts";
import type {
  ActivityCategory,
  ActivityEvent,
  ActivityPage as ActivityResult,
} from "@rootset/contracts";
import {
  RelativeTime,
  RelativeTimeProvider,
} from "./settings/account/last-synced-time";
import { Choice } from "./settings/ui";
import { AuditLogFilter, type AuditFilterValue } from "./audit-log-filter";
import { AuditActorIcon } from "./audit-actor-icon";
import { AuditEventIcon } from "./audit-event-icon";
import { AuditLogError } from "./audit-log-error";
import { dataHref, settingsHref } from "./settings/navigation";
import { ChevronLeft, ChevronRight } from "./ui/icons";
import { AuditEventDetails } from "./audit-event-details";

const categoryLabels: Record<ActivityCategory, string> = {
  records: "Records",
  schema: "Schema",
  imports: "Imports",
  exports: "Exports",
  backups: "Backups",
  restores: "Restores",
};
const timeOptions = [
  { value: "all", label: "Any time", icon: Clock01Icon },
  { value: "1", label: "Past 24 hours", icon: Calendar01Icon },
  { value: "7", label: "Past 7 days", icon: Calendar03Icon },
  { value: "30", label: "Past 30 days", icon: Calendar04Icon },
];
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
    case "backup-history":
      return settingsHref(
        event.category === "restores" ? "restore-requests" : "backup-history",
        context,
      );
    default:
      return settingsHref(event.destination, context);
  }
}

export function AuditLogsPage({
  orgId,
  workspaceId = currentWorkspaceId(),
}: {
  orgId: string;
  workspaceId?: string;
}) {
  return (
    <AppShell.Content variant="broad" className="pt-0 sm:pt-0">
      <ApplicationPage
        title="Audit Logs"
        breadcrumbAncestors={[
          {
            label: "Workspace Settings",
            href:
              workspaceId === orgId
                ? "/workspace-settings/api-keys"
                : "/workspace-settings/general",
          },
        ]}
        titleContent={
          <span className="inline-flex items-center gap-2">
            <HugeiconsIcon
              icon={TransactionHistoryIcon}
              size={24}
              className="shrink-0"
              aria-hidden
            />
            Audit Logs
          </span>
        }
      >
        <RelativeTimeProvider>
          <AuditLogsContents
            key={workspaceId}
            orgId={orgId}
            workspaceId={workspaceId}
          />
        </RelativeTimeProvider>
      </ApplicationPage>
    </AppShell.Content>
  );
}

function AuditLogsContents({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId?: string;
}) {
  const [event, setEvent] = useState<AuditFilterValue | null>(null);
  const [actor, setActor] = useState<AuditFilterValue | null>(null);
  const [resource, setResource] = useState<AuditFilterValue | null>(null);
  const [window, setWindow] = useState("all");
  const [revision, setRevision] = useState(0);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const [detailsEventId, setDetailsEventId] = useState<string | null>(null);
  const from = useMemo(
    () =>
      window === "all"
        ? undefined
        : new Date(Date.now() - Number(window) * 86400000).toISOString(),
    [window, revision],
  );
  const input = {
    orgId,
    workspaceId,
    ...(event ? { event: event.value } : {}),
    ...(actor ? { actor: actor.value } : {}),
    ...(resource ? { resource: resource.value } : {}),
    ...(from ? { from } : {}),
    limit: 25,
    cursor: cursors[page],
  };
  const activity = usePageQuery({
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
    reset();
    setRevision((value) => value + 1);
  }
  const categories = activity.data?.availableCategories;
  const filtered = event || actor || resource || window !== "all";
  const data = activity.data?.data ?? [];
  return (
    <div className="grid min-w-0 gap-5">
      <form
        onSubmit={submit}
        role="search"
        aria-label="Audit log search"
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
      >
        <div className="col-start-1 min-w-0 lg:col-start-auto">
          <AuditLogFilter
            orgId={orgId}
            workspaceId={workspaceId}
            kind="events"
            value={event}
            categories={categories}
            onChange={(value) => {
              setEvent(value);
              reset();
            }}
          />
        </div>
        <div className="col-start-1 min-w-0 lg:col-start-auto">
          <AuditLogFilter
            orgId={orgId}
            workspaceId={workspaceId}
            kind="resources"
            value={resource}
            onChange={(value) => {
              setResource(value);
              reset();
            }}
          />
        </div>
        <div className="col-start-1 min-w-0 lg:col-start-auto">
          <AuditLogFilter
            orgId={orgId}
            workspaceId={workspaceId}
            kind="actors"
            value={actor}
            onChange={(value) => {
              setActor(value);
              reset();
            }}
          />
        </div>
        <div className="col-start-1 min-w-0 lg:col-start-auto">
          <Choice
            label="When"
            hideLabel
            value={window}
            onChange={(value) => {
              setWindow(value);
              reset();
            }}
            options={timeOptions.map(({ value, label, icon }) => ({
              value,
              label,
              icon: (
                <HugeiconsIcon
                  icon={icon}
                  size={16}
                  className="shrink-0"
                  aria-hidden
                />
              ),
            }))}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          className="col-start-2 row-start-4 size-9 shrink-0 rounded-field lg:col-start-auto lg:row-start-auto"
          isIconOnly
          aria-label="Search audit logs"
          isDisabled={activity.isFetching}
        >
          <HugeiconsIcon icon={Search01Icon} size={16} aria-hidden />
        </Button>
      </form>
      {activity.isError ? (
        <AuditLogError
          error={activity.error}
          message="Audit logs could not be loaded."
          onRetry={() => void activity.refetch()}
        />
      ) : activity.isPending ? (
        <QueryLoading />
      ) : (
        <>
          <ResourceTable
            ariaLabel="Audit logs"
            items={data}
            getRowKey={(event) => event.id}
            tableClassName="min-w-4xl"
            emptyTitle={
              filtered ? "No matching audit logs" : "No audit logs yet"
            }
            emptyDescription={
              filtered
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
                header: "Event",
                cell: (event) => (
                  <div className="flex min-w-48 items-start gap-2">
                    <span className="mt-0.5">
                      <AuditEventIcon
                        icon={activityEventCatalog[event.event]!.icon}
                      />
                    </span>
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
                  </div>
                ),
              },
              {
                key: "resource",
                header: "Resource",
                cell: (event) => {
                  const href = activityHref(event);
                  const label =
                    event.table?.name ??
                    event.database?.name ??
                    "Unavailable resource";
                  const resourceType = event.table
                    ? "Table"
                    : event.database
                      ? "Database"
                      : null;
                  return (
                    <div className="grid gap-1">
                      {href ? (
                        <Link
                          href={href}
                          className="w-fit text-accent underline-offset-4 hover:underline"
                          aria-label={`Open ${label}${event.rowId ? " record" : ""}`}
                        >
                          {label}
                        </Link>
                      ) : (
                        <span>{label}</span>
                      )}
                      {resourceType && (
                        <span className="text-xs text-muted">
                          {resourceType}
                          {(event.database?.state === "deleted" ||
                            event.table?.state === "deleted") && (
                            <>
                              {" ("}
                              <em>Deleted</em>
                              {")"}
                            </>
                          )}
                        </span>
                      )}
                      {event.table?.state === "maintenance" && (
                        <span className="text-xs text-muted">
                          In maintenance
                        </span>
                      )}
                    </div>
                  );
                },
              },
              {
                key: "actor",
                header: "Actor",
                cell: (event) => (
                  <div className="flex min-w-40 items-center gap-2">
                    <AuditActorIcon
                      kind={event.actor.kind}
                      name={event.actor.name}
                      avatarUrl={event.actor.avatarUrl}
                    />
                    <span className="min-w-0 break-words">
                      {event.actor.name}
                    </span>
                  </div>
                ),
              },
              {
                key: "actions",
                header: "Actions",
                headerClassName: "text-right",
                className: "text-right",
                cell: (event) => (
                  <Button
                    variant="secondary"
                    onPress={() => setDetailsEventId(event.id)}
                    aria-label={`Details: ${event.summary}`}
                  >
                    <HugeiconsIcon icon={ViewIcon} size={16} aria-hidden />
                    Details
                  </Button>
                ),
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
                <ChevronLeft />
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
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
      {detailsEventId && (
        <AuditEventDetails
          orgId={orgId}
          workspaceId={workspaceId}
          eventId={detailsEventId}
          onClose={() => setDetailsEventId(null)}
        />
      )}
    </div>
  );
}
