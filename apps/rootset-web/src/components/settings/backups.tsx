"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import {
  BackupScheduleInputSchema,
  BackupScheduleResultSchema,
  BackupTimingSchema,
  createDateTimeFormatter,
  isTimeZone,
  type BackupScheduleResult,
  type DatabaseBackup,
} from "@rootset/contracts";
import {
  databasePath,
  organisationPath,
  performAction,
  readRaw,
  useMutation,
  useResource,
} from "./api";
import { BackupHealth, BackupRetentionSettings } from "./backup-protection";
import { PageSelectionTitle } from "./account/page-selection-title";
import { TimeZoneSelect } from "./time-zone-select";
import { Empty, Field, Form, Loading, Section } from "./ui";
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
  const history = useResource<BackupPage>(
    path ? `${path}/backups?limit=25` : undefined,
    EMPTY_PAGE,
    loadHistory,
  );
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [cron, setCron] = useState("0 2 * * *");
  const [timezone, setTimezone] = useState(
    props.preferences?.timezone ?? "UTC",
  );
  const [version, setVersion] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [preview, setPreview] = useState<string[]>([]);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [pending, setPending] = useState<{
    id: string;
    kind: "save" | "backup";
  }>();
  const initialized = useRef(false);
  const completed = useRef(new Set<string>());
  const mutation = useMutation();
  const job = useResource<Job | null>(
    pending ? `${organisationPath(props.orgId)}/jobs/${pending.id}` : undefined,
    null,
  );
  const available = resource.data?.worker.available ?? false;
  const matches = resource.data?.worker.matchesSchedule ?? false;
  const hasActiveBackup =
    history.data.data.some(
      (run) => run.kind === "backup" && isActive(run.state),
    ) || pending?.kind === "backup";
  const saving = pending?.kind === "save";
  useEffect(() => {
    if (!resource.data || initialized.current) return;
    initialized.current = true;
    const saved = resource.data.schedule;
    if (saved) {
      setBucket(saved.bucket);
      setPrefix(saved.prefix);
      setCron(saved.cron);
      setTimezone(saved.timezone);
    }
    setVersion(resource.data.version);
    setPreview(resource.data.nextRuns);
  }, [resource.data]);
  useEffect(() => {
    const id = resource.data?.pendingSaveJobId;
    if (id && !pending && !completed.current.has(id))
      setPending({ id, kind: "save" });
  }, [resource.data?.pendingSaveJobId, pending]);
  useEffect(() => {
    if (!path) return;
    const timer = setInterval(resource.reload, 10000);
    return () => clearInterval(timer);
  }, [path, resource.reload]);
  useEffect(() => {
    if (
      !pending &&
      !history.data.data.some((run) => isActive(run.state)) &&
      !resource.data?.schedule
    )
      return;
    const timer = setInterval(
      () => {
        history.reload();
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
    resource.data?.schedule,
  ]);
  useEffect(() => {
    if (!pending || job.data?.id !== pending.id || isActive(job.data.state))
      return;
    completed.current.add(pending.id);
    setPending(undefined);
    history.reload();
    resource.reload();
    if (job.data.state === "succeeded") {
      if (pending.kind === "save") {
        const saved = BackupScheduleResultSchema.parse(job.data.result);
        resource.replace(saved);
        setVersion(saved.version);
        setBucket(saved.schedule!.bucket);
        setPrefix(saved.schedule!.prefix);
        setPreview(saved.nextRuns);
      }
      toast.success(
        pending.kind === "save"
          ? "Backup schedule saved."
          : "Database backup completed.",
      );
      setFormError(undefined);
    } else {
      const message =
        typeof job.data.error === "string"
          ? job.data.error
          : (job.data.error?.message ??
            "The backup operation did not complete.");
      setFormError(message);
      toast.danger(message);
    }
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
  const actions = useMemo(
    () => (
      <Button
        isDisabled={
          !available ||
          !matches ||
          !resource.data?.schedule?.testedAt ||
          mutation.busy ||
          saving ||
          hasActiveBackup
        }
        onPress={async () => {
          const result = await mutation.run(() =>
            performAction<{ jobId: string }>("runDatabaseBackup", input),
          );
          if (result.ok) {
            setPending({ id: result.value.jobId, kind: "backup" });
            history.reload();
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
      saving,
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
        <div className="grid min-w-0 gap-6">
          <BackupHealth {...props} />
          {!available ? (
            <p role="status" className="settings-section-description">
              Backup storage is not configured, or no backup-enabled worker is
              online. Your operator can configure S3-compatible storage on the
              Rootset worker.
            </p>
          ) : (
            !matches && (
              <p role="status" className="settings-section-description">
                The worker’s backup configuration changed. Save this schedule
                again to verify the destination.
              </p>
            )
          )}
          <Section title="Destination and schedule">
            <Form
              busy={mutation.busy || saving}
              submit="Save schedule"
              actions={
                resource.data.schedule && (
                  <Button
                    type="button"
                    variant="danger-soft"
                    isDisabled={mutation.busy}
                    onPress={async () => {
                      const result = await mutation.run(
                        () =>
                          performAction<BackupScheduleResult>(
                            "deleteBackupSchedule",
                            { ...input, expectedVersion: version },
                          ),
                        "Backup schedule deleted.",
                      );
                      if (result.ok) {
                        if (pending?.kind === "save") {
                          completed.current.add(pending.id);
                          setPending(undefined);
                        }
                        resource.replace(result.value);
                        setVersion(result.value.version);
                        setBucket("");
                        setPrefix("");
                        setCron("0 2 * * *");
                        setTimezone(props.preferences?.timezone ?? "UTC");
                        setPreview([]);
                        setPreviewRequested(false);
                        setFieldErrors({});
                        setFormError(undefined);
                        history.reload();
                      }
                    }}
                  >
                    Delete schedule
                  </Button>
                )
              }
              noValidate
              onSubmit={async () => {
                setFormError(undefined);
                const checked = BackupScheduleInputSchema.safeParse({
                  bucket,
                  prefix,
                  cron,
                  timezone,
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
                const result = await mutation.run(() =>
                  performAction<{ jobId: string }>("saveBackupSchedule", {
                    ...input,
                    ...checked.data,
                  }),
                );
                if (result.ok) {
                  setPending({ id: result.value.jobId, kind: "save" });
                  history.reload();
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
                description="Leading and trailing slashes are removed automatically. Rootset adds the database ID, date, and a unique backup filename."
              />
              {saving && (
                <p role="status" className="settings-section-description">
                  Verifying the destination before saving the schedule…
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
              <TimeZoneSelect
                value={timezone}
                onChange={(value) => {
                  setTimezone(value);
                  clearError("timezone");
                  setPreviewRequested(true);
                }}
                error={fieldErrors.timezone}
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
              {formError && (
                <p role="alert" className="settings-section-description">
                  {formError}
                </p>
              )}
              <p className="settings-section-description">
                Saved backups follow your retention policy and any bucket
                lifecycle rules.
              </p>
            </Form>
          </Section>
          <BackupRetentionSettings {...props} />
        </div>
      )}
    </>
  );
}
