import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { parse } from "csv-parse";
import { withOrg } from "@rootset/database";
import {
  RootsetError,
  validateValues,
  assertRowBytes,
  canonicalJson,
  parseStrictJson,
  analyseNumberLexeme,
  assertValueLexemes,
  IdSchema,
  type Actor,
  type FieldDefinition,
  type JsonValue,
  type Row,
  type NumberLexeme,
} from "@rootset/contracts";
import type { ArtifactStore } from "./artifacts.js";
import { DurableQueue } from "./queue.js";
import type {
  ArtifactRecord,
  JobRecord,
  StoragePort,
  TableInfo,
} from "./types.js";
import type { RowOperation } from "@rootset/table-storage";

interface ImportInput {
  tableId: string;
  artifactId: string;
  expectedSchemaVersion: number;
  mapping: Record<string, string>;
  mode: "create" | "upsert";
  uniqueRuleId?: string;
  rowIdColumn?: string;
  atomic?: boolean;
  batchSize?: number;
  nullValue?: string;
}
interface Rejection {
  record: number;
  code: string;
  message: string;
  field?: string;
}
interface Planned {
  record: number;
  operation?: Record<string, unknown>;
  rejection?: Rejection;
}
interface Batch {
  start: number;
  end: number;
  planned: Planned[];
}
interface SourceRecord {
  record: number;
  values: Record<string, unknown>;
  numberLexemes?: NumberLexeme[];
  sourceError?: RootsetError;
}

function importInput(input: Record<string, unknown>): ImportInput {
  const mapping = input.mapping as Record<string, string>;
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    Object.keys(mapping).length > 200 ||
    Object.values(mapping).some((value) => typeof value !== "string") ||
    new Set(Object.values(mapping)).size !== Object.values(mapping).length
  )
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Import mapping must map distinct source columns to distinct field API keys",
    );
  if (!["create", "upsert"].includes(String(input.mode)))
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Import mode must be create or upsert",
    );
  if (input.mode === "upsert" && !input.uniqueRuleId && !input.rowIdColumn)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Upsert requires an active unique rule or an explicit row-ID column",
    );
  if (input.uniqueRuleId && input.rowIdColumn)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Select one upsert identity strategy",
    );
  const batchSize = Number(input.batchSize ?? 200);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Import batch size must be 1-1000",
    );
  return {
    ...input,
    mapping,
    batchSize,
    nullValue: typeof input.nullValue === "string" ? input.nullValue : "\\N",
  } as unknown as ImportInput;
}

function decodeCsv(
  field: FieldDefinition,
  value: string,
  nullValue: string,
): JsonValue {
  if (value === nullValue) return null;
  if (field.type === "text" && value.startsWith("\\\\")) return value.slice(1);
  if (
    field.type === "text" ||
    field.type === "date" ||
    field.type === "time" ||
    field.type === "date-time"
  )
    return value;
  if (field.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new RootsetError(
      "VALIDATION_FAILED",
      `CSV boolean ${field.apiKey} must be true or false`,
    );
  }
  if (field.type === "json") return parseStrictJson(value, { maxBytes: 65536 });
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))
    throw new RootsetError(
      "VALIDATION_FAILED",
      `CSV numeric ${field.apiKey} has invalid JSON number syntax`,
    );
  if (field.type === "integer") {
    const information = analyseNumberLexeme(value);
    if (!information.integer || !information.safeInteger)
      throw new RootsetError(
        "VALIDATION_FAILED",
        `CSV integer ${field.apiKey} requires a lossless safe integer`,
      );
    return information.value;
  }
  return parseStrictJson(value, { maxBytes: 128, safeIntegers: false });
}

function strictUtf8(): Transform {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        callback(null, decoder.decode(chunk, { stream: true }));
      } catch {
        callback(
          new RootsetError(
            "VALIDATION_FAILED",
            "Import file contains invalid UTF-8",
          ),
        );
      }
    },
    flush(callback) {
      try {
        callback(null, decoder.decode());
      } catch {
        callback(
          new RootsetError(
            "VALIDATION_FAILED",
            "Import file ends with invalid UTF-8",
          ),
        );
      }
    },
  });
}

