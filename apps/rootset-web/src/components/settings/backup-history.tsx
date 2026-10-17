"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createDateTimeFormatter,
  type DatabaseBackup,
  type Job,
} from "@rootset/contracts";
import { BackupHealth } from "./backup-protection";
import { RestoreBackup } from "../restore-backup";
import Link from "next/link";
import { buttonVariants } from "@avgeek-oss/design-system/buttons/button";
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
import type { SettingsPanelProps } from "./types";

interface BackupPage {
  data: DatabaseBackup[];
  nextCursor: string | null;
}
const EMPTY_PAGE: BackupPage = { data: [], nextCursor: null };
interface RestorePage {
  data: Job[];
  nextCursor: string | null;
}
const EMPTY_RESTORES: RestorePage = { data: [], nextCursor: null };
const loadRestores = (path: string, signal?: AbortSignal) =>
  readRaw<RestorePage>(path, signal);
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
  const [selected, setSelected] = useState<{
    backupId: string;
    initialJob?: Job;
  } | null>(null);
  const [restoreCursors, setRestoreCursors] = useState<string[]>([""]);
  const [restorePage, setRestorePage] = useState(0);
  const restores = useResource<RestorePage>(
    props.databaseId
      ? `${organisationPath(props.orgId)}/jobs?databaseId=${props.databaseId}&kind=database_restore&order=desc&limit=25${restoreCursors[restorePage] ? `&cursor=${encodeURIComponent(restoreCursors[restorePage]!)}` : ""}`
      : undefined,
    EMPTY_RESTORES,
    loadRestores,
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
  const hasActiveRestore = restores.data.data.some((run) =>
    isActive(run.state),
  );
  useEffect(() => {
    const timer = setInterval(restores.reload, hasActiveRestore ? 2000 : 10000);
    return () => clearInterval(timer);
  }, [restores.reload, hasActiveRestore]);
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
        <BackupHealth {...props} />
        <ResourceTable
          ariaLabel="Database backups"
          items={history.data.data}
          getRowKey={(run) => run.id}
          tableClassName="min-w-5xl"
          emptyTitle="No backups yet"
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
                  {run.retentionError ??
                    run.error ??
                    (run.storageState === "pruned"
                      ? "Removed by the backup retention policy."
                      : run.note) ??
                    (run.objectKey ? (
                      <TypographyCode className="block w-80 whitespace-normal break-all">
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
        <section
          className="grid min-w-0 gap-4"
          aria-labelledby="restore-requests-heading"
        >
          <h2 id="restore-requests-heading" className="text-lg font-medium">
            Restore requests
          </h2>
          <Loading {...restores} retry={restores.reload} />
          <ResourceTable
            ariaLabel="Database restore requests"
            items={restores.data.data}
            getRowKey={(run) => run.id}
            tableClassName="min-w-2xl"
            emptyTitle="No restore requests"
            emptyDescription="Choose Restore on a successful backup to verify its contents."
            columns={[
              {
                key: "created",
                header: "Requested",
                cell: (run) => (
                  <RelativeTime
                    label="Restore requested"
                    value={run.createdAt}
                  />
                ),
              },
              {
                key: "type",
                header: "Type",
                cell: (run) =>
                  run.kind === "database_restore_preview"
                    ? "Verification"
                    : "Restore",
              },
              {
                key: "status",
                header: "Status",
                cell: (run) => (
                  <Chip color={statusColor(run.state)}>
                    <Chip.Label>{statusLabel(run.state)}</Chip.Label>
                  </Chip>
                ),
              },
              {
                key: "progress",
                header: "Progress",
                cell: (run) => (
                  <span className="text-sm text-muted">
                    {run.error?.message ??
                      (isActive(run.state)
                        ? statusLabel(run.stage ?? run.state)
                        : run.state === "succeeded"
                          ? "Completed"
                          : "—")}
                  </span>
                ),
              },
              {
                key: "actions",
                header: "Actions",
                headerClassName: "text-right",
                cell: (run) => {
                  const result = run.result;
                  const databaseId =
                    result &&
                    typeof result === "object" &&
                    !Array.isArray(result) &&
                    typeof result.databaseId === "string"
                      ? result.databaseId
                      : null;
                  return (
                    <div className="flex justify-end gap-2">
                      {databaseId && (
                        <Link
                          href={`/databases/${databaseId}`}
                          className={buttonVariants({ variant: "secondary" })}
                        >
                          Open database
                        </Link>
                      )}
                      {run.backupId && (
                        <Button
                          variant="secondary"
                          onPress={() =>
                            setSelected({
                              backupId: run.backupId!,
                              initialJob: run,
                            })
                          }
                        >
                          View request
                        </Button>
                      )}
                    </div>
                  );
                },
              },
            ]}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              isDisabled={restorePage === 0 || restores.loading}
              onPress={() => setRestorePage((value) => value - 1)}
            >
              Newer requests
            </Button>
            <Button
              variant="secondary"
              isDisabled={!restores.data.nextCursor || restores.loading}
              onPress={() => {
                setRestoreCursors((values) => [
                  ...values.slice(0, restorePage + 1),
                  restores.data.nextCursor!,
                ]);
                setRestorePage((value) => value + 1);
              }}
            >
              Older requests
            </Button>
          </div>
        </section>
      </div>
      {selected && (
        <RestoreBackup
          key={selected.initialJob?.id ?? selected.backupId}
          orgId={props.orgId}
          backupId={selected.backupId}
          initialJob={selected.initialJob}
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
            restores.reload();
          }}
          onRestored={() => {
            restores.reload();
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
