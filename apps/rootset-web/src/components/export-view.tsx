"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import {
  ApiError,
  browserArtifactDownloadPath,
  client,
} from "@rootset/web-client";
import type { FieldDefinition, Job, QuerySpec } from "@rootset/contracts";
import { exportViewQuery } from "../lib/export-view";
import { MutationAttempt } from "../lib/mutation-attempt";
import { Choice } from "./settings/ui";
import { FieldTypeIcon } from "./settings/field-type-options";
import { FilterTree } from "./filter-tree";
import { ArrowDownToLine, Columns3 } from "./ui/icons";
import "./record-editor.css";

interface Props {
  target: { orgId: string; databaseId: string; tableId: string };
  tableName: string;
  fields: FieldDefinition[];
  visible: FieldDefinition[];
  selected: FieldDefinition[];
  query: QuerySpec;
  schemaVersion: number;
  onClose(): void;
  onAccessLost(): void;
}
export function ExportView(props: Props) {
  const [captured] = useState(() => ({
    ...props,
    query: structuredClone(props.query),
    fields: structuredClone(props.fields),
  }));
  const [format, setFormat] = useState("csv");
  const [mode, setMode] = useState("visible");
  const [chosen, setChosen] = useState(
    () => new Set(captured.visible.map((field) => field.id)),
  );
  const [accepted, setAccepted] = useState<{ jobId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const submit = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const columnControl = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const job = useQuery({
    queryKey: ["export-view-job", accepted?.jobId],
    queryFn: ({ signal }) =>
      client.operation<Job>(
        "getJob",
        { orgId: props.target.orgId, id: accepted!.jobId },
        { signal },
      ),
    enabled: Boolean(accepted),
    retry: false,
    gcTime: 0,
    refetchInterval: (current) =>
      !current.state.error &&
      (!current.state.data ||
        ["queued", "running"].includes(current.state.data.state))
        ? 2000
        : false,
  });
  const historyPath = `/databases/${props.target.databaseId}/tables/${props.target.tableId}/settings/export-requests`;
  const ordered = [
    ...captured.visible,
    ...captured.fields.filter(
      (field) => !captured.visible.some((visible) => visible.id === field.id),
    ),
  ];
  const columns =
    mode === "visible"
      ? captured.visible
      : mode === "selected"
        ? captured.selected
        : ordered.filter((field) => chosen.has(field.id));
  useEffect(() => {
    if (accepted || job.data) status.current?.focus();
  }, [accepted, job.data?.state]);
  useEffect(() => {
    if (job.error instanceof ApiError && [401, 403].includes(job.error.status))
      props.onAccessLost();
  }, [job.error, props.onAccessLost]);
  function failure(error: unknown, tableRequest = false) {
    toast.danger(
      error instanceof Error
        ? error.message
        : "The export request could not be completed.",
    );
    if (
      error instanceof ApiError &&
      ([401, 403].includes(error.status) ||
        (tableRequest && error.status === 404))
    )
      props.onAccessLost();
  }
  async function start() {
    if (pending.current) return;
    if (!columns.length) {
      toast.danger("Choose at least one column to export.");
      (
        body.current?.querySelector<HTMLElement>('input[type="checkbox"]') ??
        columnControl.current?.querySelector<HTMLElement>("button")
      )?.focus();
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const input = {
        ...captured.target,
        expectedSchemaVersion: captured.schemaVersion,
        format,
        query: exportViewQuery(
          captured.query,
          captured.fields,
          columns.map((field) => field.id),
        ),
      };
      const result = await client.operation<{ jobId: string }>(
        "exportView",
        input,
        { idempotencyKey: attempt.current.forInput(input) },
      );
      setAccepted(result);
    } catch (error) {
      failure(error, true);
      requestAnimationFrame(() => submit.current?.focus());
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function download() {
    if (
      pending.current ||
      typeof job.data?.result !== "object" ||
      !job.data.result ||
      Array.isArray(job.data.result)
    )
      return;
    const artifactId = job.data.result.artifactId;
    if (typeof artifactId !== "string") return;
    pending.current = true;
    setBusy(true);
    try {
      await client.operation("getArtifact", {
        orgId: props.target.orgId,
        id: artifactId,
      });
      window.open(
        browserArtifactDownloadPath(props.target.orgId, artifactId),
        "_blank",
        "noopener,noreferrer",
      );
    } catch (error) {
      failure(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const state = job.data?.state;
  return (
    <Drawer
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending.current) props.onClose();
      }}
    >
      <Drawer.Backdrop isDismissable={false} isKeyboardDismissDisabled={busy}>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="record-editor-drawer">
            <Drawer.Header className="record-editor-header">
              <div>
                <Drawer.Heading>Export current view</Drawer.Heading>
                <p className="text-sm text-muted">{props.tableName}</p>
              </div>
              <Drawer.CloseTrigger
                aria-label="Close view export"
                isDisabled={busy}
              />
            </Drawer.Header>
            <form
              className="record-editor-form"
              aria-label="Current view export"
              onSubmit={(event) => {
                event.preventDefault();
                if (!accepted) void start();
              }}
              onKeyDown={(event) => {
                if (
                  !event.repeat &&
                  (event.metaKey || event.ctrlKey) &&
                  event.key === "Enter"
                ) {
                  event.preventDefault();
                  if (!accepted) void start();
                }
              }}
            >
              <Drawer.Body className="record-editor-body" ref={body}>
                {accepted ? (
                  <>
                    <p ref={status} tabIndex={-1} role="status">
                      {state === "succeeded"
                        ? "Export ready to download."
                        : state === "failed"
                          ? "Export failed."
                          : state === "cancelled"
                            ? "Export cancelled."
                            : "Preparing your export…"}
                    </p>
                    {job.error ? (
                      <>
                        <p role="alert">{job.error.message}</p>
                        <Button
                          variant="secondary"
                          onPress={() => void job.refetch()}
                        >
                          Reload request
                        </Button>
                      </>
                    ) : state === "failed" ? (
                      <p className="text-sm text-muted">
                        {job.data?.error?.message}
                      </p>
                    ) : null}
                    {state === "succeeded" && (
                      <Button
                        variant="secondary"
                        isDisabled={busy}
                        onPress={() => void download()}
                      >
                        <ArrowDownToLine />
                        Download {format.toUpperCase()}
                      </Button>
                    )}
                    <p className="text-sm text-muted">
                      This request uses the filters, sort order and columns
                      captured when you started it. You can follow progress,
                      cancel or retry it in Export Requests.
                    </p>
                    <Link
                      href={historyPath}
                      onClick={() => props.onClose()}
                      className="text-accent underline"
                    >
                      Open Export Requests
                    </Link>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted">
                      Export all records matching this view, including records
                      beyond the loaded window. Checked rows do not limit the
                      export.
                    </p>
                    {captured.query.where ? (
                      <FilterTree
                        where={captured.query.where}
                        fields={captured.fields}
                      />
                    ) : (
                      <p className="text-sm text-muted">No filters applied.</p>
                    )}
                    {captured.query.orderBy?.length ? (
                      <p className="text-sm text-muted">
                        Sort:{" "}
                        {captured.query.orderBy
                          .map(
                            (sort) =>
                              `${captured.fields.find((field) => field.id === sort.field || field.name === sort.field)?.name ?? sort.field} ${sort.direction === "asc" ? "ascending" : "descending"}`,
                          )
                          .join(", ")}
                        .
                      </p>
                    ) : null}
                    <Choice
                      label="File format"
                      value={format}
                      onChange={setFormat}
                      disabled={busy}
                      options={[
                        {
                          value: "csv",
                          label: "CSV",
                          icon: <ArrowDownToLine />,
                        },
                        {
                          value: "jsonl",
                          label: "JSONL",
                          icon: <ArrowDownToLine />,
                        },
                      ]}
                    />
                    <div ref={columnControl}>
                      <Choice
                        label="Columns"
                        value={mode}
                        onChange={setMode}
                        disabled={busy}
                        options={[
                          {
                            value: "visible",
                            label: `Visible columns (${captured.visible.length})`,
                            icon: <Columns3 />,
                          },
                          ...(captured.selected.length
                            ? [
                                {
                                  value: "selected",
                                  label: `Selected columns (${captured.selected.length})`,
                                  icon: <Columns3 />,
                                },
                              ]
                            : []),
                          {
                            value: "choose",
                            label: "Choose columns",
                            icon: <Columns3 />,
                          },
                        ]}
                      />
                    </div>
                    {mode === "choose" ? (
                      <ResourceTable
                        ariaLabel="Export columns"
                        items={ordered}
                        getRowKey={(field) => field.id}
                        tableClassName="min-w-xs"
                        emptyTitle="No columns"
                        emptyDescription="This table has no fields to export."
                        columns={[
                          {
                            key: "include",
                            header: "Include",
                            cell: (field) => (
                              <Checkbox
                                aria-label={`Export ${field.name}`}
                                isSelected={chosen.has(field.id)}
                                isDisabled={busy}
                                onChange={(include) =>
                                  setChosen((current) => {
                                    const next = new Set(current);
                                    if (include) next.add(field.id);
                                    else next.delete(field.id);
                                    return next;
                                  })
                                }
                              >
                                <Checkbox.Content
                                  className="min-h-11 min-w-11 justify-center"
                                  aria-label={`Export ${field.name}`}
                                >
                                  <Checkbox.Control>
                                    <Checkbox.Indicator />
                                  </Checkbox.Control>
                                </Checkbox.Content>
                              </Checkbox>
                            ),
                          },
                          {
                            key: "column",
                            header: "Column",
                            cell: (field) => (
                              <span className="flex items-center gap-2">
                                <FieldTypeIcon type={field.type} />
                                {field.name}
                              </span>
                            ),
                          },
                        ]}
                      />
                    ) : (
                      <p className="text-sm text-muted break-words">
                        {columns.map((field) => field.name).join(", ") ||
                          "No columns selected."}
                      </p>
                    )}
                    <p className="text-sm text-muted">
                      Complete-table and complete-database exports are available
                      separately in Export Requests.
                    </p>
                  </>
                )}
              </Drawer.Body>
              <Drawer.Footer className="record-editor-footer">
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={props.onClose}
                >
                  {accepted ? "Close" : "Cancel"}
                </Button>
                {!accepted && (
                  <Button ref={submit} type="submit" isPending={busy}>
                    Start export
                  </Button>
                )}
              </Drawer.Footer>
            </form>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
