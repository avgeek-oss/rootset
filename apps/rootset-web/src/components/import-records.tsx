"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Label, ListBox, Select } from "@heroui/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { FileUpload } from "@avgeek-oss/design-system/patterns/file-upload";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import {
  client,
  ApiError,
  browserArtifactDownloadPath,
} from "@rootset/web-client";
import {
  ImportPreviewResultSchema,
  importLimits,
  limits,
  parseImportSource,
  type FieldDefinition,
  type ImportSource,
  type Job,
  type JsonValue,
  type ParsedImport,
  type Preferences,
  type TableSchemaResult,
} from "@rootset/contracts";
import { MutationAttempt } from "../lib/mutation-attempt";
import { formatCellValue } from "./cells";
import { FieldTypeIcon } from "./settings/field-type-options";
import { useConfirmation } from "./settings/ui";
import { statusColor, statusIcon, statusLabel } from "./settings/status";
import "./record-editor.css";

interface ImportTarget {
  orgId: string;
  databaseId: string;
  tableId: string;
}
interface ImportRecordsProps {
  target: ImportTarget;
  preferences: Preferences;
  initialPreviewId?: string;
  onClose(): void;
  onImported(): void;
  onAccessLost(): void;
}
export function importJobActive(job?: Job) {
  return Boolean(job && ["queued", "running"].includes(job.state));
}
export function importReportId(job?: Job): string | undefined {
  const value = job?.state === "succeeded" ? job.result : job?.error?.details;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.reportArtifactId === "string"
  )
    return value.reportArtifactId;
}
export async function downloadImportReport(orgId: string, artifactId: string) {
  await client.operation("getArtifact", { orgId, id: artifactId });
  window.open(
    browserArtifactDownloadPath(orgId, artifactId),
    "_blank",
    "noopener,noreferrer",
  );
}
function useImportJob(orgId: string, id: string | null) {
  return useQuery({
    queryKey: ["import-job", orgId, id],
    queryFn: async ({ signal }) => {
      const job = await client.operation<Job>(
        "getJob",
        { orgId, id },
        { signal },
      );
      if (job.kind === "import_preview" && job.state === "succeeded")
        ImportPreviewResultSchema.parse(job.result);
      return job;
    },
    enabled: Boolean(id),
    refetchInterval: (query) =>
      importJobActive(query.state.data) ? 1000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
export function ImportStatus({ job }: { job: Job }) {
  const preview =
    job.kind === "import_preview" && job.state === "succeeded"
      ? ImportPreviewResultSchema.parse(job.result)
      : null;
  return (
    <Chip color={preview?.invalid ? "warning" : statusColor(job.state)}>
      <HugeiconsIcon
        icon={statusIcon(preview?.invalid ? "failed" : job.state)}
        size={14}
        aria-hidden="true"
      />
      <Chip.Label>
        {preview
          ? preview.invalid
            ? "Needs correction"
            : "Validated"
          : statusLabel(job.state)}
      </Chip.Label>
    </Chip>
  );
}

export function ImportRecords(props: ImportRecordsProps) {
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lock = useRef(false);
  const closing = useRef(false);
  const confirmation = useConfirmation();
  const schema = useQuery({
    queryKey: ["import-schema", props.target.tableId],
    queryFn: ({ signal }) =>
      client.operation<TableSchemaResult>(
        "getTableSchema",
        { ...props.target },
        { signal },
      ),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  function pending(value: boolean) {
    lock.current = value;
    setBusy(value);
  }
  async function close() {
    if (lock.current || closing.current) return;
    closing.current = true;
    try {
      if (
        !dirty ||
        (await confirmation.confirm(
          "Discard import mapping?",
          "The selected file and unsaved column mapping will be discarded.",
          "Discard mapping",
        ))
      )
        props.onClose();
    } finally {
      closing.current = false;
    }
  }
  return (
    <>
      <Drawer
        isOpen
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        <Drawer.Backdrop isDismissable={false} isKeyboardDismissDisabled={busy}>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="record-editor-drawer import-records-drawer">
              <Drawer.Header className="record-editor-header">
                <div>
                  <Drawer.Heading>Import records</Drawer.Heading>
                  <p className="text-sm text-muted">
                    {schema.data?.table.name ?? "CSV or JSONL"}
                  </p>
                </div>
                <Drawer.CloseTrigger
                  aria-label="Close import"
                  isDisabled={busy}
                />
              </Drawer.Header>
              {schema.isPending ? (
                <Drawer.Body className="record-editor-body">
                  <p role="status" className="text-muted">
                    Loading fields…
                  </p>
                </Drawer.Body>
              ) : schema.isError && !schema.data ? (
                <Drawer.Body className="record-editor-body">
                  <p role="alert">{schema.error.message}</p>
                  <Button
                    variant="secondary"
                    onPress={() => void schema.refetch()}
                  >
                    Retry loading fields
                  </Button>
                </Drawer.Body>
              ) : schema.data ? (
                <ImportForm
                  {...props}
                  schema={schema.data}
                  busy={busy || schema.isFetching}
                  onPending={pending}
                  onDirty={setDirty}
                  onRequestClose={() => void close()}
                  onReload={async () => {
                    const result = await schema.refetch();
                    if (result.isError) toast.danger(result.error.message);
                    return result.isSuccess;
                  }}
                />
              ) : null}
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
      {confirmation.dialog}
    </>
  );
}

function ImportForm({
  target,
  preferences,
  initialPreviewId,
  schema,
  busy,
  onPending,
  onDirty,
  onRequestClose,
  onReload,
  onImported,
  onAccessLost,
}: ImportRecordsProps & {
  schema: TableSchemaResult;
  busy: boolean;
  onPending(value: boolean): void;
  onDirty(value: boolean): void;
  onRequestClose(): void;
  onReload(): Promise<boolean>;
}) {
  const [source, setSource] = useState<
    (Omit<ImportSource, "mapping"> & { parsed: ParsedImport }) | null
  >(null);
  const [mapping, setMapping] = useState<ImportSource["mapping"]>([]);
  const [previewId, setPreviewId] = useState<string | null>(
    initialPreviewId ?? null,
  );
  const [importId, setImportId] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const lock = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const queryClient = useQueryClient();
  const notified = useRef(new Set<string>());
  const form = useRef<HTMLFormElement>(null);
  const validation = useImportJob(target.orgId, previewId);
  const importing = useImportJob(target.orgId, importId);
  const job = importId ? importing.data : validation.data;
  const active = importJobActive(job);
  const preview =
    validation.data?.state === "succeeded"
      ? ImportPreviewResultSchema.parse(validation.data.result)
      : null;
  const readOnly = schema.table.state !== "active";
  useEffect(
    () => onDirty(Boolean(source && !previewId)),
    [source, previewId, onDirty],
  );
  useEffect(() => {
    if (
      !job ||
      notified.current.has(job.id + job.state) ||
      !["succeeded", "failed", "partially_completed", "cancelled"].includes(
        job.state,
      )
    )
      return;
    notified.current.add(job.id + job.state);
    form.current?.querySelector<HTMLElement>("[data-import-summary]")?.focus();
    if (job.kind === "import" && job.state === "succeeded") {
      onImported();
      toast.success(
        `${job.progress?.committed?.toLocaleString() ?? "All"} ${job.progress?.committed === 1 ? "record" : "records"} imported`,
      );
    } else if (job.state === "failed" || job.state === "partially_completed") {
      if (job.error?.code === "SCHEMA_VERSION_CONFLICT") setStale(true);
      toast.danger(
        job.error?.message ??
          "The import could not finish. Review its report before retrying.",
      );
    }
  }, [job, onImported]);
  useEffect(() => {
    if (!initialPreviewId && window.matchMedia("(pointer: fine)").matches)
      form.current
        ?.querySelector<HTMLElement>(
          'button:not([disabled]),[data-slot="select-trigger"]:not([disabled])',
        )
        ?.focus();
  }, [initialPreviewId]);
  async function perform(operation: string, input: Record<string, unknown>) {
    if (lock.current || busy) return;
    lock.current = true;
    onPending(true);
    try {
      if (operation === "cancelJob") {
        const cancelled = await client.operation<Job>(operation, input, {
          idempotencyKey: attempt.current.forInput({ operation, ...input }),
        });
        attempt.current.clear();
        queryClient.setQueryData(
          ["import-job", target.orgId, cancelled.id],
          cancelled,
        );
        return;
      }
      const accepted = await client.operation<{ jobId: string }>(
        operation,
        input,
        { idempotencyKey: attempt.current.forInput({ operation, ...input }) },
      );
      attempt.current.clear();
      if (operation === "previewImportRows") setPreviewId(accepted.jobId);
      else {
        setImportId(accepted.jobId);
        if (operation === "retryJob")
          await queryClient.invalidateQueries({
            queryKey: ["import-job", target.orgId, accepted.jobId],
          });
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if ([401, 403, 404].includes(error.status)) onAccessLost();
        else if (error.code === "SCHEMA_VERSION_CONFLICT") setStale(true);
      }
      toast.danger(
        error instanceof Error
          ? error.message
          : "The import could not be submitted.",
      );
    } finally {
      lock.current = false;
      onPending(false);
    }
  }
  async function validate() {
    if (!source || active || importId || readOnly || stale) return;
    if (!mapping.length && source.parsed.rows.some((row) => !row.issue)) {
      toast.danger("Map at least one source column.");
      form.current
        ?.querySelector<HTMLElement>('[data-slot="select-trigger"]')
        ?.focus();
      return;
    }
    const input = {
      ...target,
      expectedSchemaVersion: schema.table.schemaVersion,
      format: source.format,
      fileName: source.fileName,
      content: source.content,
      mapping,
    };
    if (
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
      limits.requestBytes
    ) {
      toast.danger(
        "The encoded file exceeds the 8 MiB request limit. Split it into smaller files.",
      );
      return;
    }
    await perform("previewImportRows", input);
  }
  const report = importReportId(job);
  const failed = Boolean(
    importId &&
    job &&
    ["failed", "partially_completed", "cancelled"].includes(job.state),
  );
  const complete = Boolean(importId && job?.state === "succeeded");
  const waiting = Boolean(
    (previewId && validation.isPending) || (importId && importing.isPending),
  );
  return (
    <form
      ref={form}
      className="record-editor-form"
      noValidate
      aria-label="Import records"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || active || readOnly || stale || waiting) return;
        if (preview && !preview.invalid && !importId)
          void perform("importRows", {
            ...target,
            previewId,
            expectedSchemaVersion: preview.schemaVersion,
          });
        else void validate();
      }}
    >
      <Drawer.Body className="record-editor-body">
        {readOnly && (
          <p className="text-muted">
            This table is in maintenance. Wait for maintenance to finish before
            importing.
          </p>
        )}
        {!source && !previewId ? (
          <FileUpload
            accept=".csv,.jsonl,.ndjson,text/csv,application/x-ndjson,application/jsonl"
            maxSizeBytes={importLimits.sourceBytes}
            label="Choose a CSV or JSONL file"
            description="Up to 4 MiB and 50,000 records. Imports append new records."
            isDisabled={busy || readOnly}
            onUpload={async (file) => {
              const format = /\.csv$/i.test(file.name) ? "csv" : "jsonl";
              const content = new TextDecoder("utf-8", { fatal: true }).decode(
                await file.arrayBuffer(),
              );
              const parsed = parseImportSource(format, content);
              setSource({ format, content, fileName: file.name, parsed });
              setMapping(
                parsed.columns.flatMap((column) => {
                  const field = schema.fields.find(
                    (field) => field.name === column,
                  );
                  return field ? [{ source: column, fieldId: field.id }] : [];
                }),
              );
            }}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {source?.fileName ??
                  preview?.fileName ??
                  job?.fileName ??
                  "Import file"}
                {source
                  ? ` · ${source.parsed.rows.length.toLocaleString()} ${source.parsed.rows.length === 1 ? "record" : "records"}`
                  : ""}
              </p>
              {!active && !importId && (
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={busy || waiting}
                  onPress={() => {
                    setSource(null);
                    setMapping([]);
                    setPreviewId(null);
                  }}
                >
                  Choose another file
                </Button>
              )}
            </div>
            {source && !importId && (
              <section
                className="grid min-w-0 gap-3"
                aria-label="Column mapping"
              >
                <h3 className="text-sm font-medium">Column mapping</h3>
                <ResourceTable
                  ariaLabel="Import column mapping"
                  emptyTitle="No readable columns"
                  emptyDescription={
                    preview
                      ? "Correct the JSONL syntax and choose the file again."
                      : "Validate the file to get its row-specific error report."
                  }
                  items={source.parsed.columns}
                  getRowKey={(column) => column}
                  tableClassName="min-w-lg"
                  columns={[
                    {
                      key: "source",
                      header: "Source column",
                      cell: (column) => <code>{column}</code>,
                    },
                    {
                      key: "field",
                      header: "Field",
                      cell: (column) => {
                        const selected = mapping.find(
                          (item) => item.source === column,
                        );
                        const field = schema.fields.find(
                          (field) => field.id === selected?.fieldId,
                        );
                        return (
                          <Select
                            variant="secondary"
                            className="settings-field"
                            value={selected?.fieldId ?? "ignore"}
                            disabledKeys={mapping
                              .filter((item) => item.source !== column)
                              .map((item) => item.fieldId)}
                            isDisabled={busy || active || waiting}
                            onChange={(key) => {
                              setMapping((current) => [
                                ...current.filter(
                                  (item) => item.source !== column,
                                ),
                                ...(key && key !== "ignore"
                                  ? [{ source: column, fieldId: String(key) }]
                                  : []),
                              ]);
                              setPreviewId(null);
                            }}
                          >
                            <Label className="sr-only">Map {column}</Label>
                            <Select.Trigger>
                              <Select.Value>
                                {field ? (
                                  <span className="flex min-w-0 items-center gap-2">
                                    <FieldTypeIcon type={field.type} />
                                    <span className="truncate">
                                      {field.name}
                                    </span>
                                  </span>
                                ) : (
                                  "Ignore column"
                                )}
                              </Select.Value>
                              <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                              <ListBox>
                                <ListBox.Item
                                  id="ignore"
                                  textValue="Ignore column"
                                >
                                  Ignore column
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                                {schema.fields.map((field) => (
                                  <ListBox.Item
                                    id={field.id}
                                    key={field.id}
                                    textValue={field.name}
                                  >
                                    <span className="flex min-w-0 flex-1 items-center gap-2">
                                      <FieldTypeIcon type={field.type} />
                                      <span className="truncate">
                                        {field.name}
                                      </span>
                                    </span>
                                    <ListBox.ItemIndicator />
                                  </ListBox.Item>
                                ))}
                              </ListBox>
                            </Select.Popover>
                          </Select>
                        );
                      },
                    },
                  ]}
                />
                <p className="text-sm text-muted">
                  Unmapped fields use their defaults or generated values. CSV
                  uses a header row; an unquoted empty cell or <code>\N</code>{" "}
                  means NULL. Quote empty text. Dates and times use ISO values;
                  timestamps include a UTC offset.
                </p>
              </section>
            )}
            {job && (
              <div
                className="grid gap-3"
                role="status"
                tabIndex={-1}
                data-import-summary
              >
                <div className="flex flex-wrap items-center gap-3">
                  <ImportStatus job={job} />
                  <span className="text-sm text-muted">
                    {job.stage === "validating"
                      ? "Validating "
                      : importId
                        ? "Imported "
                        : ""}
                    {(job.stage === "validating" || !importId
                      ? job.progress?.completed
                      : job.progress?.committed
                    )?.toLocaleString() ?? 0}
                    {job.progress?.total === undefined
                      ? ""
                      : ` of ${job.progress.total.toLocaleString()}`}{" "}
                    {job.progress?.total === 1 ? "record" : "records"}
                  </span>
                </div>
                {active && (
                  <p className="text-sm text-muted">
                    You can close this drawer. Progress is available in Import
                    Requests.
                  </p>
                )}
                {Boolean(importId && job.progress?.committed && failed) && (
                  <p className="text-sm text-muted">
                    Committed records are kept. Retrying resumes after the last
                    committed batch.
                  </p>
                )}
                {report && (
                  <Button
                    variant="secondary"
                    className="justify-self-start"
                    onPress={() =>
                      void downloadImportReport(target.orgId, report).catch(
                        (error) =>
                          toast.danger(
                            error instanceof Error
                              ? error.message
                              : "The report could not be downloaded.",
                          ),
                      )
                    }
                  >
                    Download error report
                  </Button>
                )}
              </div>
            )}
            {waiting && (
              <p role="status" className="text-sm text-muted">
                Loading request…
              </p>
            )}
            {(validation.isError || importing.isError) && (
              <p role="alert">
                {validation.error?.message ?? importing.error?.message}
                <Button
                  variant="secondary"
                  onPress={() =>
                    void (importId ? importing : validation).refetch()
                  }
                >
                  Retry loading request
                </Button>
              </p>
            )}
            {preview && !importId && (
              <>
                <p
                  className={
                    preview.invalid
                      ? "text-sm text-danger"
                      : "text-sm text-muted"
                  }
                >
                  {preview.invalid
                    ? `${preview.invalid.toLocaleString()} ${preview.invalid === 1 ? "record needs" : "records need"} correction before importing.`
                    : `${preview.valid.toLocaleString()} ${preview.valid === 1 ? "record is" : "records are"} ready to import.`}
                </p>
                {preview.issues.length > 0 && (
                  <ResourceTable
                    ariaLabel="Import validation errors"
                    emptyTitle="No validation errors"
                    emptyDescription="All records passed validation."
                    items={preview.issues}
                    getRowKey={(issue) => String(issue.line)}
                    tableClassName="min-w-xl"
                    columns={[
                      {
                        key: "line",
                        header: "Line",
                        cell: (issue) => issue.line,
                      },
                      {
                        key: "field",
                        header: "Field",
                        cell: (issue) => issue.field ?? "—",
                      },
                      {
                        key: "message",
                        header: "Error",
                        cell: (issue) => issue.message,
                      },
                    ]}
                  />
                )}
                {preview.invalid > preview.issues.length && (
                  <p className="text-sm text-muted">
                    Showing the first {preview.issues.length} errors. The report
                    contains every invalid record.
                  </p>
                )}
                {preview.preview.length > 0 && (
                  <section className="grid min-w-0 gap-3">
                    <h3 className="text-sm font-medium">Parsed preview</h3>
                    <ResourceTable
                      ariaLabel="Parsed import preview"
                      emptyTitle="No valid records to preview"
                      emptyDescription="Correct the errors in the report before importing."
                      items={preview.preview}
                      getRowKey={(row) => String(row.line)}
                      tableClassName="min-w-xl"
                      columns={[
                        {
                          key: "line",
                          header: "Line",
                          cell: (row) => row.line,
                        },
                        ...schema.fields.map((field) => ({
                          key: field.id,
                          header: field.name,
                          cell: (row: (typeof preview.preview)[number]) =>
                            importPreviewValue(field, row.values, preferences),
                        })),
                      ]}
                    />
                    <p className="text-sm text-muted">
                      Showing up to 10 valid records. Constraints and
                      permissions are checked again when the import runs.
                    </p>
                  </section>
                )}
              </>
            )}
          </>
        )}
        {stale && !importId && (
          <Button
            variant="secondary"
            className="justify-self-start"
            isDisabled={busy}
            onPress={() => {
              void onReload().then((success) => {
                if (success) {
                  setStale(false);
                  setPreviewId(null);
                }
              });
            }}
          >
            Reload fields
          </Button>
        )}
      </Drawer.Body>
      <Drawer.Footer className="record-editor-footer">
        <Button variant="secondary" isDisabled={busy} onPress={onRequestClose}>
          Close
        </Button>
        {active ? (
          <Button
            variant="secondary"
            isDisabled={busy || job?.cancelRequested}
            onPress={() =>
              void perform("cancelJob", { orgId: target.orgId, id: job!.id })
            }
          >
            Stop request
          </Button>
        ) : failed ? (
          <Button
            isDisabled={busy}
            onPress={() =>
              void perform("retryJob", { orgId: target.orgId, id: importId })
            }
          >
            Retry import
          </Button>
        ) : complete ? null : (
          <Button
            type="submit"
            isPending={busy}
            isDisabled={
              busy ||
              waiting ||
              readOnly ||
              stale ||
              (!source && !preview) ||
              Boolean(preview?.invalid)
            }
          >
            {busy
              ? "Submitting…"
              : preview
                ? preview.invalid
                  ? "Import records"
                  : `Import ${preview.valid.toLocaleString()} ${preview.valid === 1 ? "record" : "records"}`
                : "Validate file"}
          </Button>
        )}
      </Drawer.Footer>
    </form>
  );
}

function importPreviewValue(
  field: FieldDefinition,
  values: Record<string, JsonValue>,
  preferences: Preferences,
) {
  if (
    !Object.hasOwn(values, field.name) &&
    field.type === "integer" &&
    field.autoIncrement
  )
    return <span className="text-muted italic">Generated</span>;
  const supplied = values[field.name];
  const value = supplied === undefined ? (field.default ?? null) : supplied;
  if (value === null) return <span className="null-value">NULL</span>;
  return (
    <span className="block max-w-64 truncate">
      {formatCellValue(field, value, {
        timeZone: preferences.timezone,
        locale: preferences.locale,
        dateFormat: preferences.dateFormat,
        timeFormat: preferences.timeFormat,
      })}
    </span>
  );
}
