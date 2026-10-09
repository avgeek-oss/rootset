"use client";

import { ProgressBar } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { browserArtifactDownloadPath } from "@rootset/web-client";
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
  Form,
  Loading,
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
              openArtifact={(id) => {
                void mutation.run(
                  () => downloadArtifact(orgId, id),
                  "Download opened.",
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
                      "Rootset stops the job at a safe checkpoint.",
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