async function* boundedLines(stream: Readable): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of stream) {
    pending += String(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      let line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line) > 1024 * 1024)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "JSONL record exceeds the one-megabyte source record budget",
        );
      yield line;
    }
    if (Buffer.byteLength(pending) > 1024 * 1024)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "JSONL record exceeds the one-megabyte source record budget",
      );
  }
  if (pending) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
}

export async function* importRecords(
  stream: Readable,
  format: string,
  options: { safeIntegers?: boolean; recoverInvalidRecords?: boolean } = {},
): AsyncGenerator<SourceRecord> {
  const text = stream.pipe(strictUtf8());
  let record = 0;
  if (format === "csv") {
    const parser = parse({
      bom: true,
      columns: (headers: string[]) => {
        if (
          !headers.length ||
          headers.some((header) => !header) ||
          new Set(headers).size !== headers.length
        )
          throw new RootsetError(
            "VALIDATION_FAILED",
            "CSV headers must be nonempty and distinct",
          );
        return headers;
      },
      max_record_size: 1024 * 1024,
      relax_column_count: false,
      skip_empty_lines: true,
    });
    text.on("error", (error) => parser.destroy(error));
    text.pipe(parser);
    try {
      for await (const values of parser)
        yield { record: ++record, values: values as Record<string, string> };
    } catch (error) {
      if (error instanceof RootsetError) throw error;
      throw new RootsetError(
        "VALIDATION_FAILED",
        "CSV quoting, headers or record size is invalid",
        422,
        { record: record + 1 },
      );
    }
  } else if (format === "jsonl") {
    try {
      for await (const line of boundedLines(text)) {
        record++;
        if (!line.trim()) continue;
        try {
          const numberLexemes: NumberLexeme[] = [];
          const values = parseStrictJson(line, {
            maxBytes: 1024 * 1024,
            maxDepth: 34,
            safeIntegers: options.safeIntegers ?? true,
            onNumber: (information) => numberLexemes.push(information),
          });
          if (!values || typeof values !== "object" || Array.isArray(values))
            throw new RootsetError(
              "VALIDATION_FAILED",
              "JSONL records must be objects",
              422,
              { record },
            );
          yield { record, values, numberLexemes };
        } catch (error) {
          if (!(error instanceof RootsetError)) throw error;
          if (!options.recoverInvalidRecords)
            throw new RootsetError(error.code, error.message, error.status, {
              record,
            });
          yield { record, values: {}, sourceError: error };
        }
      }
    } catch (error) {
      if (error instanceof RootsetError) {
        const details =
          error.details &&
          typeof error.details === "object" &&
          !Array.isArray(error.details)
            ? error.details
            : {};
        throw new RootsetError(error.code, error.message, error.status, {
          ...details,
          record:
            typeof details.record === "number"
              ? details.record
              : Math.max(1, record + 1),
        });
      }
      throw error;
    }
  } else
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Import format must be csv or jsonl",
    );
}

export class ImportRunner {
  constructor(
    readonly queue: DurableQueue,
    readonly artifacts: ArtifactStore,
    readonly storage: StoragePort,
    readonly failpoint?: (point: string, jobId: string) => Promise<void>,
    readonly recheck?: (job: JobRecord) => Promise<Actor>,
  ) {}

