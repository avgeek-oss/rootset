"use client";

import { Button, ProgressBar } from "@heroui/react";
import { browserArtifactDownloadPath } from "@rootset/web-client";
import { useEffect, useRef, useState } from "react";
import {
  databasePath,
  organisationPath,
  performAction,
  read,
  tablePath,
  useMutation,
  useResource,
  write,
} from "./api";
import {
  Choice,
  DateLabel,
  Empty,
  Feedback,
  Field,
  Form,
  Loading,
  Record,
  RecordList,
  Section,
  Status,
  Toggle,
  useConfirmation,
} from "./ui";
import type {
  Artifact,
  Backup,
  BackupPolicy,
  Job,
  SettingsPanelProps,
  TableSchemaResult,
} from "./types";

const ACTIVE_STATES = [
  "queued",
  "running",
  "snapshotting",
  "uploading",
  "verifying",
];
const INITIAL_POLICY: BackupPolicy = {
  enabled: false,
  cron: "0 2 * * *",
  timezone: "UTC",
  retentionDays: 30,
  retentionCount: 10,
  maxRuntimeSeconds: 3600,
  destination: "installation",
  encryption: true,
  notifications: true,
};
interface JobAccepted {
  jobId: string;
  state: string;
  statusUrl: string;
}

async function downloadArtifact(orgId: string, artifactId: string) {
  const artifact = await read<Artifact>(
    `${organisationPath(orgId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
  if (!artifact.downloadUrl)
    throw new Error(
      "The artifact download is not ready. Retry after the job succeeds.",
    );
  window.open(
    browserArtifactDownloadPath(orgId, artifactId),
    "_blank",
    "noopener,noreferrer",
  );
}

export function JobTracker({
  orgId,
  jobId,
  onTerminal,
}: {
  orgId: string;
  jobId: string;
  onTerminal?: (job: Job) => void;
}) {
  const resource = useResource<Job | null>(
    `${organisationPath(orgId)}/jobs/${jobId}`,
    null,
  );
  const mutation = useMutation(resource.reload);
  const confirmation = useConfirmation();
  const active = resource.data && ACTIVE_STATES.includes(resource.data.state);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(resource.reload, 2000);
    return () => clearInterval(timer);
  }, [active, resource.reload]);
  const notified = useRef("");
  useEffect(() => {
    if (
      resource.data &&
      !ACTIVE_STATES.includes(resource.data.state) &&
      notified.current !== `${resource.data.id}:${resource.data.state}`
    ) {
      notified.current = `${resource.data.id}:${resource.data.state}`;
      onTerminal?.(resource.data);
    }
  }, [resource.data, onTerminal]);
  return (
    <div className="settings-job">
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      {resource.data && (
        <>
          <div className="settings-inline">
            <strong>{resource.data.kind ?? resource.data.type ?? "Job"}</strong>
            <Status value={resource.data.state} />
          </div>
          {resource.data.stage && <p>{resource.data.stage}</p>}
          {active && (
            <ProgressBar
              aria-label="Job progress"
              value={resource.data.progress?.completed ?? 0}
              maxValue={resource.data.progress?.total ?? 100}
              isIndeterminate={!resource.data.progress?.total}
            >
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
          )}
          {resource.data.progress && (
            <p className="settings-muted">
              {resource.data.progress.completed.toLocaleString()}
              {resource.data.progress.total !== undefined && (
                <> / {resource.data.progress.total.toLocaleString()}</>
              )}{" "}
              {resource.data.progress.unit}
            </p>
          )}
          {resource.data.error && (
            <p role="alert" className="settings-feedback-error">
              {typeof resource.data.error === "string"
                ? resource.data.error
                : resource.data.error.message}
            </p>
          )}
          {resource.data.state === "partially_completed" && (
            <p role="status">
              Some batches committed. Review the rejected rows and committed
              counts before retrying.
            </p>
          )}
          {resource.data.result && (
            <>
              <p className="settings-muted">
                {resource.data.result.inserted !== undefined && (
                  <>
                    Inserted {resource.data.result.inserted.toLocaleString()}{" "}
                    ·{" "}
                  </>
                )}
                {resource.data.result.updated !== undefined && (
                  <>
                    updated {resource.data.result.updated.toLocaleString()}{" "}
                    ·{" "}
                  </>
                )}
                {resource.data.result.rejected !== undefined && (
                  <>rejected {resource.data.result.rejected.toLocaleString()}</>
                )}
              </p>
              {resource.data.result.artifactId && (
                <Button
                  variant="secondary"
                  onPress={() =>
                    mutation
                      .run(
                        () =>
                          downloadArtifact(
                            orgId,
                            resource.data!.result!.artifactId!,
                          ),
                        "Download opened.",
                      )
                      .then(() => undefined)
                  }
                >
                  Download result
                </Button>
              )}
              {resource.data.result.reportArtifactId && (
                <Button
                  variant="secondary"
                  onPress={() =>
                    mutation
                      .run(
                        () =>
                          downloadArtifact(
                            orgId,
                            resource.data!.result!.reportArtifactId!,
                          ),
                        "Report opened.",
                      )
                      .then(() => undefined)
                  }
                >
                  Download rejection report
                </Button>
              )}
            </>
          )}
          <div className="settings-actions">
            {active && (
              <Button
                variant="danger-soft"
                isDisabled={mutation.busy}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Cancel job?",
                      "Rootset stops at a safe checkpoint. Already committed import batches remain committed.",
                      "Cancel job",
                    )
                  )
                    await mutation.run(
                      () =>
                        write(
                          `${organisationPath(orgId)}/jobs/${jobId}/cancel`,
                          "POST",
                        ),
                      "Cancellation requested.",
                    );
                }}
              >
                Cancel job
              </Button>
            )}
            {["failed", "cancelled", "partially_completed"].includes(
              resource.data.state,
            ) && (
              <Button
                variant="secondary"
                isDisabled={mutation.busy}
                onPress={() =>
                  mutation
                    .run(
                      () =>
                        write(
                          `${organisationPath(orgId)}/jobs/${jobId}/retry`,
                          "POST",
                        ),
                      "Retry requested.",
                    )
                    .then(() => undefined)
                }
              >
                Retry job
              </Button>
            )}
            <Button variant="ghost" onPress={resource.reload}>
              Refresh status
            </Button>
          </div>
        </>
      )}
      {confirmation.dialog}
    </div>
  );
}

export function JobsSettings(props: SettingsPanelProps) {
  const resource = useResource<Job[]>(
    `${organisationPath(props.orgId)}/jobs`,
    [],
  );
  const [selected, setSelected] = useState("");
  return (
    <>
      <Section
        title="Jobs"
        description="A queued operation is not complete. Check its terminal outcome and validation before relying on the result."
      >
        <Loading {...resource} retry={resource.reload} />
        <Button variant="secondary" onPress={resource.reload}>
          Refresh jobs
        </Button>
        <RecordList>
          {resource.data.map((job) => (
            <Record
              key={job.id}
              title={job.kind ?? job.type ?? "Job"}
              description={
                <>
                  <Status value={job.state} /> · {job.stage} ·{" "}
                  <DateLabel value={job.createdAt} />
                </>
              }
            >
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setSelected(job.id)}
              >
                Inspect
              </Button>
            </Record>
          ))}
        </RecordList>
        {!resource.loading && !resource.error && !resource.data.length && (
          <Empty>No jobs are visible.</Empty>
        )}
      </Section>
      {selected && (
        <Section title="Job details">
          <JobTracker orgId={props.orgId} jobId={selected} />
        </Section>
      )}
    </>
  );
}

export function BackupsSettings(props: SettingsPanelProps) {
  const path = props.databaseId
    ? databasePath(props.orgId, props.databaseId)
    : undefined;
  const resource = useResource<{ policy: BackupPolicy | null }>(
    path ? `${path}/backup-policy` : undefined,
    { policy: null },
  );
  const backups = useResource<Backup[]>(
    path ? `${path}/backups` : undefined,
    [],
  );
  const mutation = useMutation(() => {
    resource.reload();
    backups.reload();
    props.onChanged?.();
  });
  const deletion = useMutation();
  const confirmation = useConfirmation();
  const [policy, setPolicy] = useState(INITIAL_POLICY);
  const [occurrences, setOccurrences] = useState<string[]>([]);
  const [jobId, setJobId] = useState("");
  const [restoreId, setRestoreId] = useState("");
  const [restoreMode, setRestoreMode] = useState("new");
  const [restoreName, setRestoreName] = useState("");
  const [targetId, setTargetId] = useState(props.databaseId ?? "");
  const [restorePreview, setRestorePreview] = useState<{
    compatible?: boolean;
    warnings?: string[];
    rowCount?: number;
    tableCount?: number;
  }>();
  useEffect(() => {
    setPolicy(resource.data.policy ?? INITIAL_POLICY);
  }, [resource.data]);
  function patch<K extends keyof BackupPolicy>(key: K, value: BackupPolicy[K]) {
    setPolicy((previous) => ({ ...previous, [key]: value }));
  }
  if (!path) return <Empty>Select a database to manage backups.</Empty>;
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      <Feedback {...deletion} />
      <Section
        title="Backup schedule"
        description="Every run captures all tables, schema, and retained history in one database snapshot. A run succeeds only after an isolated restore validates it."
      >
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () => write(`${path}/backup-policy`, "PUT", policy),
              "Backup policy saved.",
            );
          }}
        >
          <Toggle
            label="Enable scheduled backups"
            selected={policy.enabled}
            onChange={(value) => patch("enabled", value)}
          />
          <Field
            label="Five-field cron"
            value={policy.cron}
            onChange={(value) => patch("cron", value)}
            required
            description="Minute, hour, day of month, month, day of week. Example: 0 2 * * *."
          />
          <Field
            label="Schedule timezone"
            value={policy.timezone}
            onChange={(value) => patch("timezone", value)}
            required
            description="IANA timezone. Skipped local times are skipped; repeated local times run once at the earlier occurrence."
          />
          <div className="settings-inline">
            <Field
              label="Retention days"
              type="number"
              min={1}
              max={3650}
              value={String(policy.retentionDays)}
              onChange={(value) => patch("retentionDays", Number(value))}
              required
            />
            <Field
              label="Retained backup count"
              type="number"
              min={1}
              max={1000}
              value={String(policy.retentionCount)}
              onChange={(value) => patch("retentionCount", Number(value))}
              required
            />
            <Field
              label="Maximum runtime (seconds)"
              type="number"
              min={30}
              max={86400}
              value={String(policy.maxRuntimeSeconds)}
              onChange={(value) => patch("maxRuntimeSeconds", Number(value))}
              required
            />
          </div>
          <Toggle
            label="Notify on backup failure"
            selected={policy.notifications}
            onChange={(value) => patch("notifications", value)}
          />
          <p className="settings-muted">
            Destination: encrypted installation object storage. Its credentials
            are managed by an installation operator.
          </p>
          <Button
            variant="secondary"
            isDisabled={mutation.busy}
            onPress={async () => {
              const result = await mutation.run(
                () =>
                  write<{ occurrences: string[] }>(
                    `${path}/backup-policy/preview`,
                    "POST",
                    { cron: policy.cron, timezone: policy.timezone, count: 5 },
                  ),
                "Schedule preview complete.",
              );
              if (result.ok) setOccurrences(result.value.occurrences);
            }}
          >
            Preview next runs
          </Button>
          {occurrences.length > 0 && (
            <ol className="settings-preview">
              {occurrences.map((value) => (
                <li key={value}>
                  <DateLabel value={value} /> <small>{value}</small>
                </li>
              ))}
            </ol>
          )}
        </Form>
      </Section>
      <Section title="Recovery points">
        <Button
          isDisabled={mutation.busy}
          onPress={async () => {
            const result = await mutation.run(
              () => write<JobAccepted>(`${path}/backups`, "POST", {}),
              "Backup queued. Upload and restore validation must finish before success.",
            );
            if (result.ok) setJobId(result.value.jobId);
          }}
        >
          Back up now
        </Button>
        <Loading {...backups} retry={backups.reload} />
        <RecordList>
          {backups.data.map((backup) => (
            <Record
              key={backup.id}
              title={<DateLabel value={backup.createdAt} />}
              description={
                <>
                  <Status value={backup.state} /> · verified{" "}
                  <DateLabel value={backup.verifiedAt} />
                  {backup.sizeBytes !== undefined && (
                    <> · {(backup.sizeBytes / 1048576).toFixed(1)} MiB</>
                  )}
                  {backup.error && <p>{backup.error}</p>}
                </>
              }
            >
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  if (backup.jobId) setJobId(backup.jobId);
                }}
              >
                Inspect job
              </Button>
              <Button
                variant="secondary"
                size="sm"
                isDisabled={backup.state !== "succeeded"}
                onPress={() => {
                  setRestoreId(backup.id);
                  setRestorePreview(undefined);
                }}
              >
                Restore
              </Button>
              <Button
                variant="danger-soft"
                size="sm"
                isDisabled={mutation.busy || deletion.busy}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Delete recovery point?",
                      "Rootset preserves the last verified recovery point unless an authorised policy explicitly permits its removal.",
                      "Delete backup",
                    )
                  ) {
                    const accepted = await deletion.run(
                      () =>
                        write<JobAccepted>(
                          `${path}/backups/${backup.id}`,
                          "DELETE",
                        ),
                      "Backup deletion queued. Removal is confirmed only when the job succeeds.",
                    );
                    if (accepted.ok) setJobId(accepted.value.jobId);
                  }
                }}
              >
                Delete
              </Button>
            </Record>
          ))}
        </RecordList>
        {!backups.loading && !backups.error && !backups.data.length && (
          <Empty>No backups yet.</Empty>
        )}
      </Section>
      {restoreId && (
        <Section
          title="Restore backup"
          description="New-database restore is the default. Replacement restore requires a current recovery point, identity approval, and an atomic validated cutover."
        >
          <Form
            busy={mutation.busy}
            submit="Preview restore"
            onSubmit={async () => {
              const result = await mutation.run(
                () =>
                  write<NonNullable<typeof restorePreview>>(
                    `${path}/backups/${restoreId}/restore-preview`,
                    "POST",
                    {
                      mode: restoreMode,
                      name: restoreName || undefined,
                      targetDatabaseId:
                        restoreMode === "replace" ? targetId : undefined,
                    },
                  ),
                "Restore preview complete.",
              );
              if (result.ok) setRestorePreview(result.value);
            }}
          >
            <Choice
              label="Restore target"
              value={restoreMode}
              onChange={(value) => {
                setRestoreMode(value);
                setRestorePreview(undefined);
              }}
              options={[
                { value: "new", label: "Create a new database" },
                { value: "replace", label: "Replace an existing database" },
              ]}
            />
            {restoreMode === "new" ? (
              <Field
                label="New database name"
                value={restoreName}
                onChange={(value) => {
                  setRestoreName(value);
                  setRestorePreview(undefined);
                }}
                required
              />
            ) : (
              <Field
                label="Target database ID"
                value={targetId}
                onChange={(value) => {
                  setTargetId(value);
                  setRestorePreview(undefined);
                }}
                required
              />
            )}
          </Form>
          {restorePreview && (
            <div className="settings-preview">
              <p>
                {restorePreview.compatible === false
                  ? "This restore is not compatible."
                  : "Restore preview completed."}
              </p>
              {restorePreview.tableCount !== undefined && (
                <p>
                  {restorePreview.tableCount} tables ·{" "}
                  {restorePreview.rowCount?.toLocaleString()} rows
                </p>
              )}
              {restorePreview.warnings?.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              <Button
                isDisabled={
                  mutation.busy || restorePreview.compatible === false
                }
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Start restore?",
                      restoreMode === "replace"
                        ? "This replaces the target database after validation. Writes are blocked during publication and identity approval is required."
                        : "Rootset creates a separate database and exposes it after validation succeeds.",
                      "Start restore",
                    )
                  ) {
                    const result = await mutation.run(
                      () =>
                        restoreMode === "replace"
                          ? performAction<JobAccepted>("restoreBackup", {
                              orgId: props.orgId,
                              databaseId: props.databaseId,
                              id: restoreId,
                              mode: restoreMode,
                              targetDatabaseId: targetId,
                            })
                          : write<JobAccepted>(
                              `${path}/backups/${restoreId}/restores`,
                              "POST",
                              {
                                mode: restoreMode,
                                name: restoreName || undefined,
                                targetDatabaseId:
                                  restoreMode === "replace"
                                    ? targetId
                                    : undefined,
                              },
                            ),
                      "Restore queued.",
                    );
                    if (result.ok) setJobId(result.value.jobId);
                  }
                }}
              >
                Start restore
              </Button>
            </div>
          )}
        </Section>
      )}
      {jobId && (
        <Section title="Current backup, restore or deletion job">
          <JobTracker
            orgId={props.orgId}
            jobId={jobId}
            onTerminal={(job) => {
              if (job.state === "succeeded") {
                backups.reload();
                props.onChanged?.();
              }
            }}
          />
        </Section>
      )}
      {confirmation.dialog}
    </>
  );
}

export function csvHeaders(text: string): string[] {
  const headers: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      headers.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      headers.push(value);
      return headers;
    } else value += character;
  }
  if (quoted)
    throw new Error("The CSV header is incomplete or has an unclosed quote.");
  headers.push(value);
  return headers;
}

export function ImportsSettings(props: SettingsPanelProps) {
  const path =
    props.databaseId && props.tableId
      ? tablePath(props.orgId, props.databaseId, props.tableId)
      : undefined;
  const schema = useResource<TableSchemaResult | null>(
    path ? `${path}/schema` : undefined,
    null,
  );
  const mutation = useMutation(props.onChanged);
  const [file, setFile] = useState<File>();
  const [format, setFormat] = useState("csv");
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [artifactId, setArtifactId] = useState("");
  const [mode, setMode] = useState("create");
  const [uniqueRuleId, setUniqueRuleId] = useState("");
  const [rowIdColumn, setRowIdColumn] = useState("");
  const [jobId, setJobId] = useState("");
  const [validated, setValidated] = useState(false);
  const [validatedInput, setValidatedInput] = useState("");
  const [validationReport, setValidationReport] = useState<{
    valid: boolean;
    examined?: number;
    accepted?: number;
    rejected?: number;
    errors?: {
      record: number;
      field?: string;
      code: string;
      message: string;
    }[];
    reportArtifactId?: string;
  }>();
  if (!path) return <Empty>Select a table to import rows.</Empty>;
  async function chooseFile(next?: File) {
    setFile(next);
    setArtifactId("");
    setValidated(false);
    setColumns([]);
    setMapping({});
    if (!next) return;
    await mutation.run(async () => {
      if (next.size > 134217728)
        throw new Error("Choose a file of 128 MiB or less.");
      const text = await next.slice(0, 262144).text();
      const sourceColumns =
        format === "csv"
          ? csvHeaders(text.replace(/^\uFEFF/, ""))
          : Object.keys(
              JSON.parse(
                text.split(/\r?\n/).find((line) => line.trim()) ?? "{}",
              ),
            );
      if (new Set(sourceColumns).size !== sourceColumns.length)
        throw new Error("Source columns must have unique names.");
      setColumns(sourceColumns);
      setMapping(
        Object.fromEntries(
          sourceColumns
            .filter((column) =>
              schema.data?.fields.some((field) => field.apiKey === column),
            )
            .map((column) => [column, column]),
        ),
      );
    }, "Source columns read. Map the fields before uploading.");
  }
  function input() {
    return {
      artifactId,
      mapping: Object.fromEntries(
        Object.entries(mapping).filter(([, field]) => field),
      ),
      mode,
      expectedSchemaVersion: schema.data?.table.schemaVersion,
      ...(mode === "upsert"
        ? uniqueRuleId
          ? { uniqueRuleId }
          : { rowIdColumn }
        : {}),
      batchSize: 1000,
    };
  }
  const validationMatches =
    validated && validatedInput === JSON.stringify(input());
  return (
    <>
      <Loading {...schema} retry={schema.reload} />
      <Feedback {...mutation} />
      <Section
        title="Import source"
        description="Choose CSV or JSONL, then map columns to existing typed fields. Text identifiers and leading zeroes remain text. Large jobs commit checkpointed batches and report rejected rows."
      >
        <Choice
          label="Format"
          value={format}
          onChange={(value) => {
            setFormat(value);
            setFile(undefined);
            setColumns([]);
            setArtifactId("");
            setValidated(false);
          }}
          options={["csv", "jsonl"]}
        />
        <label className="settings-file">
          Source file
          <input
            type="file"
            accept={
              format === "csv" ? ".csv,text/csv" : ".jsonl,application/x-ndjson"
            }
            onChange={(event) => {
              void chooseFile(event.target.files?.[0]);
            }}
          />
        </label>
        {file && (
          <p>
            {file.name} · {(file.size / 1048576).toFixed(2)} MiB
          </p>
        )}
        <div className="settings-mapping">
          {columns.map((column) => (
            <Choice
              key={column}
              label={column || "(Empty column name)"}
              value={mapping[column] || "__skip"}
              onChange={(value) => {
                setMapping((previous) => ({
                  ...previous,
                  [column]: value === "__skip" ? "" : value,
                }));
                setValidated(false);
              }}
              options={[
                { value: "__skip", label: "Skip this source column" },
                ...(schema.data?.fields.map((field) => ({
                  value: field.apiKey,
                  label: `${field.label} (${field.type})`,
                })) ?? []),
              ]}
            />
          ))}
        </div>
        <Choice
          label="Write mode"
          value={mode}
          onChange={(value) => {
            setMode(value);
            setValidated(false);
          }}
          options={[
            { value: "create", label: "Create new rows" },
            {
              value: "upsert",
              label: "Update matching rows or create new rows",
            },
          ]}
        />
        {mode === "upsert" && (
          <>
            <Choice
              label="Match by unique rule"
              value={uniqueRuleId || "__rowid"}
              onChange={(value) => {
                setUniqueRuleId(value === "__rowid" ? "" : value);
                setValidated(false);
              }}
              options={[
                { value: "__rowid", label: "Use an explicit row ID column" },
                ...(schema.data?.uniqueRules
                  .filter((rule) => rule.state === "active")
                  .map((rule) => ({
                    value: rule.id,
                    label: (rule.fieldIds ?? [])
                      .map(
                        (id) =>
                          schema.data?.fields.find((field) => field.id === id)
                            ?.label ?? id,
                      )
                      .join(" + "),
                  })) ?? []),
              ]}
            />
            {!uniqueRuleId && (
              <Choice
                label="Source row ID column"
                value={rowIdColumn}
                onChange={(value) => {
                  setRowIdColumn(value);
                  setValidated(false);
                }}
                options={columns}
                required
              />
            )}
          </>
        )}
        <div className="settings-actions">
          <Button
            variant="secondary"
            isDisabled={mutation.busy || !file || !columns.length}
            onPress={async () => {
              const result = await mutation.run(async () => {
                const upload = await write<{
                  artifactId: string;
                  uploadUrl: string;
                  method: string;
                  headers: Record<string, string>;
                }>(`${path}/imports/uploads`, "POST", {
                  format,
                  byteLength: file!.size,
                });
                const destination = new URL(
                  upload.uploadUrl,
                  window.location.origin,
                );
                if (
                  destination.protocol !== "https:" &&
                  destination.origin !== window.location.origin
                )
                  throw new Error("The upload address must use HTTPS.");
                const response = await fetch(destination.href, {
                  method: upload.method ?? "PUT",
                  headers: upload.headers,
                  body: file,
                  credentials:
                    destination.origin === window.location.origin
                      ? "same-origin"
                      : "omit",
                });
                if (!response.ok)
                  throw new Error(`Upload failed (${response.status}).`);
                return upload.artifactId;
              }, "File uploaded. Run validation before importing.");
              if (result.ok) setArtifactId(result.value);
            }}
          >
            Upload file
          </Button>
          <Button
            variant="secondary"
            isDisabled={mutation.busy || !artifactId}
            onPress={async () => {
              setValidatedInput(JSON.stringify(input()));
              const result = await mutation.run(
                () =>
                  write<{
                    jobId?: string;
                    valid?: boolean;
                    examined?: number;
                    accepted?: number;
                    rejected?: number;
                    errors?: {
                      record: number;
                      field?: string;
                      code: string;
                      message: string;
                    }[];
                    reportArtifactId?: string;
                  }>(`${path}/imports/validate`, "POST", input()),
                "Validation requested. Review its terminal report.",
              );
              if (result.ok) {
                if (result.value.jobId) setJobId(result.value.jobId);
                if (result.value.valid !== undefined)
                  setValidationReport({
                    ...result.value,
                    valid: result.value.valid,
                  });
                setValidated(
                  result.value.valid === true &&
                    (result.value.rejected ?? 0) === 0,
                );
              }
            }}
          >
            Validate import
          </Button>
          <Button
            isDisabled={mutation.busy || !artifactId || !validationMatches}
            onPress={async () => {
              const result = await mutation.run(
                () => write<JobAccepted>(`${path}/imports`, "POST", input()),
                "Import queued.",
              );
              if (result.ok) {
                setJobId(result.value.jobId);
                setValidated(false);
              }
            }}
          >
            Import rows
          </Button>
        </div>
        {artifactId && !validationMatches && (
          <p className="settings-muted">
            Import is enabled after the current mapping passes validation. A
            validation job must finish first.
          </p>
        )}
        {validationReport && (
          <div className="settings-preview">
            <p>
              {validationReport.valid
                ? "The import validation passed."
                : "The import cannot proceed with this mapping."}{" "}
              · examined {validationReport.examined ?? 0}, accepted{" "}
              {validationReport.accepted ?? 0}, rejected{" "}
              {validationReport.rejected ?? 0}
            </p>
            {validationReport.errors?.map((error, index) => (
              <p key={index}>
                Record {error.record}
                {error.field && `, ${error.field}`}: {error.message} (
                {error.code})
              </p>
            ))}
            {validationReport.reportArtifactId && (
              <Button
                variant="secondary"
                onPress={() =>
                  mutation
                    .run(
                      () =>
                        downloadArtifact(
                          props.orgId,
                          validationReport.reportArtifactId!,
                        ),
                      "Validation report opened.",
                    )
                    .then(() => undefined)
                }
              >
                Download validation report
              </Button>
            )}
          </div>
        )}
      </Section>
      {jobId && (
        <Section title="Import or validation job">
          <JobTracker
            orgId={props.orgId}
            jobId={jobId}
            onTerminal={(job) => {
              if (job.state === "succeeded" && job.kind?.includes("validate"))
                setValidated(
                  (
                    job.result as
                      { valid?: boolean; rejected?: number } | undefined
                  )?.valid !== false &&
                    ((job.result as { rejected?: number } | undefined)
                      ?.rejected ?? 0) === 0,
                );
            }}
          />
        </Section>
      )}
    </>
  );
}

export function ExportsSettings(props: SettingsPanelProps) {
  const path =
    props.databaseId && props.tableId
      ? tablePath(props.orgId, props.databaseId, props.tableId)
      : undefined;
  const schema = useResource<TableSchemaResult | null>(
    path ? `${path}/schema` : undefined,
    null,
  );
  const mutation = useMutation();
  const [format, setFormat] = useState("csv");
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [jobId, setJobId] = useState("");
  if (!path) return <Empty>Select a table to export rows.</Empty>;
  return (
    <>
      <Loading {...schema} retry={schema.reload} />
      <Feedback {...mutation} />
      <Section
        title="Snapshot export"
        description="Exports use one consistent table snapshot. Every temporal value is UTC regardless of your viewing preference. Downloads recheck your current permissions."
      >
        <Form
          busy={mutation.busy}
          submit="Start export"
          onSubmit={async () => {
            const result = await mutation.run(
              () =>
                write<JobAccepted>(`${path}/exports`, "POST", {
                  format,
                  spreadsheetSafe: format === "csv" && spreadsheetSafe,
                  query: selected.length ? { select: selected } : {},
                }),
              "Export queued. Download is available after the job succeeds.",
            );
            if (result.ok) setJobId(result.value.jobId);
          }}
        >
          <Choice
            label="File format"
            value={format}
            onChange={setFormat}
            options={["csv", "jsonl"]}
          />
          {format === "csv" && (
            <Toggle
              label="Spreadsheet-safe CSV"
              selected={spreadsheetSafe}
              onChange={setSpreadsheetSafe}
              description="Explicitly escape formula-like values for spreadsheet viewing. Stored data is unchanged."
            />
          )}
          <fieldset className="settings-scope-list">
            <legend>Fields to export (none selected means all fields)</legend>
            {schema.data?.fields.map((field) => (
              <Toggle
                key={field.id}
                label={`${field.label} (${field.apiKey})`}
                selected={selected.includes(field.apiKey)}
                onChange={(include) =>
                  setSelected((previous) =>
                    include
                      ? [...previous, field.apiKey]
                      : previous.filter((value) => value !== field.apiKey),
                  )
                }
              />
            ))}
          </fieldset>
        </Form>
      </Section>
      {jobId && (
        <Section title="Export job">
          <JobTracker orgId={props.orgId} jobId={jobId} />
        </Section>
      )}
    </>
  );
}
