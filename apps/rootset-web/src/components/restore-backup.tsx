"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { ApiError, client } from "@rootset/web-client";
import {
  DatabaseRestoreResultSchema,
  RestorePreviewSchema,
  type Job,
} from "@rootset/contracts";
import { MutationAttempt } from "../lib/mutation-attempt";
import { Field, useConfirmation } from "./settings/ui";
import { RelativeTime } from "./settings/account/last-synced-time";
import { statusLabel } from "./settings/status";
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Stop,
  ShieldCheck,
  Restore,
} from "./ui/icons";
import "./record-editor.css";

interface Props {
  orgId: string;
  backupId: string;
  destination?: string;
  initialJob?: Job;
  onClose(): void;
  onRestored(): void;
  onAccessLost(): void;
}
const countLabel = (count: number, singular: string, plural = `${singular}s`) =>
  `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
function useRestoreJob(orgId: string, id: string | null) {
  return useQuery({
    queryKey: ["database-restore-job", orgId, id],
    queryFn: ({ signal }) =>
      client.operation<Job>("getJob", { orgId, id }, { signal }),
    enabled: Boolean(id),
    retry: false,
    gcTime: 0,
    refetchInterval: (current) =>
      !current.state.error &&
      (!current.state.data ||
        ["queued", "running"].includes(current.state.data.state))
        ? 2000
        : false,
  });
}
export function RestoreBackup(props: Props) {
  const [previewId, setPreviewId] = useState<string | null>(() =>
    props.initialJob?.kind === "database_restore_preview"
      ? props.initialJob.id
      : (props.initialJob?.previewId ?? null),
  );
  const [restoreId, setRestoreId] = useState<string | null>(() =>
    props.initialJob?.kind === "database_restore" ? props.initialJob.id : null,
  );
  const [name, setName] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false),
    closing = useRef(false),
    notified = useRef<string | null>(null);
  const attempt = useRef(new MutationAttempt());
  const nameInput = useRef<HTMLDivElement>(null),
    action = useRef<HTMLButtonElement>(null),
    status = useRef<HTMLParagraphElement>(null);
  const confirmation = useConfirmation();
  const preview = useRestoreJob(props.orgId, previewId),
    restore = useRestoreJob(props.orgId, restoreId);
  const checked = RestorePreviewSchema.safeParse(preview.data?.result);
  const summary =
    preview.data?.state === "succeeded" && checked.success
      ? checked.data
      : null;
  const completed = DatabaseRestoreResultSchema.safeParse(restore.data?.result);
  const result =
    restore.data?.state === "succeeded" && completed.success
      ? completed.data
      : null;
  const current = restoreId ? restore : preview;
  const running = Boolean(
    (restoreId || previewId) &&
    (!current.data || ["queued", "running"].includes(current.data.state)),
  );
  const failed =
    current.data?.state === "failed" || current.data?.state === "cancelled";
  const defaultName =
    `${summary?.sourceDatabaseName ?? "Database"} restored`.slice(0, 255);
  const databaseName = name ?? defaultName;
  const expired = summary && Date.parse(summary.expiresAt) <= Date.now();
  useEffect(() => {
    if (result && notified.current !== result.databaseId) {
      notified.current = result.databaseId;
      props.onRestored();
    }
  }, [result?.databaseId, props.onRestored]);
  useEffect(() => {
    if (previewId || restoreId) status.current?.focus();
  }, [previewId, restoreId, current.data?.state]);
  useEffect(() => {
    const error = current.error;
    if (error instanceof ApiError && [401, 403].includes(error.status))
      props.onAccessLost();
  }, [current.error, props.onAccessLost]);
  async function close() {
    if (lock.current || closing.current) return;
    closing.current = true;
    try {
      if (
        name === null ||
        name === defaultName ||
        restoreId ||
        (await confirmation.confirm(
          "Discard database name?",
          "Your entered name will be discarded. Any queued request continues in Restore Attempts.",
          "Discard name",
        ))
      )
        props.onClose();
    } finally {
      closing.current = false;
    }
  }
  async function submit(
    operation:
      | "previewDatabaseRestore"
      | "restoreDatabaseBackup"
      | "cancelJob"
      | "retryJob",
  ) {
    if (lock.current) return;
    if (operation === "restoreDatabaseBackup" && (!summary || expired)) {
      toast.danger("Verify this backup again before restoring it.");
      action.current?.focus();
      return;
    }
    if (operation === "restoreDatabaseBackup" && !databaseName.trim()) {
      toast.danger("Enter a name for the restored database.");
      nameInput.current?.querySelector("input")?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const input =
        operation === "previewDatabaseRestore"
          ? { orgId: props.orgId, backupId: props.backupId }
          : operation === "restoreDatabaseBackup"
            ? {
                orgId: props.orgId,
                backupId: props.backupId,
                previewId,
                name: databaseName.trim(),
              }
            : { orgId: props.orgId, id: restoreId ?? previewId };
      const accepted = await client.operation<{ jobId: string }>(
        operation,
        input,
        { idempotencyKey: attempt.current.forInput({ operation, ...input }) },
      );
      if (operation === "previewDatabaseRestore") {
        setPreviewId(accepted.jobId);
        setRestoreId(null);
        setPage(0);
      } else if (operation === "restoreDatabaseBackup")
        setRestoreId(accepted.jobId);
      else await current.refetch();
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "The restore request could not be completed.",
      );
      if (error instanceof ApiError && [401, 403].includes(error.status))
        props.onAccessLost();
      requestAnimationFrame(() => action.current?.focus());
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const verifyAgain = () => {
    attempt.current = new MutationAttempt();
    void submit("previewDatabaseRestore");
  };
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
                <Drawer.Heading>Restore backup</Drawer.Heading>
                <Drawer.CloseTrigger
                  aria-label="Close backup restore"
                  isDisabled={busy}
                />
              </Drawer.Header>
              <form
                className="record-editor-form"
                noValidate
                aria-label="Restore database backup"
                aria-busy={busy}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!running && !restoreId)
                    void submit(
                      summary && !expired
                        ? "restoreDatabaseBackup"
                        : "previewDatabaseRestore",
                    );
                }}
                onKeyDown={(event) => {
                  if (
                    !event.repeat &&
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    if (!running && !restoreId)
                      void submit(
                        summary && !expired
                          ? "restoreDatabaseBackup"
                          : "previewDatabaseRestore",
                      );
                  }
                }}
              >
                <Drawer.Body className="record-editor-body">
                  <p className="text-sm text-muted">
                    Restore this snapshot into a new database. Its schemas,
                    records and relationships are validated together before it
                    becomes available. Configure a backup schedule separately
                    afterward.
                  </p>
                  {props.destination && (
                    <TypographyCode className="whitespace-normal break-all">
                      {props.destination}
                    </TypographyCode>
                  )}
                  {(previewId || restoreId) && (
                    <p ref={status} tabIndex={-1} role="status">
                      {result
                        ? "Database restored."
                        : current.error
                          ? "Request status could not be loaded."
                          : failed
                            ? `Request ${statusLabel(current.data!.state).toLowerCase()}.`
                            : restoreId
                              ? "Restoring into a new database…"
                              : summary
                                ? "Backup verified."
                                : "Verifying backup…"}
                    </p>
                  )}
                  {current.error ? (
                    <div className="grid gap-3">
                      <p role="alert">{current.error.message}</p>
                      <Button
                        variant="secondary"
                        onPress={() => void current.refetch()}
                      >
                        <RefreshCw />
                        Reload request
                      </Button>
                    </div>
                  ) : null}
                  {running && current.data?.stage && (
                    <p className="text-sm text-muted" aria-live="polite">
                      {statusLabel(current.data.stage)}
                      {current.data.progress
                        ? ` · ${current.data.progress.completed.toLocaleString()}${current.data.progress.total === undefined ? "" : ` of ${current.data.progress.total.toLocaleString()}`} ${current.data.progress.unit ?? ""}`
                        : ""}
                    </p>
                  )}
                  {failed && (
                    <p className="text-sm text-muted">
                      {current.data?.error?.message ??
                        "The request was cancelled. Existing databases were preserved."}
                    </p>
                  )}
                  {result ? (
                    <div className="grid gap-3">
                      <p>
                        {countLabel(result.tableCount, "table")} and{" "}
                        {countLabel(result.rowCount, "record")} restored.
                      </p>
                      {result.skippedPersonalViews > 0 && (
                        <p className="text-sm text-muted">
                          {countLabel(
                            result.skippedPersonalViews,
                            "personal view",
                          )}{" "}
                          {result.skippedPersonalViews === 1 ? "was" : "were"}{" "}
                          omitted because the original owner no longer exists.
                        </p>
                      )}
                      <Link
                        href={`/databases/${result.databaseId}`}
                        onClick={() => props.onClose()}
                        className="text-accent underline"
                      >
                        Open restored database
                      </Link>
                    </div>
                  ) : null}
                  {summary && !restoreId && (
                    <>
                      <div className="grid gap-2">
                        <p>
                          Snapshot of {summary.sourceDatabaseName} ·{" "}
                          <RelativeTime
                            value={summary.snapshotAt}
                            label="Backup snapshot"
                          />
                        </p>
                        <p className="text-sm text-muted">
                          {countLabel(summary.rowCount, "record")} ·{" "}
                          {countLabel(summary.commentCount, "comment")} ·{" "}
                          {countLabel(
                            summary.historyEvents,
                            "history entry",
                            "history entries",
                          )}{" "}
                          · {countLabel(summary.viewCount, "saved view")}
                        </p>
                      </div>
                      <ResourceTable
                        ariaLabel="Backup contents"
                        items={summary.tables.slice(page * 25, (page + 1) * 25)}
                        getRowKey={(table) => table.id}
                        tableClassName="min-w-xl"
                        emptyTitle="Empty database"
                        emptyDescription="This snapshot contains no active tables."
                        columns={[
                          {
                            key: "name",
                            header: "Table",
                            cell: (table) => table.name,
                          },
                          {
                            key: "fields",
                            header: "Fields",
                            cell: (table) => table.fieldCount.toLocaleString(),
                          },
                          {
                            key: "rows",
                            header: "Records",
                            cell: (table) => table.rowCount.toLocaleString(),
                          },
                          {
                            key: "unique",
                            header: "Unique rules",
                            cell: (table) => table.uniqueRules.toLocaleString(),
                          },
                          {
                            key: "keys",
                            header: "Table relations",
                            cell: (table) => table.foreignKeys.toLocaleString(),
                          },
                        ]}
                      />
                      {summary.tables.length > 25 && (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            isDisabled={page === 0}
                            onPress={() => setPage((value) => value - 1)}
                          >
                            <ChevronLeft />
                            Previous tables
                          </Button>
                          <Button
                            variant="secondary"
                            isDisabled={
                              (page + 1) * 25 >= summary.tables.length
                            }
                            onPress={() => setPage((value) => value + 1)}
                          >
                            Next tables
                            <ChevronRight />
                          </Button>
                        </div>
                      )}
                      <div ref={nameInput}>
                        <Field
                          label="New database name"
                          required
                          maxLength={255}
                          value={databaseName}
                          onChange={setName}
                          readOnly={busy}
                        />
                      </div>
                      {expired && (
                        <p role="status" className="text-sm text-muted">
                          This preview expired. Verify the backup again before
                          restoring it.
                        </p>
                      )}
                    </>
                  )}
                  {restoreId && !result && (
                    <p className="text-sm text-muted">
                      The new database stays hidden until every validation
                      passes. Closing this panel leaves the request running in
                      Restore Attempts.
                    </p>
                  )}
                </Drawer.Body>
                <Drawer.Footer className="record-editor-footer flex-wrap">
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    onPress={() => void close()}
                  >
                    Close
                  </Button>
                  {running && current.data && !current.data.cancelRequested && (
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void submit("cancelJob")}
                    >
                      <Stop />
                      Cancel request
                    </Button>
                  )}
                  {failed && (
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={verifyAgain}
                    >
                      <ShieldCheck />
                      Verify again
                    </Button>
                  )}
                  {restoreId && failed && current.data?.state === "failed" && (
                    <Button
                      ref={action}
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void submit("retryJob")}
                    >
                      <RefreshCw />
                      Retry restore
                    </Button>
                  )}
                  {!restoreId && !running && !failed && !expired && (
                    <Button
                      ref={action}
                      type="submit"
                      variant="primary"
                      isPending={busy}
                    >
                      {summary && !expired ? <Restore /> : <ShieldCheck />}
                      {summary && !expired
                        ? "Restore into new database"
                        : "Verify backup"}
                    </Button>
                  )}
                  {!restoreId && expired && (
                    <Button
                      ref={action}
                      variant="primary"
                      isDisabled={busy}
                      onPress={verifyAgain}
                    >
                      <ShieldCheck />
                      Verify backup again
                    </Button>
                  )}
                </Drawer.Footer>
              </form>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
      {confirmation.dialog}
    </>
  );
}
