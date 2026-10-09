"use client";

import { ProgressBar } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import {
  browserArtifactDownloadPath,
  browserApiOrigin,
} from "@rootset/web-client";
import { useEffect, useRef, useState } from "react";
import {
  organisationPath,
  read,
  tablePath,
  useMutation,
  useResource,
  write,
} from "./api";
import {
  Choice,
  Empty,
  Feedback,
  Form,
  Loading,
  Record,
  Section,
  Status,
  Toggle,
  useConfirmation,
} from "./ui";
import { JobResultDetails } from "./job-result";
import type {
  Artifact,
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
            <JobResultDetails
              result={resource.data.result}
              openArtifact={(id, kind) => {
                void mutation.run(
                  () => downloadArtifact(orgId, id),
                  kind === "result" ? "Download opened." : "Report opened.",
                );
              }}
            />
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
              schema.data?.fields.some((field) => field.name === column),
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
                  value: field.name,
                  label: `${field.name} (${field.type})`,
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
                            ?.name ?? id,
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
                  browserApiOrigin(),
                );
                if (destination.origin !== browserApiOrigin())
                  throw new Error(
                    "The upload address must match the API origin.",
                  );
                const response = await fetch(destination.href, {
                  method: upload.method ?? "PUT",
                  headers: upload.headers,
                  body: file,
                  credentials: "include",
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
                label={`${field.name} (${field.type})`}
                selected={selected.includes(field.name)}
                onChange={(include) =>
                  setSelected((previous) =>
                    include
                      ? [...previous, field.name]
                      : previous.filter((value) => value !== field.name),
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
