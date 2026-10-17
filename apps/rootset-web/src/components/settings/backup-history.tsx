"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { HugeiconsIcon } from "@hugeicons/react";
import { TriangleAlertIcon } from "lucide-react";
import {
  createDateTimeFormatter,
  type BackupScheduleResult,
  type DatabaseBackup,
} from "@rootset/contracts";
import { RestoreBackup } from "../restore-backup";
import { formatStorageBytes } from "../../lib/format-storage";
import {
  databasePath,
  organisationPath,
  performAction,
  readRaw,
  useMutation,
  useResource,
} from "./api";
import { RelativeTime } from "./account/last-synced-time";
import { PageSelectionTitle } from "./account/page-selection-title";
import { statusColor, statusIcon, statusLabel } from "./status";
import { Empty, Loading } from "./ui";
import type { Job, SettingsPanelProps } from "./types";
import { Backup, Restore, ChevronLeft, ChevronRight, Stop } from "../ui/icons";

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
  const schedule = useResource<BackupScheduleResult | null>(
    path ? `${path}/backup-schedule` : undefined,
    null,
  );
  const latest = useResource<BackupPage>(
    path ? `${path}/backups?limit=25` : undefined,
    EMPTY_PAGE,
    loadHistory,
  );
  const older = useResource<BackupPage>(
    path && page > 0
      ? `${path}/backups?limit=25${cursors[page] ? `&cursor=${encodeURIComponent(cursors[page]!)}` : ""}`
      : undefined,
    EMPTY_PAGE,
    loadHistory,
  );
  const history = page === 0 ? latest : older;
  const [pendingJobId, setPendingJobId] = useState<string>();
  const starting = useRef(false);
  const job = useResource<Job | null>(
    pendingJobId
      ? `${organisationPath(props.orgId)}/jobs/${pendingJobId}`
      : undefined,
    null,
  );
  const [selected, setSelected] = useState<{
    backupId: string;
  } | null>(null);
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
  const hasActiveRun = latest.data.data.some((run) => isActive(run.state));
  const hasActiveBackup = latest.data.data.some(
    (run) => run.kind === "backup" && isActive(run.state),
  );
  useEffect(() => {
    if (!path) return;
    const timer = setInterval(
      latest.reload,
      hasActiveRun || pendingJobId ? 2000 : 10000,
    );
    return () => clearInterval(timer);
  }, [path, latest.reload, hasActiveRun, pendingJobId]);
  useEffect(() => {
    if (!path) return;
    const timer = setInterval(schedule.reload, 10000);
    return () => clearInterval(timer);
  }, [path, schedule.reload]);
  useEffect(() => {
    if (!pendingJobId) return;
    const timer = setInterval(job.reload, 2000);
    return () => clearInterval(timer);
  }, [pendingJobId, job.reload]);
  useEffect(() => {
    if (
      !pendingJobId ||
      job.data?.id !== pendingJobId ||
      isActive(job.data.state)
    )
      return;
    starting.current = false;
    setPendingJobId(undefined);
    latest.reload();
    schedule.reload();
    if (job.data.state === "succeeded")
      toast.success("Database backup completed.");
    else
      toast.danger(
        typeof job.data.error === "string"
          ? job.data.error
          : (job.data.error?.message ??
              "The database backup did not complete."),
      );
  }, [pendingJobId, job.data, latest.reload, schedule.reload]);
  const canStartBackup = Boolean(
    path &&
    !schedule.loading &&
    !schedule.error &&
    !latest.loading &&
    !latest.error &&
    schedule.data?.worker.available &&
    schedule.data.worker.matchesSchedule &&
    schedule.data.schedule?.testedAt &&
    !schedule.data.pendingSaveJobId &&
    !mutation.busy &&
    !hasActiveBackup &&
    !pendingJobId,
  );
  const actions = useMemo(
    () => (
      <Button
        isDisabled={!canStartBackup}
        onPress={async () => {
          if (!canStartBackup || starting.current) return;
          starting.current = true;
          const result = await mutation.run(() =>
            performAction<{ jobId: string }>("runDatabaseBackup", {
              orgId: props.orgId,
              databaseId: props.databaseId,
            }),
          );
          if (result.ok) {
            setPendingJobId(result.value.jobId);
            setCursors([""]);
            setPage(0);
            latest.reload();
          } else starting.current = false;
        }}
      >
        <Backup />
        Back up now
      </Button>
    ),
    [canStartBackup, props.orgId, props.databaseId, latest.reload],
  );
  if (!path) return <Empty>Select a database to view backup attempts.</Empty>;
  return (
    <>
      <PageSelectionTitle label="Backup Attempts" actions={actions} />
      <Loading {...latest} retry={latest.reload} />
      {page > 0 && <Loading {...older} retry={older.reload} />}
      <Loading {...schedule} retry={schedule.reload} />
      <Loading {...job} retry={job.reload} />
      <div className="grid min-w-0 gap-4">
        <ResourceTable
          ariaLabel="Database backup attempts"
          items={history.data.data}
          getRowKey={(run) => run.id}
          tableClassName="min-w-5xl"
          emptyTitle="No backup attempts yet"
          emptyDescription="Save a backup schedule to start creating database snapshots."
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
                <Chip color={run.trigger === "manual" ? "warning" : "accent"}>
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
                  <Chip
                    color={
                      run.storageState === "pruned" ||
                      run.storageState === "deleting"
                        ? "default"
                        : statusColor(run.state)
                    }
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      size={14}
                      icon={statusIcon(run.state)}
                    />
                    <Chip.Label>
                      {run.storageState === "pruned"
                        ? "Pruned"
                        : run.storageState === "deleting"
                          ? "Removing"
                          : run.stage === "retry_wait"
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
              headerClassName: "min-w-32",
              className: "min-w-32",
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
              headerClassName: "min-w-lg",
              className: "min-w-lg",
              cell: (run) => (
                <span className="block max-w-2xl break-words">
                  {(run.retentionError ?? run.error) && (
                    <TriangleAlertIcon
                      size={16}
                      aria-hidden="true"
                      className="mr-1.5 inline-block align-text-bottom text-danger"
                    />
                  )}
                  {run.retentionError ??
                    run.error ??
                    (run.storageState === "pruned"
                      ? "Removed by the backup retention policy."
                      : run.note) ??
                    (run.objectKey ? (
                      <TypographyCode className="block whitespace-normal break-all">
                        {`${run.bucket}/${run.objectKey}`}
                      </TypographyCode>
                    ) : run.kind === "destination_test" ? (
                      "Destination test"
                    ) : (
                      "—"
                    ))}
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
                    <Stop />
                    Cancel
                  </Button>
                ) : run.kind === "backup" &&
                  run.state === "succeeded" &&
                  run.storageState === "available" &&
                  run.objectKey &&
                  run.checksum ? (
                  <Button
                    variant="secondary"
                    onPress={() => setSelected({ backupId: run.id })}
                  >
                    <Restore />
                    Restore
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
            <ChevronLeft />
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
            <ChevronRight />
          </Button>
        </div>
      </div>
      {selected && (
        <RestoreBackup
          key={selected.backupId}
          orgId={props.orgId}
          backupId={selected.backupId}
          destination={(() => {
            const run = history.data.data.find(
              (run) => run.id === selected.backupId,
            );
            return run?.objectKey
              ? `${run.bucket}/${run.objectKey}`
              : undefined;
          })()}
          onClose={() => {
            setSelected(null);
          }}
          onRestored={() => {
            props.onChanged?.();
          }}
          onAccessLost={() => {
            setSelected(null);
            props.onClose();
          }}
        />
      )}
    </>
  );
}
