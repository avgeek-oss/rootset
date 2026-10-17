"use client";

import { useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { client } from "@rootset/web-client";
import { type Job } from "@rootset/contracts";
import { MutationAttempt } from "../../lib/mutation-attempt";
import {
  ImportRecords,
  ImportStatus,
  downloadImportReport,
  importJobActive,
  importReportId,
} from "../import-records";
import { PageSelectionTitle } from "./account/page-selection-title";
import { RelativeTime } from "./account/last-synced-time";
import type { SettingsPanelProps } from "./types";

export function ImportsSettings(props: SettingsPanelProps) {
  const [drawer, setDrawer] = useState<{ previewId?: string } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const queryClient = useQueryClient();
  const target = {
    orgId: props.orgId,
    databaseId: props.databaseId!,
    tableId: props.tableId!,
  };
  const requests = useQuery({
    queryKey: ["import-requests", target.tableId, cursor],
    queryFn: ({ signal }) =>
      client.operation<{ data: Job[]; nextCursor: string | null }>(
        "listJobs",
        {
          orgId: target.orgId,
          tableId: target.tableId,
          kind: "import",
          limit: 50,
          cursor,
        },
        { signal },
      ),
    refetchInterval: (query) =>
      query.state.data?.data.some(importJobActive) ? 1000 : false,
    placeholderData: keepPreviousData,
  });
  const actions = useMemo(
    () => <Button onPress={() => setDrawer({})}>Import records</Button>,
    [],
  );
  async function action(operation: string, job: Job) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const input = { orgId: props.orgId, id: job.id };
      await client.operation(operation, input, {
        idempotencyKey: attempt.current.forInput({ operation, ...input }),
      });
      attempt.current.clear();
      await queryClient.invalidateQueries({
        queryKey: ["import-requests", target.tableId],
      });
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "The import request could not be updated.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function download(id: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await downloadImportReport(props.orgId, id);
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "The report could not be downloaded.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <PageSelectionTitle label="Import Requests" actions={actions} />
      {requests.isError && (
        <div className="grid gap-3">
          <p role="alert">{requests.error.message}</p>
          <Button
            variant="secondary"
            className="justify-self-start"
            onPress={() => void requests.refetch()}
          >
            Retry loading imports
          </Button>
        </div>
      )}
      {requests.isPending ? (
        <p role="status" className="text-muted">
          Loading import requests…
        </p>
      ) : (
        <ResourceTable
          ariaLabel="Import Requests"
          items={requests.data?.data ?? []}
          getRowKey={(job) => job.id}
          tableClassName="min-w-4xl"
          emptyTitle="No import requests yet"
          emptyDescription="Upload a CSV or JSONL file, map its columns and validate before appending records."
          columns={[
            {
              key: "requested",
              header: "Requested",
              cell: (job) => (
                <RelativeTime value={job.createdAt} label="Requested" />
              ),
            },
            {
              key: "file",
              header: "File",
              cell: (job) => (
                <span className="block max-w-64 truncate">
                  {job.fileName ?? "Import file"}
                </span>
              ),
            },
            {
              key: "type",
              header: "Type",
              cell: (job) => (
                <Chip>
                  <Chip.Label>
                    {job.kind === "import_preview" ? "Validation" : "Import"}
                  </Chip.Label>
                </Chip>
              ),
            },
            {
              key: "state",
              header: "Status",
              cell: (job) => <ImportStatus job={job} />,
            },
            {
              key: "records",
              header: "Records",
              cell: (job) =>
                job.kind === "import"
                  ? (job.progress?.committed ?? 0).toLocaleString()
                  : (job.progress?.total?.toLocaleString() ?? "—"),
            },
            {
              key: "actions",
              header: "Actions",
              headerClassName: "text-right",
              cell: (job) => {
                const report = importReportId(job);
                return (
                  <div className="flex justify-end gap-2">
                    {job.kind === "import_preview" && (
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={busy || requests.isPlaceholderData}
                        onPress={() => setDrawer({ previewId: job.id })}
                      >
                        Review
                      </Button>
                    )}
                    {report && (
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={busy || requests.isPlaceholderData}
                        onPress={() => void download(report)}
                      >
                        Error report
                      </Button>
                    )}
                    {importJobActive(job) ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={
                          busy ||
                          job.cancelRequested ||
                          requests.isPlaceholderData
                        }
                        onPress={() => void action("cancelJob", job)}
                      >
                        Stop
                      </Button>
                    ) : ["failed", "partially_completed", "cancelled"].includes(
                        job.state,
                      ) ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={busy || requests.isPlaceholderData}
                        onPress={() => void action("retryJob", job)}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                );
              },
            },
          ]}
        />
      )}
      {(previous.length > 0 || requests.data?.nextCursor) && (
        <div className="flex justify-end gap-3">
          <Button
            variant="secondary"
            isDisabled={requests.isFetching || !previous.length}
            onPress={() => {
              setCursor(previous.at(-1) ?? null);
              setPrevious((current) => current.slice(0, -1));
            }}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            isDisabled={requests.isFetching || !requests.data?.nextCursor}
            onPress={() => {
              setPrevious((current) => [...current, cursor]);
              setCursor(requests.data!.nextCursor);
            }}
          >
            Next
          </Button>
        </div>
      )}
      {drawer && props.preferences && (
        <ImportRecords
          target={target}
          preferences={props.preferences}
          initialPreviewId={drawer.previewId}
          onClose={() => {
            setDrawer(null);
            void queryClient.invalidateQueries({
              queryKey: ["import-requests", target.tableId],
            });
          }}
          onImported={() => {
            props.onChanged?.();
            void queryClient.invalidateQueries({
              queryKey: ["import-requests", target.tableId],
            });
          }}
          onAccessLost={() => {
            setDrawer(null);
            void queryClient.invalidateQueries({ queryKey: ["context"] });
          }}
        />
      )}
    </>
  );
}
