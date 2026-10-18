"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import {
  BackupScheduleInputSchema,
  BackupScheduleResultSchema,
  BackupTimingSchema,
  createDateTimeFormatter,
  isTimeZone,
  type BackupScheduleResult,
} from "@rootset/contracts";
import {
  databasePath,
  describeError,
  organisationPath,
  performAction,
  showSettingsError,
  useMutation,
  useResource,
} from "./api";
import { BackupRetentionSettings } from "./backup-protection";
import { PageSelectionTitle } from "./account/page-selection-title";
import { TimeZoneSelect } from "./time-zone-select";
import { Empty, Field, Form, Loading, Section } from "./ui";
import type { Job, SettingsPanelProps } from "./types";
import { Trash2 } from "../ui/icons";
import { RootsetEmptyState } from "../rootset-empty-state";
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
  const [pending, setPending] = useState<string>();
  const initialized = useRef(false);
  const completed = useRef(new Set<string>());
  const mutation = useMutation();
  const job = useResource<Job | null>(
    pending ? `${organisationPath(props.orgId)}/jobs/${pending}` : undefined,
    null,
  );
  const available = resource.data?.worker.available ?? false;
  const matches = resource.data?.worker.matchesSchedule ?? false;
  const saving = Boolean(pending);
  useLayoutEffect(() => {
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
    if (id && !pending && !completed.current.has(id)) setPending(id);
  }, [resource.data?.pendingSaveJobId, pending]);
  useEffect(() => {
    if (!path) return;
    const timer = setInterval(resource.reload, 10000);
    return () => clearInterval(timer);
  }, [path, resource.reload]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(job.reload, 2000);
    return () => clearInterval(timer);
  }, [pending, job.reload]);
  useEffect(() => {
    if (!pending || job.data?.id !== pending || isActive(job.data.state))
      return;
    completed.current.add(pending);
    setPending(undefined);
    resource.reload();
    if (job.data.state === "succeeded") {
      const saved = BackupScheduleResultSchema.parse(job.data.result);
      resource.replace(saved);
      setVersion(saved.version);
      setBucket(saved.schedule!.bucket);
      setPrefix(saved.schedule!.prefix);
      setPreview(saved.nextRuns);
      toast.success("Backup schedule saved.");
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
  }, [pending, job.data, resource.reload]);
  useEffect(() => {
    if (!previewRequested || !props.databaseId) return;
    let current = true;
    const timer = setTimeout(() => {
      const checked = BackupTimingSchema.safeParse({ cron, timezone });
      if (!checked.success) {
        setPreview([]);
        setFieldErrors((errors) => ({
          ...errors,
          cron: "",
          timezone: "",
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
            setFieldErrors((errors) => ({
              ...errors,
              cron: "",
              timezone: "",
            }));
          }
        })
        .catch((error: unknown) => {
          if (current) {
            setPreview([]);
            const detail = describeError(error);
            if (detail.code === "VALIDATION_FAILED")
              setFieldErrors((errors) => ({
                ...errors,
                cron: detail.message,
              }));
            else showSettingsError(detail);
          }
        });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [cron, timezone, input, previewRequested, props.databaseId]);
  const clearError = (name: string) =>
    setFieldErrors((errors) => ({ ...errors, [name]: "" }));
  if (!path) return <Empty>Select a database to manage backups.</Empty>;
  return (
    <>
      <PageSelectionTitle label="Backup Schedule" />
      <Loading {...resource} retry={resource.reload} />
      <Loading {...job} retry={job.reload} />
      {resource.data && !available ? (
        <RootsetEmptyState
          variant="bucket"
          title="Backup storage unavailable"
          description="Backup storage is not configured, or no backup-enabled worker is online. Your operator can configure S3-compatible storage on the Rootset worker."
        />
      ) : resource.data ? (
        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
          {!matches && (
            <p
              role="status"
              className="settings-section-description col-span-full"
            >
              The worker’s backup configuration changed. Save this schedule
              again to verify the destination.
            </p>
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
                        if (pending) {
                          completed.current.add(pending);
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
                      }
                    }}
                  >
                    <Trash2 />
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
                  setPending(result.value.jobId);
                } else if (result.error.code === "VALIDATION_FAILED")
                  setFieldErrors((errors) => ({
                    ...errors,
                    cron: result.error.message,
                  }));
                else setFormError(result.error.message);
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
              <TimeZoneSelect
                value={timezone}
                onChange={(value) => {
                  setTimezone(value);
                  setPreview([]);
                  clearError("timezone");
                  setPreviewRequested(true);
                }}
                error={fieldErrors.timezone}
              />
              <Field
                label="Cron schedule"
                value={cron}
                onChange={(value) => {
                  setCron(value);
                  setPreview([]);
                  clearError("cron");
                }}
                onBlur={() => setPreviewRequested(true)}
                required
                error={fieldErrors.cron}
                description="Five fields: minute, hour, day, month, weekday. For example, 0 2 * * * runs daily at 02:00."
              />
              {preview.length > 0 && isTimeZone(timezone) && (
                <div className="grid gap-2">
                  <p className="font-medium">Schedule preview</p>
                  <ol className="list-inside list-decimal space-y-1 text-muted tabular-nums">
                    {preview.map((at) => (
                      <li key={at}>
                        {
                          createDateTimeFormatter({
                            dateFormat:
                              props.preferences?.dateFormat ?? "year-month-day",
                            timeFormat:
                              props.preferences?.timeFormat ?? "24-hour",
                            timeZone: timezone,
                          })(at).dateTime
                        }
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {formError && (
                <p role="alert" className="settings-section-description">
                  {formError}
                </p>
              )}
            </Form>
          </Section>
          <BackupRetentionSettings {...props} />
        </div>
      ) : null}
    </>
  );
}