  private async plan(
    actor: Actor,
    table: TableInfo,
    input: ImportInput,
    source: SourceRecord,
    format: string,
  ): Promise<Planned> {
    try {
      if (source.sourceError) throw source.sourceError;
      if (source.numberLexemes)
        assertValueLexemes(
          table.fields,
          source.numberLexemes
            .filter(
              (information) =>
                typeof information.path[0] === "string" &&
                Object.hasOwn(input.mapping, information.path[0]),
            )
            .map((information) => ({
              ...information,
              path: [
                input.mapping[String(information.path[0])]!,
                ...information.path.slice(1),
              ],
            })),
          [],
        );
      const values: Record<string, JsonValue> = {};
      for (const [column, fieldKey] of Object.entries(input.mapping)) {
        const field = table.fields.find(
          (candidate) => candidate.apiKey === fieldKey,
        );
        if (!field)
          throw new RootsetError(
            "VALIDATION_FAILED",
            `Mapping references unknown field ${fieldKey}`,
          );
        if (Object.hasOwn(source.values, column))
          values[fieldKey] =
            format === "csv"
              ? decodeCsv(
                  field,
                  String(source.values[column]),
                  input.nullValue!,
                )
              : (source.values[column] as JsonValue);
      }
      const existing =
        input.mode === "upsert"
          ? await this.resolve(actor, table, input, source.values, values)
          : null;
      const validated = validateValues(
        table.fields,
        values,
        existing ? "patch" : "create",
      );
      assertRowBytes(
        table.fields,
        existing ? { ...existing.values, ...validated } : validated,
      );
      return {
        record: source.record,
        operation: existing
          ? {
              kind: "update",
              rowId: existing.id,
              expectedVersion: existing.version,
              values: validated,
            }
          : { kind: "create", values: validated },
      };
    } catch (error) {
      return {
        record: source.record,
        rejection:
          error instanceof RootsetError
            ? {
                record: source.record,
                code: error.code,
                message: error.message,
                ...(error.details &&
                typeof error.details === "object" &&
                !Array.isArray(error.details) &&
                typeof error.details.field === "string"
                  ? { field: error.details.field }
                  : {}),
              }
            : {
                record: source.record,
                code: "VALIDATION_FAILED",
                message: "Record could not be interpreted",
              },
      };
    }
  }

