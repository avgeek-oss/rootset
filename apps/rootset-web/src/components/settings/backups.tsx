"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BackupDestinationSchema,
  BackupScheduleInputSchema,
  BackupTimingSchema,
  createDateTimeFormatter,
  isTimeZone,
  type BackupScheduleResult,
  type DatabaseBackup,
} from "@rootset/contracts";
import { formatStorageBytes } from "../../lib/format-storage";
import {
  databasePath,
  organisationPath,
  performAction,
  readRaw,
  useMutation,
  useResource,
} from "./api";
import { PageSelectionTitle } from "./account/page-selection-title";
import { statusColor, statusIcon, statusLabel } from "./status";
import { Empty, Field, Form, Loading, Section, Toggle } from "./ui";
import type { Job, SettingsPanelProps } from "./types";

interface BackupPage {
  data: DatabaseBackup[];
  nextCursor: string | null;
}
const EMPTY_PAGE: BackupPage = { data: [], nextCursor: null };
const loadHistory = (path: string, signal?: AbortSignal) =>
  readRaw<BackupPage>(path, signal);
const isActive = (state: string) => state === "queued" || state === "running";

export function BackupScheduleSettings(props: SettingsPanelProps) {
  const path = props.databaseId
    ? databasePath(props.orgId, props.databaseId)
    : undefined;
  const input = useMemo(
    () => ({ orgId: props.orgId, databaseId: props.databaseId }),
    [props.orgId, props.databaseId],
  );
  const resource = useResource<BackupScheduleResult | null>(
    path ? `${path}/backup-schedule` : undefined,
    null,
  );
  const [cursors, setCursors] = useState<string[]>([""]);
  const [page, setPage] = useState(0);
  const history = useResource<BackupPage>(
    path
      ? `${path}/backups?limit=25${cursors[page] ? `&cursor=${encodeURIComponent(cursors[page]!)}` : ""}`
      : undefined,
    EMPTY_PAGE,
    loadHistory,
  );
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [cron, setCron] = useState("0 2 * * *");
  const [timezone, setTimezone] = useState(
    props.preferences?.timezone ?? "UTC",
  );
  const [enabled, setEnabled] = useState(false);
  const [version, setVersion] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [preview, setPreview] = useState<string[]>([]);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [pending, setPending] = useState<{
    id: string;
    kind: "test" | "backup";
  }>();
  const initialized = useRef(false);
  const mutation = useMutation();
  const job = useResource<Job | null>(
    pending ? `${organisationPath(props.orgId)}/jobs/${pending.id}` : undefined,
    null,
  );
  const format = useMemo(
    () =>
      createDateTimeFormatter({
        dateFormat: props.preferences?.dateFormat ?? "year-month-day",
        timeFormat: props.preferences?.timeFormat ?? "24-hour",
        timeZone: props.preferences?.timezone ?? "UTC",
      }),
    [props.preferences],
  );
  const available = resource.data?.worker.available ?? false;
  const matches = resource.data?.worker.matchesSchedule ?? false;
  const hasActiveBackup =
    history.data.data.some(
      (run) => run.kind === "backup" && isActive(run.state),
    ) || pending?.kind === "backup";
  const testing = pending?.kind === "test";
  useEffect(() => {
    if (!resource.data || initialized.current) return;
    initialized.current = true;
    const saved = resource.data.schedule;
    if (saved) {
      setBucket(saved.bucket);
      setPrefix(saved.prefix);
      setCron(saved.cron);
      setTimezone(saved.timezone);
      setEnabled(saved.enabled);
      setVersion(saved.version);
    }
    setPreview(resource.data.nextRuns);
  }, [resource.data]);
  useEffect(() => {
    if (!path) return;
    const timer = setInterval(resource.reload, 10000);
    return () => clearInterval(timer);
  }, [path, resource.reload]);
  useEffect(() => {
    if (
      !pending &&
      !history.data.data.some((run) => isActive(run.state)) &&
      (!resource.data?.schedule?.enabled || page !== 0)
    )
      return;
    const timer = setInterval(
      () => {
        if (page === 0) history.reload();
        if (pending) job.reload();
      },
      pending || history.data.data.some((run) => isActive(run.state))
        ? 2000
        : 10000,
    );
    return () => clearInterval(timer);
  }, [
    pending,
    history.data.data,
    history.reload,
    job.reload,
    resource.data?.schedule?.enabled,
    page,
  ]);
  useEffect(() => {
    if (!pending || job.data?.id !== pending.id || isActive(job.data.state))
      return;
    setPending(undefined);
    history.reload();
    resource.reload();
    if (job.data.state === "succeeded") {
      toast.success(
        pending.kind === "test"
          ? "Backup destination verified."
          : "Database backup completed.",
      );
      setFormError(undefined);
    } else
      setFormError(
        typeof job.data.error === "string"
          ? job.data.error
          : (job.data.error?.message ??
              "The backup operation did not complete."),
      );
  }, [pending, job.data, history.reload, resource.reload]);
  useEffect(() => {
    if (!previewRequested || !props.databaseId) return;
    let current = true;
    const timer = setTimeout(() => {
      const checked = BackupTimingSchema.safeParse({ cron, timezone });
      if (!checked.success) {
        setPreview([]);
        setPreviewError(undefined);
        setFieldErrors((errors) => ({
          ...errors,
          ...Object.fromEntries(
            checked.error.issues.map((issue) => [
              String(issue.path[0]),
              issue.message,
            ]),
          ),
        }));
        return;
      }
      void performAction<{ nextRuns: string[] }>("previewBackupSchedule", {
        ...input,
        cron,
        timezone,
      })
        .then((result) => {
          if (current) {
            setPreview(result.nextRuns);
            setPreviewError(undefined);
          }
        })
        .catch((error: unknown) => {
          if (current) {
            setPreview([]);
            setPreviewError(
              error instanceof Error
                ? error.message
                : "Enter a valid schedule and timezone.",
            );
          }
        });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [cron, timezone, input, previewRequested, props.databaseId]);
  const reloadHistory = () => {
    setPage(0);
    setCursors([""]);
    history.reload();
  };
  const actions = useMemo(
    () => (
      <Button
        className="max-sm:min-h-11"
        isDisabled={
          !available ||
          !matches ||
          !resource.data?.schedule?.testedAt ||
          mutation.busy ||
          hasActiveBackup
        }
        onPress={async () => {
          const result = await mutation.run(() =>
            performAction<{ jobId: string }>("runDatabaseBackup", input),
          );
          if (result.ok) {
            setPending({ id: result.value.jobId, kind: "backup" });
            reloadHistory();
          }
        }}
      >
        Back up now
      </Button>
    ),
    [
      available,
      matches,
      resource.data?.schedule?.testedAt,
      mutation.busy,
      hasActiveBackup,
      input,
    ],
  );
  const clearError = (name: string) =>
    setFieldErrors((errors) => ({ ...errors, [name]: "" }));
  if (!path) return <Empty>Select a database to manage backups.</Empty>;
  return (
    <>
      <PageSelectionTitle label="Backup Schedule" actions={actions} />
      <Loading {...resource} retry={resource.reload} />
      <Loading {...history} retry={history.reload} />
      <Loading {...job} retry={job.reload} />
      {resource.data && (
        <div className="grid min-w-0 gap-6 max-sm:[&_button]:min-h-11">
          {!available ? (
            <p role="status" className="settings-section-description">
              Backup storage is not configured, or no backup-enabled worker is
              online. Your operator can configure S3-compatible storage on the
              Rootset worker.
            </p>
          ) : (
            !matches && (
              <p role="status" className="settings-section-description">
                The worker’s backup configuration changed. Test the destination
                and save this schedule again.
              </p>
            )
          )}
          <Section title="Destination and schedule">
            <Form
              busy={mutation.busy || testing}
              submit="Save schedule"
              noValidate
              onSubmit={async () => {
                setFormError(undefined);
                const checked = BackupScheduleInputSchema.safeParse({
                  bucket,
                  prefix,
                  cron,
                  timezone,
                  enabled,
                  expectedVersion: version,
                });
                if (!checked.success) {
                  setFieldErrors(
                    Object.fromEntries(
                      checked.error.issues.map((issue) => [
                        String(issue.path[0]),
                        issue.message,
                      ]),
                    ),
                  );
                  return;
                }
                setFieldErrors({});
                const result = await mutation.run(
                  () =>
                    performAction<BackupScheduleResult>("saveBackupSchedule", {
                      ...input,
                      ...checked.data,
                    }),
                  "Backup schedule saved.",
                );
                if (result.ok) {
                  resource.replace(result.value);
                  setVersion(result.value.schedule!.version);
                  setBucket(result.value.schedule!.bucket);
                  setPrefix(result.value.schedule!.prefix);
                  setPreview(result.value.nextRuns);
                } else setFormError(result.error.message);
              }}
            >
              <Field
                label="Bucket"
                value={bucket}
                onChange={(value) => {
                  setBucket(value);
                  clearError("bucket");
                }}
                required
                maxLength={63}
                error={fieldErrors.bucket}
              />
              <Field
                label="Path prefix"
                value={prefix}
                onChange={(value) => {
                  setPrefix(value);
                  clearError("prefix");
                }}
                maxLength={512}
                error={fieldErrors.prefix}
                description="Rootset adds the database ID, date, and a unique backup filename."
              />
              <Button
                type="button"
                variant="secondary"
                className="w-fit max-sm:min-h-11"
                isDisabled={!available || mutation.busy || Boolean(pending)}
                isPending={testing}
                onPress={async () => {
                  const checked = BackupDestinationSchema.safeParse({
                    bucket,
                    prefix,
                  });
                  if (!checked.success) {
                    setFieldErrors(
                      Object.fromEntries(
                        checked.error.issues.map((issue) => [
                          String(issue.path[0]),
                          issue.message,
                        ]),
                      ),
                    );
                    return;
                  }
                  setFieldErrors({});
                  setFormError(undefined);
                  const result = await mutation.run(() =>
                    performAction<{ jobId: string }>("testBackupDestination", {
                      ...input,
                      ...checked.data,
                    }),
                  );
                  if (result.ok) {
                    setPending({ id: result.value.jobId, kind: "test" });
                    reloadHistory();
                  }
                }}
              >
                {testing ? "Testing destination…" : "Test destination"}
              </Button>
              {testing && (
                <p role="status" className="settings-section-description">
                  Checking write, read, and cleanup access…
                </p>
              )}
              <Field
                label="Cron schedule"
                value={cron}
                onChange={(value) => {
                  setCron(value);
                  clearError("cron");
                }}
                onBlur={() => setPreviewRequested(true)}
                required
                error={fieldErrors.cron}
                description="Five fields: minute, hour, day, month, weekday. For example, 0 2 * * * runs daily at 02:00."
              />
              <Field
                label="Timezone"
                value={timezone}
                onChange={(value) => {
                  setTimezone(value);
                  clearError("timezone");
                }}
                onBlur={() => setPreviewRequested(true)}
                required
                error={fieldErrors.timezone}
                description="An IANA timezone, such as Asia/Kolkata or Europe/London."
              />
              {previewError ? (
                <p role="alert" className="settings-section-description">
                  {previewError}
                </p>
              ) : (
                preview.length > 0 &&
                isTimeZone(timezone) && (
                  <div className="grid gap-2">
                    <p className="font-medium">Schedule preview</p>
                    <ol className="list-inside list-decimal space-y-1 text-muted tabular-nums">
                      {preview.map((at) => (
                        <li key={at}>
                          {
                            createDateTimeFormatter({
                              dateFormat:
                                props.preferences?.dateFormat ??
                                "year-month-day",
                              timeFormat:
                                props.preferences?.timeFormat ?? "24-hour",
                              timeZone: timezone,
                            })(at).dateTime
                          }
                        </li>
                      ))}
                    </ol>
                  </div>
                )
              )}
              <Toggle
                label="Automatic backups"
                selected={enabled}
                onChange={setEnabled}
                description="Verify the destination before enabling this schedule."
              />
              {formError && (
                <p role="alert" className="settings-section-description">
                  {formError}
                </p>
              )}
              <p className="settings-section-description">
                Backups remain in your bucket until removed or expired by its
                lifecycle rules.
              </p>
            </Form>
          </Section>
          <div className="grid min-w-0 gap-4">
            <h2 className="text-lg font-medium">Backup history</h2>
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
                    <time
                      className="whitespace-nowrap tabular-nums"
                      dateTime={run.scheduledAt}
                    >
                      {format(run.scheduledAt).dateTime}
                    </time>
                  ),
                },
                {
                  key: "kind",
                  header: "Type",
                  cell: (run) =>
                    run.kind === "destination_test"
                      ? "Destination test"
                      : run.kind === "skipped"
                        ? "Missed schedule"
                        : run.trigger === "manual"
                          ? "Manual backup"
                          : "Scheduled backup",
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
                      <time
                        className="whitespace-nowrap tabular-nums"
                        dateTime={run.snapshotAt}
                      >
                        {format(run.snapshotAt).dateTime}
                      </time>
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
                        className="max-sm:min-h-11"
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
        </div>
      )}
    </>
  );
}
