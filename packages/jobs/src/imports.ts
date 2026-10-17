import {
  ImportSourceSchema,
  JsonValueSchema,
  RootsetError,
  importLimits,
  parseImportSource,
  prepareImportRows,
  type Actor,
  type ImportIssue,
  type JsonValue,
} from "@rootset/contracts";
import { withOrg, type PoolClient } from "@rootset/database";
import type { ArtifactStore } from "./artifacts.js";
import type { DurableQueue } from "./queue.js";
import type { JobRecord, JobsConfig, StoragePort } from "./types.js";

export class TableImports {
  constructor(
    private readonly storage: StoragePort,
    private readonly queue: DurableQueue,
    private readonly artifacts: ArtifactStore,
    private readonly config: JobsConfig,
    private readonly check: (job: JobRecord) => Promise<Actor>,
  ) {}

  async committedResult(job: JobRecord): Promise<JsonValue | undefined> {
    if (!this.queue.authenticInput(job)) return undefined;
    return withOrg(this.queue.workerPool, job.org_id, async (client) => {
      const result = (
        await client.query<{ result: JsonValue }>(
          "SELECT result FROM rootset_control.operation_outcomes WHERE job_id=$1 AND org_id=$2 AND operation_id=$3 AND job_input_digest=$4",
          [job.id, job.org_id, job.operation_id, job.input_digest],
        )
      ).rows[0];
      return result?.result;
    });
  }

  async source(
    actor: Actor,
    previewId: string,
    tableId: string,
  ): Promise<JobRecord> {
    const preview = await withOrg(
      this.queue.pool,
      actor.orgId,
      async (client) =>
        (
          await client.query<JobRecord>(
            "SELECT * FROM rootset_control.jobs WHERE id=$1 AND org_id=$2",
            [previewId, actor.orgId],
          )
        ).rows[0],
    );
    if (
      !preview ||
      preview.kind !== "import_preview" ||
      preview.target_type !== "table" ||
      preview.target_id !== tableId ||
      (actor.role !== "admin" &&
        preview.requester_id !== `${actor.kind}:${actor.id}` &&
        (!actor.userId || actor.userId !== preview.actor.userId))
    )
      throw new RootsetError(
        "RESOURCE_NOT_FOUND",
        "Import preview was not found",
        404,
      );
    if (
      !this.queue.authenticInput(preview) ||
      preview.state !== "succeeded" ||
      !preview.result ||
      typeof preview.result !== "object" ||
      Array.isArray(preview.result) ||
      preview.result.invalid !== 0
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Validate the file and correct all errors before importing",
        422,
      );
    return preview;
  }

  private async report(job: JobRecord, issues: ImportIssue[]) {
    const actor = await this.check(job);
    const artifact = await this.artifacts.write(
      actor,
      job,
      { type: "table", id: job.target_id },
      "import_report",
      "jsonl",
      "application/x-ndjson",
      (async function* () {
        for (const issue of issues) yield `${JSON.stringify(issue)}\n`;
      })(),
      { rowCount: issues.length },
      {
        beforePublish: async () => {
          await this.check(job);
        },
      },
    );
    return artifact.id;
  }

  private async outcome(client: PoolClient, job: JobRecord, result: JsonValue) {
    await client.query(
      "INSERT INTO rootset_control.operation_outcomes(job_id,org_id,operation_id,job_input_digest,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id) DO NOTHING",
      [job.id, job.org_id, job.operation_id, job.input_digest, result],
    );
  }

