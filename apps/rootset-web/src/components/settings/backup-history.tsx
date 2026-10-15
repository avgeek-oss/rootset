"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createDateTimeFormatter,
  type DatabaseBackup,
} from "@rootset/contracts";
import { formatStorageBytes } from "../../lib/format-storage";
import {
  databasePath,
  performAction,
  readRaw,
  useMutation,
  useResource,
} from "./api";
import { RelativeTime } from "./account/last-synced-time";
import { PageSelectionTitle } from "./account/page-selection-title";
import { statusColor, statusIcon, statusLabel } from "./status";
import { Empty, Loading } from "./ui";
import type { SettingsPanelProps } from "./types";

interface BackupPage {
  data: DatabaseBackup[];
  nextCursor: string | null;
}
const EMPTY_PAGE: BackupPage = { data: [], nextCursor: null };
const loadHistory = (path: string, signal?: AbortSignal) =>
  readRaw<BackupPage>(path, signal);
const isActive = (state: string) => state === "queued" || state === "running";

export function BackupHistorySettings(props: SettingsPanelProps) {
  const path = props.databaseId
    ? databasePath(props.orgId, props.databaseId)
    : undefined;
  const [cursors, setCursors] = useState<string[]>([""]);
  const [page, setPage] = useState(0);
  const history = useResource<BackupPage>(
    path
      ? `${path}/backups?limit=25${cursors[page] ? `&cursor=${encodeURIComponent(cursors[page]!)}` : ""}`
      : undefined,
    EMPTY_PAGE,
    loadHistory,
  );
  const mutation = useMutation();
  const format = useMemo(
    () =>
      createDateTimeFormatter({
        dateFormat: props.preferences?.dateFormat ?? "year-month-day",
        timeFormat: props.preferences?.timeFormat ?? "24-hour",
        timeZone: props.preferences?.timezone ?? "UTC",
      }),
    [props.preferences],
  );
  const hasActiveRun = history.data.data.some((run) => isActive(run.state));
  useEffect(() => {
    if (!path || page !== 0) return;
    const timer = setInterval(history.reload, hasActiveRun ? 2000 : 10000);
    return () => clearInterval(timer);
  }, [path, page, history.reload, hasActiveRun]);
  if (!path) return <Empty>Select a database to view backup history.</Empty>;
  return (
    <>
      <PageSelectionTitle label="Backup History" />
      <Loading {...history} retry={history.reload} />
      <div className="grid min-w-0 gap-4">
        <ResourceTable
          ariaLabel="Database backups"
          items={history.data.data}
          getRowKey={(run) => run.id}
          tableClassName="min-w-5xl"
          emptyTitle="No backups yet"
          emptyDescription="Test a destination, then save a schedule or start a backup."
          columns={[
            {
              key: "scheduled",
              header: "Scheduled",
              cell: (run) => (
                <RelativeTime label="Scheduled" value={run.scheduledAt} />
              ),
            },
            {
              key: "kind",
              header: "Type",
              cell: (run) => (
                <Chip>
                  <Chip.Label>
                    {run.trigger === "manual" ? "Manual" : "Scheduled"}
                  </Chip.Label>
                </Chip>
              ),
            },
            {
              key: "state",
              header: "Status",
              cell: (run) => (
                <div className="grid gap-1">
                  <Chip color={statusColor(run.state)}>
                    <HugeiconsIcon
                      aria-hidden="true"
                      size={14}
                      icon={statusIcon(run.state)}
                    />
                    <Chip.Label>
                      {run.stage === "retry_wait"
                        ? "Retrying"
                        : statusLabel(run.state)}
                    </Chip.Label>
                  </Chip>
                  {run.state === "running" && (
                    <span className="text-xs text-muted">
                      {statusLabel(run.stage)}
                    </span>
                  )}
                </div>
              ),
            },
            {
              key: "snapshot",
              header: "Snapshot",
              cell: (run) =>
                run.snapshotAt ? (
                  <RelativeTime label="Snapshot" value={run.snapshotAt} />
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            {
              key: "duration",
              header: "Duration",
              cell: (run) =>
                run.startedAt && run.completedAt ? (
                  <span className="tabular-nums">
                    {Math.max(
                      1,
                      Math.round(
                        (Date.parse(run.completedAt) -
                          Date.parse(run.startedAt)) /
                          1000,
                      ),
                    ).toLocaleString()}{" "}
                    s
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
            {
              key: "size",
              header: "Size",
              cell: (run) =>
                run.sizeBytes === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span className="whitespace-nowrap tabular-nums">
                    {formatStorageBytes(run.sizeBytes)}
                  </span>
                ),
            },
            {
              key: "tables",
              header: "Tables",
              cell: (run) => (
                <span className="tabular-nums">
                  {run.tableCount?.toLocaleString() ?? "—"}
                </span>
              ),
            },
            {
              key: "rows",
              header: "Rows",
              cell: (run) => (
                <span className="tabular-nums">
                  {run.rowCount?.toLocaleString() ?? "—"}
                </span>
              ),
            },
            {
              key: "details",
              header: "Details",
              cell: (run) => (
                <span className="block max-w-md break-words">
                  {run.error ??
                    run.note ??
                    (run.objectKey
                      ? `s3://${run.bucket}/${run.objectKey}`
                      : run.kind === "destination_test"
                        ? "Destination test"
                        : "—")}
                  {run.skippedUntil && (
                    <span className="block text-muted">
                      Through {format(run.skippedUntil).dateTime}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "actions",
              header: "Actions",
              headerClassName: "text-right",
              cell: (run) =>
                run.jobId && isActive(run.state) ? (
                  <Button
                    variant="secondary"
                    isDisabled={mutation.busy}
                    onPress={async () => {
                      const result = await mutation.run(
                        () =>
                          performAction("cancelJob", {
                            orgId: props.orgId,
                            id: run.jobId,
                          }),
                        "Cancellation requested.",
                      );
                      if (result.ok) history.reload();
                    }}
                  >
                    Cancel
                  </Button>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
          ]}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            isDisabled={page === 0 || history.loading}
            onPress={() => setPage((value) => value - 1)}
          >
            Newer
          </Button>
          <Button
            variant="secondary"
            isDisabled={!history.data.nextCursor || history.loading}
            onPress={() => {
              setCursors((values) => [
                ...values.slice(0, page + 1),
                history.data.nextCursor!,
              ]);
              setPage((value) => value + 1);
            }}
          >
            Older
          </Button>
        </div>
      </div>
    </>
  );
}
