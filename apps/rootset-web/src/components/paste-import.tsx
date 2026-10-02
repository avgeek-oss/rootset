"use client";

import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { client } from "@rootset/web-client";
import type { JsonValue, QueryResult, QuerySpec } from "@rootset/contracts";
import type { Job } from "./settings/types";
import { MutationAttempt } from "../lib/mutation-attempt";
import { JobTracker } from "./settings/jobs";

interface ImportReport {
  valid: boolean;
  examined: number;
  accepted: number;
  rejected: number;
  errors: { record: number; field?: string; message: string }[];
}
interface AcceptedJob {
  jobId: string;
  state: string;
  statusUrl: string;
}

export function PasteImport({
  orgId,
  databaseId,
  tableId,
  schemaVersion,
  values,
  query,
  start,
  onCommitted,
}: {
  orgId: string;
  databaseId: string;
  tableId: string;
  schemaVersion: number;
  values: Record<string, JsonValue>[];
  query: QuerySpec;
  start: number;
  onCommitted: () => void;
}) {
  const [mode, setMode] = useState<"upsert" | "create">("upsert");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState<Record<string, unknown>>();
  const [report, setReport] = useState<ImportReport>();
  const [job, setJob] = useState<{
    id: string;
    kind: "validation" | "import";
  }>();
  const attempt = useRef(new MutationAttempt());
  const epoch = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      epoch.current++;
      abort.current?.abort();
    },
    [],
  );

  function changeMode(next: "upsert" | "create") {
    epoch.current++;
    abort.current?.abort();
    setMode(next);
    setInput(undefined);
    setReport(undefined);
    setJob(undefined);
    setError("");
    setBusy(false);
    attempt.current.clear();
  }

  async function prepare() {
    setBusy(true);
    setError("");
    setInput(undefined);
    setReport(undefined);
    setJob(undefined);
    const revision = ++epoch.current;
    const controller = new AbortController();
    abort.current = controller;
    const options = { signal: controller.signal };
    try {
      const records: Record<string, JsonValue>[] = [];
      if (mode === "upsert") {
        let offset = 0,
          sessionId: string | undefined;
        while (offset < values.length) {
          const page = await client.request<
            QueryResult & { window: { sessionId: string; start: number } }
          >(`/tables/${tableId}/windows/query`, {
            method: "POST",
            body: {
              orgId,
              databaseId,
              query: {
                ...query,
                select: [],
                cursor: undefined,
                limit: Math.min(200, values.length - offset),
              },
              position: start + offset === 0 ? "first" : start + offset,
              ...(sessionId ? { sessionId } : {}),
            },
            ...options,
          });
          if (revision !== epoch.current) return;
          sessionId = page.window.sessionId;
          if (page.window.start !== start + offset || !page.data.length)
            throw new Error(
              "This paste extends beyond the existing rows. Choose Create new rows, or use a smaller update selection.",
            );
          for (const row of page.data)
            records.push({ ...values[offset++]!, __ROOTSET_ROW_ID: row.id });
          if (offset < values.length && !page.page.hasMore)
            throw new Error(
              "This paste extends beyond the existing rows. Choose Create new rows, or use a smaller update selection.",
            );
        }
      } else records.push(...values);
      const blob = new Blob(
        [records.map((record) => JSON.stringify(record)).join("\n") + "\n"],
        { type: "application/x-ndjson" },
      );
      const upload = await client.operation<{
        artifactId: string;
        uploadUrl: string;
        maxBytes: number;
        method: "PUT";
        headers: Record<string, string>;
      }>(
        "prepareImportUpload",
        { orgId, databaseId, tableId, format: "jsonl", byteLength: blob.size },
        options,
      );
      const destination = new URL(upload.uploadUrl, location.origin);
      if (
        destination.protocol !== "https:" &&
        destination.origin !== location.origin
      )
        throw new Error("The import upload address must use HTTPS.");
      const uploaded = await fetch(destination.href, {
        method: upload.method,
        headers: upload.headers,
        body: blob,
        credentials:
          destination.origin === location.origin ? "same-origin" : "omit",
        signal: controller.signal,
      });
      if (!uploaded.ok)
        throw new Error(
          `Clipboard upload failed (${uploaded.status}). Retry validation.`,
        );
      const prepared = {
        orgId,
        databaseId,
        tableId,
        artifactId: upload.artifactId,
        format: "jsonl",
        expectedSchemaVersion: schemaVersion,
        mapping: Object.fromEntries(
          Object.keys(values[0] ?? {}).map((key) => [key, key]),
        ),
        mode,
        ...(mode === "upsert" ? { rowIdColumn: "__ROOTSET_ROW_ID" } : {}),
        batchSize: 1000,
      };
      const validation = await client.operation<ImportReport | AcceptedJob>(
        "validateImport",
        prepared,
        options,
      );
      if (revision !== epoch.current) return;
      setInput(prepared);
      if ("jobId" in validation)
        setJob({ id: validation.jobId, kind: "validation" });
      else setReport(validation);
    } catch (failure) {
      if (
        revision === epoch.current &&
        !(failure instanceof Error && failure.name === "AbortError")
      )
        setError(
          failure instanceof Error
            ? failure.message
            : "Paste validation failed.",
        );
    } finally {
      if (revision === epoch.current) setBusy(false);
    }
  }

  async function commit() {
    if (!input || !report?.valid || report.rejected || busy) return;
    setBusy(true);
    setError("");
    try {
      const accepted = await client.operation<AcceptedJob>(
        "importRows",
        input,
        { idempotencyKey: attempt.current.forInput(input) },
      );
      attempt.current.clear();
      setReport(undefined);
      setJob({ id: accepted.jobId, kind: "import" });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The paste import could not start.",
      );
    } finally {
      setBusy(false);
    }
  }

  function terminal(result: Job) {
    if (job?.kind === "import") {
      if (
        result.state === "succeeded" ||
        result.state === "partially_completed"
      )
        onCommitted();
      return;
    }
    if (result.state !== "succeeded") return;
    const value = result.result;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("valid" in value) ||
      typeof value.valid !== "boolean"
    ) {
      setError(
        "The validation job did not return a usable report. Retry validation.",
      );
      return;
    }
    setReport(value as unknown as ImportReport);
  }

  const active = job?.kind === "import";
  return (
    <div className="paste-import">
      <p>
        This paste runs as a background import with checkpointed batches. Review
        validation before starting. Completed batches remain committed if a
        later batch fails.
      </p>
      <label>
        Paste write mode
        <select
          aria-label="Paste write mode"
          value={mode}
          disabled={busy || active}
          onChange={(event) =>
            changeMode(event.target.value as "upsert" | "create")
          }
        >
          <option value="upsert">Update the selected existing rows</option>
          <option value="create">Create new rows</option>
        </select>
      </label>
      <p className="muted">
        {mode === "upsert"
          ? `Updates start at logical row ${(start + 1).toLocaleString()} in the current filtered and sorted view. Validation captures their internal IDs; later changes to those records can affect the job. Deleted target IDs are rejected.`
          : "Creates new rows without changing existing rows. Required columns must be supplied or have defaults."}
      </p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {report && (
        <div role="status">
          <p>
            {report.examined.toLocaleString()} examined ·{" "}
            {report.accepted.toLocaleString()} accepted ·{" "}
            {report.rejected.toLocaleString()} rejected.
          </p>
          {report.errors?.slice(0, 20).map((entry, index) => (
            <p key={index}>
              Row {entry.record}: {entry.message}
            </p>
          ))}
        </div>
      )}
      {!active && (
        <div className="dialog-actions">
          <Button
            variant="secondary"
            isDisabled={busy || (job?.kind === "validation" && !report)}
            onPress={() => void prepare()}
          >
            {busy ? "Preparing…" : "Upload and validate paste"}
          </Button>
          <Button
            isDisabled={busy || !input || !report?.valid || !!report.rejected}
            onPress={() => void commit()}
          >
            Start paste import
          </Button>
        </div>
      )}
      {job && <JobTracker orgId={orgId} jobId={job.id} onTerminal={terminal} />}
    </div>
  );
}