  async run(job: JobRecord): Promise<JsonValue> {
    if (!this.queue.authenticInput(job))
      throw new RootsetError(
        "JOB_FAILED",
        "Import request integrity check failed",
        409,
      );
    let actor = await this.check(job);
    const preview =
      job.kind === "import_preview"
        ? job
        : await this.source(actor, String(job.input.previewId), job.target_id);
    const source = ImportSourceSchema.parse({
      format: preview.input.format,
      content: preview.input.content,
      fileName: preview.input.fileName,
      mapping: preview.input.mapping,
    });
    const table = await this.storage.getTable(actor, job.target_id);
    if (
      table.schemaVersion !== job.input.expectedSchemaVersion ||
      table.schemaVersion !== preview.input.expectedSchemaVersion
    )
      throw new RootsetError(
        "SCHEMA_VERSION_CONFLICT",
        "The table schema changed. Reload the schema and validate the file again",
        409,
      );
    const rows = prepareImportRows(
      parseImportSource(source.format, source.content),
      source.mapping,
      table.fields,
    );
    const next = job.kind === "import" ? Number(job.checkpoint.next ?? 0) : 0;
    if (
      !Number.isSafeInteger(next) ||
      next < 0 ||
      next > rows.length ||
      next % importLimits.batch !== 0
    )
      throw new RootsetError(
        "JOB_FAILED",
        "The import checkpoint is invalid",
        409,
      );
    const remaining = rows.slice(next);
    const issues = await this.storage.validateImportRows(
      actor,
      table.id,
      { rows: remaining, expectedSchemaVersion: table.schemaVersion },
      {
        check: async () => {
          actor = await this.check(job);
          return actor;
        },
        progress: (completed) =>
          this.queue.checkpoint(
            job,
            { ...job.checkpoint, next },
            {
              completed: next + completed,
              committed: next,
              total: rows.length,
              unit: "records",
            },
            "validating",
          ),
      },
    );
    if (job.kind === "import_preview") {
      const reportArtifactId = issues.length
        ? await this.report(job, issues)
        : undefined;
      const sample: { line: number; values: Record<string, JsonValue> }[] = [];
      let bytes = 0;
      const invalidLines = new Set(issues.map((issue) => issue.line));
      for (const row of rows) {
        if (invalidLines.has(row.line)) continue;
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (sample.length >= 10 || bytes > 128 * 1024) break;
        sample.push({ line: row.line, values: row.values });
      }
      const result = JsonValueSchema.parse({
        total: rows.length,
        valid: rows.length - issues.length,
        invalid: issues.length,
        schemaVersion: table.schemaVersion,
        fileName: source.fileName,
        preview: sample,
        issues: issues.slice(0, 100),
        ...(reportArtifactId ? { reportArtifactId } : {}),
      });
      await this.check(job);
      await this.queue.fenced(job, (client) =>
        this.outcome(client, job, result),
      );
      return result;
    }
    if (issues.length) {
      const reportArtifactId = await this.report(job, issues);
      throw new RootsetError(
        "IMPORT_VALIDATION_FAILED",
        "The import is blocked by validation errors. Download the report, correct the data and retry",
        422,
        {
          reportArtifactId,
          issues: issues.slice(0, 100),
          rejected: issues.length,
        },
      );
    }
    for (
      let offset = next;
      offset < rows.length;
      offset += importLimits.batch
    ) {
      actor = await this.check(job);
      const batch = rows.slice(offset, offset + importLimits.batch);
      const completed = offset + batch.length;
      const result: JsonValue = {
        committed: completed,
        total: rows.length,
        rejected: 0,
        fileName: source.fileName,
        previewId: preview.id,
      };
      try {
        await this.storage.mutateRows(actor, table.id, {
          operations: batch.map((row) => ({
            kind: "create" as const,
            values: row.values,
          })),
          expectedSchemaVersion: table.schemaVersion,
          idempotencyKey: `import:${job.id}:${offset}`,
          context: {
            source: "import",
            jobId: job.id,
            jobFence: { jobId: job.id, leaseToken: job.lease_token! },
            beforePublish: async () => {
              await this.check(job);
            },
          },
          onCommit: async (client) => {
            const saved = await client.query(
              "UPDATE rootset_control.jobs SET checkpoint=$2,progress=$3,stage='importing',updated_at=now() WHERE id=$1 AND lease_token=$4 AND state='running' AND lease_until>clock_timestamp() AND NOT cancel_requested",
              [
                job.id,
                { next: completed },
                {
                  completed,
                  committed: completed,
                  total: rows.length,
                  unit: "records",
                },
                job.lease_token,
              ],
            );
            if (!saved.rowCount)
              throw new RootsetError(
                "JOB_LEASE_LOST",
                "The import worker lost its lease",
                409,
              );
            if (completed === rows.length)
              await this.outcome(client, job, result);
          },
        });
      } catch (error) {
        if (
          !(error instanceof RootsetError) ||
          ![
            "VALIDATION_FAILED",
            "UNIQUE_CONFLICT",
            "FOREIGN_KEY_CONFLICT",
            "AUTO_INCREMENT_EXHAUSTED",
            "ROW_SIZE_LIMIT",
          ].includes(error.code)
        )
          throw error;
        const conflicts = await this.storage.validateImportRows(
          actor,
          table.id,
          {
            rows: rows.slice(offset),
            expectedSchemaVersion: table.schemaVersion,
          },
          { check: () => this.check(job), progress: async () => {} },
        );
        const reportArtifactId = await this.report(
          job,
          conflicts.length
            ? conflicts
            : [
                {
                  line: batch[0]!.line,
                  code: error.code,
                  message: error.message,
                },
              ],
        );
        throw new RootsetError(
          "IMPORT_VALIDATION_FAILED",
          "A constraint changed while importing. Committed records are kept; download the report before retrying",
          409,
          {
            reportArtifactId,
            issues: conflicts.slice(0, 100),
            rejected: conflicts.length || 1,
          },
        );
      }
      job.checkpoint = { next: completed };
      job.progress = {
        completed,
        committed: completed,
        total: rows.length,
        unit: "records",
      };
      await this.config.failpoint?.("import.afterBatch", job.id);
    }
    return {
      committed: rows.length,
      total: rows.length,
      rejected: 0,
      fileName: source.fileName,
      previewId: preview.id,
    };
  }
}
