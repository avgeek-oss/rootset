"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  buttonVariants,
} from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import type { Job } from "@rootset/contracts";
import { RestoreBackup } from "../restore-backup";
import { organisationPath, readRaw, useResource } from "./api";
import { RelativeTime } from "./account/last-synced-time";
import { PageSelectionTitle } from "./account/page-selection-title";
import { statusColor, statusLabel } from "./status";
import { Empty, Loading } from "./ui";
import type { SettingsPanelProps } from "./types";
import { View, ChevronLeft, ChevronRight } from "../ui/icons";

interface RestorePage {
  data: Job[];
  nextCursor: string | null;
}
const EMPTY_RESTORES: RestorePage = { data: [], nextCursor: null };
const loadRestores = (path: string, signal?: AbortSignal) =>
  readRaw<RestorePage>(path, signal);
const isActive = (state: string) => state === "queued" || state === "running";

export function RestoreRequestsSettings(props: SettingsPanelProps) {
  const [restoreCursors, setRestoreCursors] = useState<string[]>([""]);
  const [restorePage, setRestorePage] = useState(0);
  const restores = useResource<RestorePage>(
    props.databaseId
      ? `${organisationPath(props.orgId)}/jobs?databaseId=${props.databaseId}&kind=database_restore&order=desc&limit=25${restoreCursors[restorePage] ? `&cursor=${encodeURIComponent(restoreCursors[restorePage]!)}` : ""}`
      : undefined,
    EMPTY_RESTORES,
    loadRestores,
  );
  const [selected, setSelected] = useState<{
    backupId: string;
    initialJob: Job;
  } | null>(null);
  const hasActiveRestore = restores.data.data.some((run) =>
    isActive(run.state),
  );
  useEffect(() => {
    if (!props.databaseId) return;
    const timer = setInterval(restores.reload, hasActiveRestore ? 2000 : 10000);
    return () => clearInterval(timer);
  }, [props.databaseId, restores.reload, hasActiveRestore]);
  if (!props.databaseId)
    return <Empty>Select a database to view restore attempts.</Empty>;
  return (
    <>
      <PageSelectionTitle label="Restore Attempts" />
      <div className="grid min-w-0 gap-4">
        <Loading {...restores} retry={restores.reload} />
        <ResourceTable
          ariaLabel="Database restore attempts"
          items={restores.data.data}
          getRowKey={(run) => run.id}
          tableClassName="min-w-2xl"
          emptyTitle="No restore attempts"
          emptyDescription="Choose Restore on a successful backup to verify its contents."
          columns={[
            {
              key: "created",
              header: "Requested",
              cell: (run) => (
                <RelativeTime label="Restore requested" value={run.createdAt} />
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
                  <div className="flex flex-wrap justify-end gap-2">
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
                        <View />
                        View attempt
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
            <ChevronLeft />
            Newer attempts
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
            Older attempts
            <ChevronRight />
          </Button>
        </div>
      </div>
      {selected && (
        <RestoreBackup
          key={selected.initialJob.id}
          orgId={props.orgId}
          backupId={selected.backupId}
          initialJob={selected.initialJob}
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
