"use client";

import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { statusColor, statusIcon, statusLabel } from "./status";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { browserArtifactDownloadPath } from "@rootset/web-client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { Dialog } from "../dialog";
import { PageSelectionTitle } from "./account/page-selection-title";
import { RelativeTime } from "./account/last-synced-time";
import {
  organisationPath,
  databasePath,
  read,
  readRaw,
  tablePath,
  useMutation,
  useResource,
  write,
} from "./api";
import { Choice, Empty, Form, Loading } from "./ui";
import type { Artifact, Job, SettingsPanelProps } from "./types";

interface JobAccepted {
  jobId: string;
  state: string;
  statusUrl: string;
}
interface ExportPage {
  data: Job[];
  nextCursor: string | null;
}
const active = (job: Job) => ["queued", "running"].includes(job.state);

async function downloadArtifact(orgId: string, artifactId: string) {
  const artifact = await read<Artifact>(
    `${organisationPath(orgId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
  if (!artifact.downloadUrl)
    throw new Error(
      "The export download is not ready. Try again after the request succeeds.",
    );
  window.open(
    browserArtifactDownloadPath(orgId, artifactId),
    "_blank",
    "noopener,noreferrer",
  );
}

export function ExportRequestsTable({
  requests,
  busy,
  onDownload,
  onCancel,
  onRetry,
  emptyAction,
  databaseLevel = false,
}: {
  requests: Job[];
  busy: boolean;
  onDownload: (artifactId: string) => void;
  onCancel: (job: Job) => void;
  onRetry: (job: Job) => void;
  emptyAction?: ReactNode;
  databaseLevel?: boolean;
}) {
  return (
    <ResourceTable
      ariaLabel="Export Requests"
      items={requests}
      getRowKey={(request) => request.id}
      tableClassName="min-w-3xl"
      emptyTitle="No export requests yet"
      emptyDescription={
        databaseLevel
          ? "Create a request to download a ZIP containing every table’s schema and CSV or JSONL data."
          : "Create a request to download every row and field as CSV or JSONL."
      }
      emptyAction={emptyAction}
      columns={[
        {
          key: "requested",
          header: "Requested",
          cell: (request) => (
            <RelativeTime label="Requested" value={request.createdAt} />
          ),
        },
        {
          key: "scope",
          header: "Scope",
          cell: (request) =>
            request.exportScope === "view"
              ? "Current view"
              : databaseLevel
                ? "Full database"
                : "Full table",
        },
        {
          key: "format",
          header: "File format",
          cell: (request) =>
            request.format ? (
              `${databaseLevel ? "ZIP · " : ""}${request.format.toUpperCase()}`
            ) : (
              <span className="field-empty">—</span>
            ),
        },
        {
          key: "status",
          header: "Status",
          cell: (request) => (
            <Chip color={statusColor(request.state)}>
              <HugeiconsIcon
                aria-hidden="true"
                size={14}
                icon={statusIcon(request.state)}
              />
              <Chip.Label>{statusLabel(request.state)}</Chip.Label>
            </Chip>
          ),
        },
        ...(databaseLevel
          ? [
              {
                key: "tables",
                header: "Tables",
                cell: (request: Job) =>
                  typeof request.result?.tableCount === "number" ? (
                    request.result.tableCount.toLocaleString()
                  ) : (
                    <span className="field-empty">—</span>
                  ),
              },
            ]
          : []),
        {
          key: "rows",
          header: "Rows",
          cell: (request) =>
            typeof request.result?.rowCount === "number" ? (
              request.result.rowCount.toLocaleString()
            ) : (
              <span className="field-empty">—</span>
            ),
        },
        {
          key: "actions",
          header: "Actions",
          headerClassName: "text-right",
          cell: (request) => (
            <div className="field-edit-actions">
              {request.state === "succeeded" && request.result?.artifactId && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => onDownload(request.result!.artifactId!)}
                >
                  Download
                </Button>
              )}
              {active(request) && (
                <Button
                  variant="danger-soft"
                  isDisabled={busy}
                  onPress={() => onCancel(request)}
                >
                  Cancel
                </Button>
              )}
              {["failed", "cancelled"].includes(request.state) && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => onRetry(request)}
                >
                  Retry
                </Button>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}

export function ExportsSettings(props: SettingsPanelProps) {
  const databaseLevel = props.section === "database-exports";
  const path =
    databaseLevel && props.databaseId
      ? databasePath(props.orgId, props.databaseId)
      : props.databaseId && props.tableId
        ? tablePath(props.orgId, props.databaseId, props.tableId)
        : undefined;
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const query = new URLSearchParams({
    kind: "export",
    limit: "50",
  });
  if (databaseLevel && props.databaseId)
    query.set("databaseId", props.databaseId);
  else if (props.tableId) query.set("tableId", props.tableId);
  if (cursor) query.set("cursor", cursor);
  const requests = useResource<ExportPage>(
    path ? `${organisationPath(props.orgId)}/jobs?${query}` : undefined,
    { data: [], nextCursor: null },
    readRaw,
  );
  const mutation = useMutation(requests.reload);
  const pendingRequests = useRef(new Set<string>());
  const [formOpen, setFormOpen] = useState(false);
  const [format, setFormat] = useState("csv");
  const hasActive = requests.data.data.some(active);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(requests.reload, 2000);
    return () => clearInterval(timer);
  }, [hasActive, requests.reload]);
  useEffect(() => {
    for (const request of requests.data.data) {
      if (!pendingRequests.current.has(request.id) || active(request)) continue;
      pendingRequests.current.delete(request.id);
      if (request.state === "succeeded")
        toast.success("Export ready to download.");
      else if (request.state === "failed")
        toast.danger(
          (typeof request.error === "string"
            ? request.error
            : request.error?.message) ?? "Export request failed.",
        );
    }
  }, [requests.data]);
  const actions = useMemo(
    () => (
      <Button
        isDisabled={mutation.busy}
        onPress={() => {
          setFormat("csv");
          setFormOpen(true);
        }}
      >
        Create export request
      </Button>
    ),
    [mutation.busy],
  );
  if (!path)
    return (
      <Empty>
        Select a {databaseLevel ? "database" : "table"} to create export
        requests.
      </Empty>
    );
  return (
    <>
      <PageSelectionTitle label="Export Requests" actions={actions} />
      <Loading {...requests} retry={requests.reload} />
      {(!requests.loading || requests.data.data.length > 0) &&
        !requests.error && (
          <>
            <ExportRequestsTable
              requests={requests.data.data}
              busy={mutation.busy}
              databaseLevel={databaseLevel}
              emptyAction={databaseLevel ? undefined : actions}
              onDownload={(id) => {
                void mutation.run(
                  () => downloadArtifact(props.orgId, id),
                  "Download opened.",
                );
              }}
              onRetry={async (job) => {
                const result = await mutation.run(
                  () =>
                    write<JobAccepted>(
                      `${organisationPath(props.orgId)}/jobs/${job.id}/retry`,
                      "POST",
                    ),
                  "Export request queued again.",
                );
                if (result.ok) pendingRequests.current.add(result.value.jobId);
              }}
              onCancel={(job) => {
                void mutation.run(
                  () =>
                    write(
                      `${organisationPath(props.orgId)}/jobs/${job.id}/cancel`,
                      "POST",
                    ),
                  "Export cancellation requested.",
                );
              }}
            />
            {(cursors.length > 0 || requests.data.nextCursor) && (
              <div className="settings-actions">
                <Button
                  variant="secondary"
                  isDisabled={
                    !cursors.length || requests.loading || mutation.busy
                  }
                  onPress={() =>
                    setCursors((previous) => previous.slice(0, -1))
                  }
                >
                  Previous requests
                </Button>
                <Button
                  variant="secondary"
                  isDisabled={
                    !requests.data.nextCursor ||
                    requests.loading ||
                    mutation.busy
                  }
                  onPress={() => {
                    if (requests.data.nextCursor)
                      setCursors((previous) => [
                        ...previous,
                        requests.data.nextCursor!,
                      ]);
                  }}
                >
                  Next requests
                </Button>
              </div>
            )}
          </>
        )}
      {formOpen && (
        <Dialog
          title="Create export request"
          onClose={() => setFormOpen(false)}
          closeDisabled={mutation.busy}
        >
          <Form
            busy={mutation.busy}
            submit="Start export"
            onCancel={() => setFormOpen(false)}
            onSubmit={async () => {
              const result = await mutation.run(
                () => write<JobAccepted>(`${path}/exports`, "POST", { format }),
                "Export request queued.",
              );
              if (result.ok) {
                pendingRequests.current.add(result.value.jobId);
                setFormOpen(false);
                setCursors([]);
              }
            }}
          >
            {!databaseLevel && (
              <p>
                This request exports every row and field. To export filters and
                chosen columns, use Export current view from the table.
              </p>
            )}
            {databaseLevel && (
              <p>
                The ZIP includes every table’s schema and data from one database
                snapshot. Choose the data format used inside each table folder.
              </p>
            )}
            <Choice
              label={databaseLevel ? "Table data format" : "File format"}
              value={format}
              onChange={setFormat}
              options={[
                { value: "csv", label: "CSV" },
                { value: "jsonl", label: "JSONL" },
              ]}
            />
          </Form>
        </Dialog>
      )}
    </>
  );
}