  private async resolve(
    actor: Actor,
    table: TableInfo,
    input: ImportInput,
    source: Record<string, unknown>,
    values: Record<string, JsonValue>,
  ): Promise<Row | null> {
    if (input.rowIdColumn) {
      if (!source[input.rowIdColumn])
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Explicit row-ID upsert requires a row ID on every record",
        );
      const rowId = IdSchema.parse(source[input.rowIdColumn]);
      if (!this.storage.getRow)
        throw new RootsetError(
          "CONFIGURATION_INVALID",
          "Row identity lookup is unavailable",
          500,
        );
      try {
        return await this.storage.getRow(actor, table.id, rowId);
      } catch (error) {
        if (
          error instanceof RootsetError &&
          error.code === "RESOURCE_NOT_FOUND"
        )
          throw new RootsetError(
            "RESOURCE_NOT_FOUND",
            "Explicit upsert row ID does not exist",
            404,
          );
        throw error;
      }
    }
    const rule = (await this.storage.listUniqueRules(actor, table.id)).find(
      (candidate) =>
        candidate.id === input.uniqueRuleId && candidate.state === "active",
    );
    if (!rule || !Array.isArray(rule.fieldIds))
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Upsert requires an active declared unique rule",
      );
    const predicates = rule.fieldIds.map((fieldId) => {
      const field = table.fields.find((candidate) => candidate.id === fieldId);
      if (
        !field ||
        !Object.hasOwn(values, field.apiKey) ||
        values[field.apiKey] === null
      )
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Every unique-rule field must be supplied and non-null for upsert",
        );
      return {
        field: field.apiKey,
        op: "eq" as const,
        value: values[field.apiKey]!,
      };
    });
    const found = await this.storage.queryRows(actor, table.id, {
      where: { and: predicates },
      limit: 2,
    });
    if (found.data.length > 1)
      throw new RootsetError(
        "UNIQUE_CONFLICT",
        "Upsert matched more than one row",
        409,
      );
    return found.data[0] ?? null;
  }

  async run(
    actor: Actor,
    job: JobRecord,
    artifact: ArtifactRecord,
    dryRun: boolean,
  ): Promise<JsonValue> {
    const input = importInput(job.input);
    const table = await this.storage.getTable(actor, input.tableId);
    if (table.schemaVersion !== input.expectedSchemaVersion)
      throw new RootsetError(
        "SCHEMA_VERSION_CONFLICT",
        "Import schema version changed",
        409,
      );
    const opened = await this.artifacts.openVerified(actor, artifact);
    try {
      if (dryRun)
        return await this.validate(
          actor,
          job,
          table,
          input,
          artifact,
          opened.stream,
        );
      let offset = Number(job.checkpoint.record ?? 0);
      let committed = Number(job.progress.committed ?? 0);
      let rejected = Number(job.progress.rejected ?? 0);
      let batch: Batch = { start: offset + 1, end: offset, planned: [] };
      let batchBytes = 0;
      const flush = async () => {
        if (!batch.planned.length) return;
        const saved = await this.persistPlan(job, batch);
        await this.failpoint?.("import.afterPlan", job.id);
        const outcome = await this.commitBatch(actor, job, input, saved);
        await this.failpoint?.("import.afterCommit", job.id);
        offset = saved.end;
        await this.queue.fenced(job, async (client) => {
          const current = (
            await client.query<JobRecord>(
              "SELECT * FROM rootset_control.jobs WHERE id=$1",
              [job.id],
            )
          ).rows[0]!;
          committed = Number(current.progress.committed ?? 0);
          rejected = Number(current.progress.rejected ?? 0);
          await client.query(
            "UPDATE rootset_control.import_batches SET state='committed',progress=$3 WHERE job_id=$1 AND start_record=$2",
            [job.id, saved.start, outcome],
          );
          await client.query(
            "UPDATE rootset_control.jobs SET checkpoint=$2,progress=$3,stage=$4,updated_at=now() WHERE id=$1",
            [
              job.id,
              { ...job.checkpoint, record: offset, artifactId: artifact.id },
              { completed: offset, committed, rejected, unit: "records" },
              "importing",
            ],
          );
        });
        job.checkpoint = {
          ...job.checkpoint,
          record: offset,
          artifactId: artifact.id,
        };
        job.progress = {
          completed: offset,
          committed,
          rejected,
          unit: "records",
        };
        batch = { start: offset + 1, end: offset, planned: [] };
        batchBytes = 0;
      };
      const priorPlan = await withOrg(
        this.queue.workerPool,
        actor.orgId,
        async (client) =>
          (
            await client.query<{ plan: Batch }>(
              "SELECT plan FROM rootset_control.import_batches WHERE job_id=$1 AND start_record=$2 AND state='planned'",
              [job.id, offset + 1],
            )
          ).rows[0]?.plan,
      );
      if (priorPlan) {
        batch = priorPlan;
        await flush();
      }
      for await (const source of importRecords(opened.stream, artifact.format, {
        safeIntegers: false,
        recoverInvalidRecords: true,
      })) {
        if (source.record <= offset) continue;
        const planned = await this.plan(
          actor,
          table,
          input,
          source,
          artifact.format,
        );
        const bytes = Buffer.byteLength(
          canonicalJson(planned, { maxDepth: 96 }),
        );
        if (
          input.atomic &&
          (batch.planned.length >= 1000 || batchBytes + bytes > 7 * 1024 ** 2)
        )
          throw new RootsetError(
            "PAYLOAD_TOO_LARGE",
            "Atomic imports must fit 1000 records and the synchronous request budget",
            413,
          );
        if (
          !input.atomic &&
          (batch.planned.length >= input.batchSize! ||
            batchBytes + bytes > 7 * 1024 ** 2)
        )
          await flush();
        batch.planned.push(planned);
        batch.end = source.record;
        batchBytes += bytes;
      }
      if (input.atomic && batch.planned.some((record) => record.rejection)) {
        for (const record of batch.planned)
          if (record.rejection)
            await this.recordRejection(job, record.rejection);
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Atomic import has invalid records; no rows were committed",
          422,
          {
            rejected: batch.planned.filter((record) => record.rejection).length,
          },
        );
      }
      await flush();
      const report = await this.rejectionReport(actor, job);
      return {
        committed,
        rejected,
        processed: offset,
        partial: rejected > 0,
        ...(report ? { rejectionArtifactId: report.id } : {}),
      };
    } finally {
      opened.stream.destroy();
      await opened.cleanup();
    }
  }

  private async persistPlan(job: JobRecord, batch: Batch): Promise<Batch> {
    return this.queue.fenced(job, async (client) => {
      const saved = await client.query<{ plan: Batch }>(
        `INSERT INTO rootset_control.import_batches(job_id,org_id,start_record,end_record,plan) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(job_id,start_record) DO UPDATE SET plan=rootset_control.import_batches.plan RETURNING plan`,
        [job.id, job.org_id, batch.start, batch.end, batch],
      );
      return saved.rows[0]!.plan;
    });
  }

  private async commitBatch(
    actor: Actor,
    job: JobRecord,
    input: ImportInput,
    batch: Batch,
  ): Promise<{ committed: number; rejected: number }> {
    actor = (await this.recheck?.(job)) ?? actor;
    await this.queue.fenced(job, async () => undefined);
    const valid = batch.planned.filter((record) => record.operation);
    let committed = 0;
    let rejected = batch.planned.length - valid.length;
    for (const item of batch.planned)
      if (item.rejection) await this.recordRejection(job, item.rejection);
    if (!valid.length) return { committed, rejected };
    const mutationContext = {
      requestId: job.id,
      source: "import",
      jobId: job.id,
    };
    const existingProgress = await withOrg(
      this.queue.workerPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{
            progress: { records?: Record<string, string> };
          }>(
            "SELECT progress FROM rootset_control.import_batches WHERE job_id=$1 AND start_record=$2",
            [job.id, batch.start],
          )
        ).rows[0]?.progress.records ?? {},
    );
    try {
      if (Object.keys(existingProgress).length === 0) {
        await this.queue.fenced(job, async (client, current) => {
          await this.storage.mutateRows(
            actor,
            input.tableId,
            {
              operations: valid.map(
                (record) => record.operation!,
              ) as RowOperation[],
              idempotencyKey: `job:${job.id}:batch:${batch.start}`,
              expectedSchemaVersion: input.expectedSchemaVersion,
              context: { ...mutationContext, source: "import" },
            },
            client,
          );
          const records = Object.fromEntries(
            valid.map((record) => [record.record, "committed"]),
          );
          await client.query(
            "UPDATE rootset_control.import_batches SET progress=$3 WHERE job_id=$1 AND start_record=$2",
            [job.id, batch.start, { records }],
          );
          await client.query(
            "UPDATE rootset_control.jobs SET progress=$2 WHERE id=$1",
            [
              job.id,
              {
                ...current.progress,
                committed:
                  Number(current.progress.committed ?? 0) + valid.length,
              },
            ],
          );
        });
        return { committed: valid.length, rejected };
      }
    } catch (error) {
      if (input.atomic) throw error;
      if (
        !(error instanceof RootsetError) ||
        ![
          "UNIQUE_CONFLICT",
          "ROW_VERSION_CONFLICT",
          "VALIDATION_FAILED",
          "ROW_SIZE_LIMIT",
          "ROW_LIMIT_REACHED",
        ].includes(error.code)
      )
        throw error;
    }
    for (const item of valid) {
      if (existingProgress[String(item.record)]) {
        if (existingProgress[String(item.record)] === "committed") committed++;
        else rejected++;
        continue;
      }
      actor = (await this.recheck?.(job)) ?? actor;
      await this.queue.fenced(job, async () => undefined);
      try {
        await this.queue.fenced(job, async (client, current) => {
          await this.storage.mutateRows(
            actor,
            input.tableId,
            {
              operations: [item.operation!] as RowOperation[],
              idempotencyKey: `job:${job.id}:record:${item.record}`,
              expectedSchemaVersion: input.expectedSchemaVersion,
              context: { ...mutationContext, source: "import" },
            },
            client,
          );
          await client.query(
            "UPDATE rootset_control.import_batches SET progress=jsonb_set(progress,'{records}',coalesce(progress->'records','{}')||$3::jsonb) WHERE job_id=$1 AND start_record=$2",
            [job.id, batch.start, { [item.record]: "committed" }],
          );
          await client.query(
            "UPDATE rootset_control.jobs SET progress=$2 WHERE id=$1",
            [
              job.id,
              {
                ...current.progress,
                committed: Number(current.progress.committed ?? 0) + 1,
              },
            ],
          );
        });
        committed++;
      } catch (error) {
        if (!(error instanceof RootsetError)) throw error;
        rejected++;
        await this.recordRejection(job, {
          record: item.record,
          code: error.code,
          message: error.message,
        });
        await this.queue.fenced(job, (client) =>
          client.query(
            "UPDATE rootset_control.import_batches SET progress=jsonb_set(progress,'{records}',coalesce(progress->'records','{}')||$3::jsonb) WHERE job_id=$1 AND start_record=$2",
            [job.id, batch.start, { [item.record]: "rejected" }],
          ),
        );
      }
    }
    return { committed, rejected };
  }

  private async recordRejection(
    job: JobRecord,
    rejection: Rejection,
  ): Promise<void> {
    await this.queue.fenced(job, async (client, current) => {
      const inserted = await client.query(
        `INSERT INTO rootset_control.import_rejections(job_id,org_id,record_number,code,message,field)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,record_number) DO NOTHING RETURNING record_number`,
        [
          job.id,
          job.org_id,
          rejection.record,
          rejection.code,
          rejection.message.slice(0, 1000),
          rejection.field ?? null,
        ],
      );
      if (inserted.rowCount)
        await client.query(
          "UPDATE rootset_control.jobs SET progress=$2 WHERE id=$1",
          [
            job.id,
            {
              ...current.progress,
              rejected: Number(current.progress.rejected ?? 0) + 1,
            },
          ],
        );
    });
  }

  private async validate(
    actor: Actor,
    job: JobRecord,
    table: TableInfo,
    input: ImportInput,
    artifact: ArtifactRecord,
    stream: Readable,
  ): Promise<JsonValue> {
    const rules = (await this.storage.listUniqueRules(actor, table.id)).filter(
      (rule) => rule.state === "active",
    );
    let valid = 0;
    let rejected = 0;
    let total = 0;
    let newRows = 0;
    const client = await this.queue.workerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rootset.org_id',$1,true)", [
        actor.orgId,
      ]);
      await client.query(
        "CREATE TEMP TABLE rootset_import_seen(rule_id text,digest text,tuple text,record_number bigint) ON COMMIT DROP",
      );
      await client.query("CREATE INDEX ON rootset_import_seen(rule_id,digest)");
      for await (const source of importRecords(stream, artifact.format, {
        safeIntegers: false,
        recoverInvalidRecords: true,
      })) {
        total = source.record;
        let planned = await this.plan(
          actor,
          table,
          input,
          source,
          artifact.format,
        );
        if (planned.operation) {
          await client.query("SAVEPOINT import_validation_record");
          try {
            let values = planned.operation.values as Record<string, JsonValue>;
            if (planned.operation.kind === "update") {
              const existing = await this.storage.getRow(
                actor,
                table.id,
                String(planned.operation.rowId),
              );
              values = { ...existing.values, ...values };
              assertRowBytes(table.fields, values);
            }
            for (const rule of rules) {
              const fields = (rule.fieldIds as string[]).map((fieldId) =>
                table.fields.find((field) => field.id === fieldId)!,
              );
              if (fields.some((field) => values[field.apiKey] == null))
                continue;
              const tuple = canonicalJson(
                fields.map((field) => ({
                  type: field.type,
                  value: values[field.apiKey],
                })),
                { maxDepth: 96 },
              );
              const digest = createHash("sha256").update(tuple).digest("hex");
              const duplicate = await client.query(
                "SELECT record_number FROM rootset_import_seen WHERE rule_id=$1 AND digest=$2 AND tuple=$3",
                [rule.id, digest, tuple],
              );
              if (duplicate.rowCount)
                throw new RootsetError(
                  "UNIQUE_CONFLICT",
                  "Unique tuple repeats within the uploaded file",
                  409,
                );
              const existing = await this.storage.queryRows(actor, table.id, {
                where: {
                  and: fields.map((field) => ({
                    field: field.apiKey,
                    op: "eq" as const,
                    value: values[field.apiKey]!,
                  })),
                },
                limit: 2,
              });
              if (
                existing.data.some((row) => row.id !== planned.operation!.rowId)
              )
                throw new RootsetError(
                  "UNIQUE_CONFLICT",
                  "Unique tuple conflicts with an existing row",
                  409,
                );
              await client.query(
                "INSERT INTO rootset_import_seen VALUES($1,$2,$3,$4)",
                [rule.id, digest, tuple, source.record],
              );
            }
            if (
              planned.operation.kind === "create" &&
              Number(table.rowCount) + newRows + 1 > 5_000_000
            )
              throw new RootsetError(
                "ROW_LIMIT_REACHED",
                "Import exceeds live table capacity",
                409,
              );
            if (planned.operation.kind === "create") newRows++;
            await client.query("RELEASE SAVEPOINT import_validation_record");
          } catch (error) {
            await client.query(
              "ROLLBACK TO SAVEPOINT import_validation_record",
            );
            await client.query("RELEASE SAVEPOINT import_validation_record");
            if (!(error instanceof RootsetError)) throw error;
            planned = {
              record: source.record,
              rejection: {
                record: source.record,
                code: error.code,
                message: error.message,
              },
            };
          }
        }
        if (planned.rejection) {
          rejected++;
          await this.recordRejection(job, planned.rejection);
        } else valid++;
        if (total % 200 === 0)
          await this.queue.checkpoint(
            job,
            { artifactId: artifact.id },
            { completed: total, committed: 0, rejected, unit: "records" },
            "validating",
          );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const report = await this.rejectionReport(actor, job);
    const errors = await withOrg(
      this.queue.workerPool,
      actor.orgId,
      async (client) =>
        (
          await client.query<{
            record_number: string;
            code: string;
            message: string;
            field: string | null;
          }>(
            "SELECT record_number,code,message,field FROM rootset_control.import_rejections WHERE job_id=$1 ORDER BY record_number LIMIT 1000",
            [job.id],
          )
        ).rows.map((error) => ({
          record: Number(error.record_number),
          code: error.code,
          message: error.message,
          ...(error.field ? { field: error.field } : {}),
        })),
    );
    return {
      valid: rejected === 0,
      examined: total,
      accepted: valid,
      rejected,
      errors,
      dryRun: true,
      schemaVersion: table.schemaVersion,
      consistency: "validation_at_time_of_run",
      ...(report ? { reportArtifactId: report.id } : {}),
    };
  }

  private async rejectionReport(
    actor: Actor,
    job: JobRecord,
  ): Promise<ArtifactRecord | null> {
    const count = await withOrg(
      this.queue.workerPool,
      actor.orgId,
      async (client) =>
        Number(
          (
            await client.query<{ count: string }>(
              "SELECT count(*) FROM rootset_control.import_rejections WHERE job_id=$1",
              [job.id],
            )
          ).rows[0]?.count ?? 0,
        ),
    );
    if (!count) return null;
    const pool = this.queue.workerPool;
    async function* records() {
      let last = 0;
      for (;;) {
        const rows = await withOrg(
          pool,
          actor.orgId,
          async (client) =>
            (
              await client.query<Record<string, unknown>>(
                "SELECT record_number AS record,code,message,field FROM rootset_control.import_rejections WHERE job_id=$1 AND record_number>$2 ORDER BY record_number LIMIT 1000",
                [job.id, last],
              )
            ).rows,
        );
        if (!rows.length) return;
        for (const row of rows)
          yield `${canonicalJson({ ...row, record: Number(row.record) }, { maxDepth: 96 })}\n`;
        last = Number(rows.at(-1)!.record);
      }
    }
    return this.artifacts.write(
      actor,
      job,
      { type: "table", id: job.target_id },
      "import-rejections",
      "jsonl",
      "application/x-ndjson",
      records(),
      { rejected: count },
      { allowCancelled: true },
    );
  }
}
