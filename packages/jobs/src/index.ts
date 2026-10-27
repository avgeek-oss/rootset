import { DatabaseRestores, restoreJobKinds } from "./backups/restores.js";
import { DatabaseBackups, backupJobKinds } from "./backups/index.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import {
  getOperation,
  IdSchema,
  JobAcceptedSchema,
  newId,
  normalizeExportViewQuery,
  RootsetError,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";
import { assertAccess } from "@rootset/access";
import { withOrg, type PoolClient } from "@rootset/database";
import {
  jobsMutationSet,
  queuedMutationSet,
  runMutation,
  operationAdmissionBinding,
  lockOperationAdmission,
} from "@rootset/idempotency";
import { ArtifactStore } from "./artifacts.js";
import { TableImports } from "./imports.js";
import {
  databaseExport,
  tableExportRows,
  type ExportFormat,
} from "./exports.js";
import {
  DurableQueue,
  JobCancelled,
  LeaseLost,
  snapshotTransaction,
} from "./queue.js";
import type {
  ArtifactDownload,
  ArtifactRecord,
  JobRecord,
  JobsOptions,
  OperationContext,
  Target,
} from "./types.js";
import { stableStringify } from "./types.js";
export * from "./types.js";
export * from "./queue.js";
export * from "./artifacts.js";

function repairReason(
  operationId: string,
  input: Record<string, unknown>,
): string | undefined {
  if (operationId !== "mutateRows" || input.repair === undefined)
    return undefined;
  const repair = input.repair;
  const reason =
    repair && typeof repair === "object" && !Array.isArray(repair)
      ? (repair as Record<string, unknown>).reason
      : undefined;
  if (typeof reason !== "string" || !reason.trim())
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Operator repair requires an explicit reason",
      422,
    );
  return reason;
}
function target(job: JobRecord): Target {
  const value: Target =
    job.target_type === "table"
      ? { tableId: job.target_id }
      : job.target_type === "database"
        ? { databaseId: job.target_id }
        : {};
  const reason = repairReason(job.operation_id, job.input);
  if (reason !== undefined) value.repair = { reason };
  return value;
}

function accepted(job: JobRecord) {
  return {
    jobId: job.id,
    state: job.state,
    statusUrl: `/v1/orgs/${job.org_id}/jobs/${job.id}?workspaceId=${job.input.workspaceId ?? job.actor.workspaceId ?? job.org_id}`,
  };
}
function jobView(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    orgId: job.org_id,
    kind: job.kind,
    operationId: job.operation_id,
    cancelRequested: job.cancel_requested,
    ...(["import", "import_preview"].includes(job.kind)
      ? { fileName: job.input.fileName }
      : {}),
    ...(job.kind === "import" ? { previewId: job.input.previewId } : {}),
    ...(job.kind === "export"
      ? {
          format: job.input.format,
          exportScope:
            job.target_type === "database"
              ? "database"
              : job.operation_id === "exportView"
                ? "view"
                : "table",
        }
      : {}),
    state: job.state,
    stage: job.stage,
    ...(job.target_type === "table"
      ? { tableId: job.target_id }
      : job.target_type === "database"
        ? { databaseId: job.target_id }
        : {}),
    ...(restoreJobKinds.includes(job.kind)
      ? {
          databaseId: job.input.sourceDatabaseId,
          backupId: job.input.backupId,
          ...(job.kind === "database_restore"
            ? { previewId: job.input.previewId }
            : {}),
        }
      : {}),
    progress: {
      completed: Number(job.progress.completed ?? job.progress.committed ?? 0),
      ...(job.progress.committed === undefined
        ? {}
        : { committed: job.progress.committed }),
      ...(job.progress.total === undefined
        ? {}
        : { total: job.progress.total }),
      ...(job.progress.unit ? { unit: job.progress.unit } : {}),
    },
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
    ...(job.result === null ? {} : { result: job.result }),
    ...(job.error === null
      ? {}
      : {
          error: {
            ...(job.error as Record<string, JsonValue>),
            requestId: job.id,
          },
        }),
    checkpoint: job.checkpoint,
    attempt: job.attempt,
  };
}

export class JobsService {
  readonly queue: DurableQueue;
  readonly artifacts: ArtifactStore;
  readonly imports: TableImports;
  readonly backups: DatabaseBackups;
  readonly restores: DatabaseRestores;
  readonly config: JobsOptions["config"];
  readonly storage: JobsOptions["storage"];
  private readonly authoriseCallback: JobsOptions["authorise"];
  private readonly admissions = new AsyncLocalStorage<{
    client: PoolClient;
    actor: Actor;
    operationId: string;
    key: string;
    binding: string;
    fields: string[];
    source?: string;
    operatorRepair: boolean;
  }>();
  constructor(options: JobsOptions) {
    this.config = options.config;
    this.storage = options.storage;
    this.authoriseCallback = options.authorise;
    this.queue = new DurableQueue(
      options.pool,
      options.ddlPool,
      options.config.leaseSeconds ?? 30,
      options.config.maxAttempts ?? 3,
      (actor, operationId, key, client) => {
        const current = this.admissions.getStore();
        if (!current || client !== current.client) return undefined;
        if (
          operationId !== current.operationId ||
          key !== current.key ||
          actor.orgId !== current.actor.orgId ||
          actor.kind !== current.actor.kind ||
          actor.id !== current.actor.id ||
          actor.userId !== current.actor.userId ||
          actor.credentialId !== current.actor.credentialId ||
          actor.clientId !== current.actor.clientId
        )
          throw new RootsetError(
            "CONFIGURATION_INVALID",
            "Queued admission changed its bound principal or operation",
            500,
          );
        return {
          binding: current.binding,
          fields: current.fields,
          source: current.source,
          operatorRepair: current.operatorRepair,
        };
      },
    );
    this.artifacts = new ArtifactStore(options.pool, options.config.artifacts);
    this.imports = new TableImports(
      this.storage,
      this.queue,
      this.artifacts,
      this.config,
      async (job) => {
        const actor = await this.jobActor(job);
        await this.queue.fenced(job, async () => undefined);
        return actor;
      },
    );
    this.backups = new DatabaseBackups(options, this.queue);
    this.restores = new DatabaseRestores(options, this.queue, (job, client) =>
      this.authorise(job.actor, job.operation_id, {}, client),
    );
  }

  async authorise(
    actor: Actor,
    operationId: string,
    inputTarget: Target,
    client?: PoolClient,
  ): Promise<Actor> {
    if (this.authoriseCallback) {
      const current = await this.authoriseCallback(
        actor,
        operationId,
        inputTarget,
        client,
      );
      actor = current ?? actor;
      if (!inputTarget.repair) return actor;
    }
    const required = [
      ...getOperation(operationId).scopes,
      ...(inputTarget.repair ? ["rows:write", "installation:manage"] : []),
    ];
    for (const scope of required)
      assertAccess(actor, {
        scope,
        orgId: actor.orgId,
        personal: Boolean(inputTarget.repair),
      });
    if (inputTarget.repair && actor.role !== "admin")
      throw new RootsetError(
        "ACCESS_DENIED",
        "Repair requires a current Admin identity",
        403,
      );
    if (inputTarget.tableId) {
      const table = await this.storage.getTable(actor, inputTarget.tableId);
      if (inputTarget.databaseId && inputTarget.databaseId !== table.databaseId)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Resource was not found",
          404,
        );
      await this.storage.getDatabase(actor, table.databaseId);
    } else if (inputTarget.databaseId)
      await this.storage.getDatabase(actor, inputTarget.databaseId);
    return actor;
  }

  async authoriseRequest(
    actor: Actor,
    operationId: string,
    input: Record<string, unknown>,
  ): Promise<Actor> {
    if (input.orgId && input.orgId !== actor.orgId)
      throw new RootsetError(
        "ACCESS_DENIED",
        "Organisation target is outside this credential",
        403,
      );
    const inputTarget: Target = {
      ...(typeof input.databaseId === "string"
        ? { databaseId: input.databaseId }
        : {}),
      ...(typeof input.tableId === "string" ? { tableId: input.tableId } : {}),
    };
    const reason = repairReason(operationId, input);
    if (reason !== undefined) inputTarget.repair = { reason };
    actor = await this.authorise(actor, operationId, inputTarget);
    if (operationId === "cancelJob" || operationId === "retryJob") {
      const original = await this.authorisedJob(actor, String(input.id));
      if (operationId === "retryJob")
        await this.authorise(actor, original.operation_id, target(original));
    }
    return actor;
  }

  private storedAdmission(job: JobRecord) {
    const secret = this.config.idempotencySecret;
    if (!secret)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Queued admission signing is unavailable",
        500,
      );
    const stored = job.input.operationContext as
      Record<string, unknown> | undefined;
    const storedFields = stored?.admissionFields;
    if (
      !stored ||
      !Array.isArray(storedFields) ||
      !storedFields.every(
        (field) => typeof field === "string" && field !== "operationContext",
      ) ||
      new Set(storedFields).size !== storedFields.length ||
      !Object.hasOwn(stored, "admissionSource") ||
      !(
        stored.admissionSource === null ||
        typeof stored.admissionSource === "string"
      ) ||
      !this.queue.authenticInput(job)
    )
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Queued admission provenance is missing or inconsistent",
        409,
      );
    const projected = Object.fromEntries(
      storedFields.map((field) => [field, job.input[field]]),
    );
    if (storedFields.some((field) => !Object.hasOwn(job.input, field)))
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Queued admission public input is incomplete",
        409,
      );
    if (
      !getOperation(job.operation_id).inputSchema.safeParse(projected).success
    )
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Queued admission public input is invalid",
        409,
      );
    const source =
      typeof stored.admissionSource === "string"
        ? stored.admissionSource
        : undefined;
    if (
      stored.source !==
        (repairReason(job.operation_id, projected) !== undefined
          ? "operator"
          : source) ||
      stored.idempotencyKey !== job.idempotency_key
    )
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Queued admission source is inconsistent",
        409,
      );
    let storedBinding: string;
    try {
      storedBinding = operationAdmissionBinding(
        job.actor,
        job.operation_id,
        projected,
        job.idempotency_key,
        secret,
        { source },
      );
    } catch {
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Queued admission proof is inconsistent",
        409,
      );
    }
    const saved =
      typeof stored.admissionBinding === "string"
        ? stored.admissionBinding
        : "";
    if (
      !/^v1:[a-f0-9]{64}$/.test(saved) ||
      !timingSafeEqual(Buffer.from(saved), Buffer.from(storedBinding))
    )
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Stored queued admission proof is inconsistent",
        409,
      );
    const expectedType =
      typeof projected.tableId === "string"
        ? "table"
        : typeof projected.databaseId === "string"
          ? "database"
          : "organisation";
    const expectedId = String(
      projected.tableId ?? projected.databaseId ?? job.actor.orgId,
    );
    if (
      job.org_id !== job.actor.orgId ||
      job.requester_id !== `${job.actor.kind}:${job.actor.id}` ||
      job.target_type !== expectedType ||
      job.target_id !== expectedId
    )
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Stored queued admission principal or target is inconsistent",
        409,
      );
    return {
      binding: saved,
      source,
    };
  }

  private repairAdmissionSource(
    job: JobRecord,
  ): NonNullable<OperationContext["admissionSource"]> {
    const admission = this.storedAdmission(job);
    if (
      job.kind !== "operation" ||
      job.operation_id !== "mutateRows" ||
      !repairReason(job.operation_id, job.input)
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Repair has no authenticated admission",
        403,
      );
    switch (admission.source) {
      case "rest":
      case "browser":
      case "mcp":
      case "operator":
        return admission.source;
      default:
        throw new RootsetError(
          "ACCESS_DENIED",
          "Repair has no authenticated request origin",
          403,
        );
    }
  }

  async withOperationAdmission(
    actor: Actor,
    operationId: string,
    input: Record<string, unknown>,
    context: OperationContext,
    work: (client: PoolClient) => Promise<unknown>,
  ): Promise<unknown> {
    actor = await this.authoriseRequest(actor, operationId, input);
    if (
      !(
        queuedMutationSet.has(operationId) ||
        repairReason(operationId, input) !== undefined
      ) ||
      (operationId === "countRows" &&
        input.exact !== true &&
        !Boolean(
          input.query &&
          typeof input.query === "object" &&
          !Array.isArray(input.query) &&
          (input.query as Record<string, unknown>).where,
        ))
    )
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "This operation does not admit a durable job",
        500,
      );
    const parsedInput = getOperation(operationId).inputSchema.safeParse(input);
    if (!parsedInput.success)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Queued admission input is invalid",
        422,
      );
    input = parsedInput.data as Record<string, unknown>;
    const client = context.client,
      secret = this.config.idempotencySecret;
    if (!client || !secret)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Queued admission requires its supplied transaction and signing secret",
        500,
      );
    const key = this.requireKey(context.idempotencyKey);
    const binding = operationAdmissionBinding(
      actor,
      operationId,
      input,
      key,

      secret,
      { source: context.source },
    );
    const fields = Object.keys(input)
      .filter((field) => input[field] !== undefined)
      .sort();
    if (fields.includes("operationContext"))
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Queued admission context is server owned",
        422,
      );
    await lockOperationAdmission(client, actor, operationId, key, secret);
    const read = async () =>
      (
        await client.query<JobRecord>(
          "SELECT * FROM rootset_control.jobs WHERE org_id=$1 AND requester_id=$2 AND operation_id=$3 AND idempotency_key=$4",
          [actor.orgId, `${actor.kind}:${actor.id}`, operationId, key],
        )
      ).rows[0];
    const originalAccepted = (job: JobRecord) => {
      const stored = this.storedAdmission(job);
      if (!timingSafeEqual(Buffer.from(stored.binding), Buffer.from(binding)))
        throw new RootsetError(
          "IDEMPOTENCY_CONFLICT",
          "This queued request has different bound input or proof",
          409,
        );
      return JobAcceptedSchema.parse({ ...accepted(job), state: "queued" });
    };
    const existing = await read();
    if (existing) return originalAccepted(existing);
    return this.admissions.run(
      {
        client,
        actor,
        operationId,
        key,
        binding,
        fields,

        source: context.source,
        operatorRepair: repairReason(operationId, input) !== undefined,
      },
      async () => {
        const result = JobAcceptedSchema.safeParse(await work(client));
        const saved = await read();
        if (!result.success || !saved || result.data.jobId !== saved.id)
          throw new RootsetError(
            "IDEMPOTENCY_CONFLICT",
            "Queued admission did not produce its bound durable job",
            409,
          );
        const expected = originalAccepted(saved);
        if (
          result.data.state !== expected.state ||
          result.data.statusUrl !== expected.statusUrl
        )
          throw new RootsetError(
            "IDEMPOTENCY_CONFLICT",
            "Queued admission acknowledgement is inconsistent",
            409,
          );
        return expected;
      },
    );
  }

  async execute(
    operationId: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: OperationContext = {},
  ): Promise<unknown> {
    actor = await this.authoriseRequest(actor, operationId, input);
    const idempotencyKey =
      context.idempotencyKey ??
      (typeof input.idempotencyKey === "string"
        ? input.idempotencyKey
        : undefined);
    if (jobsMutationSet.has(operationId) || queuedMutationSet.has(operationId))
      return this.runReceipt(
        actor,
        operationId,
        input,
        { ...context, idempotencyKey },
        (client) =>
          this.dispatchOperation(
            operationId,
            actor,
            input,
            { ...context, client },
            idempotencyKey,
          ),
      );
    return this.dispatchOperation(
      operationId,
      actor,
      input,
      context,
      idempotencyKey,
    );
  }

  private async runReceipt(
    actor: Actor,
    operationId: string,
    input: Record<string, unknown>,
    context: OperationContext,
    work: (client: PoolClient) => Promise<unknown>,
  ) {
    const secret = this.config.idempotencySecret;
    if (!secret)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Mutation replay binding is not configured",
        500,
      );
    const run = (client: PoolClient) =>
      runMutation(
        client,
        actor,
        operationId,
        input,
        this.requireKey(context.idempotencyKey),
        secret,
        async () => {
          const value = await work(client);
          const parsed =
            getOperation(operationId).outputSchema.safeParse(value);
          if (!parsed.success)
            throw new RootsetError(
              "JOB_FAILED",
              "Operation result does not match its declared contract",
              500,
            );
          return parsed.data;
        },
      );
    return context.client
      ? run(context.client)
      : withOrg(this.queue.pool, actor.orgId, run);
  }

  private async dispatchOperation(
    operationId: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: OperationContext,
    idempotencyKey: string | undefined,
  ): Promise<unknown> {
    switch (operationId) {
      case "previewDatabaseRestore":
      case "restoreDatabaseBackup":
        return this.restores.enqueue(operationId, actor, input, {
          ...context,
          idempotencyKey,
        });
      case "previewImportRows":
      case "importRows": {
        let fileName: unknown;
        const table = await this.storage.getTable(actor, String(input.tableId));
        if (table.schemaVersion !== input.expectedSchemaVersion)
          throw new RootsetError(
            "SCHEMA_VERSION_CONFLICT",
            "The table schema changed. Reload before validating the file",
            409,
          );
        if (operationId === "importRows") {
          await this.authorisedJob(actor, String(input.previewId));
          const preview = await this.imports.source(
            actor,
            String(input.previewId),
            table.id,
          );
          fileName = preview.input.fileName;
          if (preview.input.expectedSchemaVersion !== table.schemaVersion)
            throw new RootsetError(
              "SCHEMA_VERSION_CONFLICT",
              "The table schema changed. Validate the file again",
              409,
            );
          if (!context.client)
            throw new RootsetError(
              "CONFIGURATION_INVALID",
              "Import admission requires a transaction",
              500,
            );
          await context.client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`rootset:import:${preview.id}`],
          );
          const previous = (
            await context.client.query<JobRecord>(
              "SELECT * FROM rootset_control.jobs WHERE org_id=$1 AND target_id=$2 AND kind='import' AND input->>'previewId'=$3",
              [actor.orgId, table.id, preview.id],
            )
          ).rows[0];
          if (previous) return accepted(previous);
        }
        return accepted(
          await this.queue.enqueue(
            actor,
            operationId,
            operationId === "importRows" ? "import" : "import_preview",
            { type: "table", id: table.id },
            { ...input, ...(fileName === undefined ? {} : { fileName }) },
            this.requireKey(idempotencyKey),
            context.client,
          ),
        );
      }
      case "exportDatabase": {
        const database = await this.storage.getDatabase(
          actor,
          String(input.databaseId),
        );
        return accepted(
          await this.queue.enqueue(
            actor,
            operationId,
            "export",
            { type: "database", id: database.id },
            input,
            this.requireKey(idempotencyKey),
            context.client,
          ),
        );
      }
      case "exportView":
      case "exportRows": {
        const table = await this.storage.getTable(actor, String(input.tableId));
        const view = operationId === "exportView";
        if (view && input.expectedSchemaVersion !== table.schemaVersion)
          throw new RootsetError(
            "SCHEMA_VERSION_CONFLICT",
            "The fields changed. Reload the table before exporting this view.",
            409,
          );
        const query = view
          ? normalizeExportViewQuery(input.query, table.fields)
          : undefined;
        return accepted(
          await this.queue.enqueue(
            actor,
            operationId,
            "export",
            { type: "table", id: table.id },
            {
              ...input,
              ...(query ? { exportQuery: query } : {}),
              schemaVersion: table.schemaVersion,
            },
            this.requireKey(idempotencyKey),
            context.client,
          ),
        );
      }
      case "getArtifact":
        return this.getArtifact(actor, String(input.id));

      case "listJobs":
        return this.listJobs(actor, input);
      case "getJob":
        return jobView(await this.authorisedJob(actor, String(input.id)));
      case "cancelJob": {
        await this.authorisedJob(actor, String(input.id));
        const cancelled = await this.queue.cancel(
          actor,
          String(input.id),
          (job) => this.reconciledResult(job),
          context.client,
        );
        return jobView(cancelled);
      }
      case "retryJob": {
        const original = await this.authorisedJob(actor, String(input.id));
        await this.authorise(actor, original.operation_id, target(original));
        if (restoreJobKinds.includes(original.kind)) {
          if (!context.client)
            throw new RootsetError(
              "CONFIGURATION_INVALID",
              "Restore retry requires an admission transaction",
              500,
            );
          await this.restores.prepareRetry(actor, original, context.client);
        }
        return accepted(
          await this.queue.retry(actor, original.id, context.client),
        );
      }
      default:
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Background operation not found",
          404,
        );
    }
  }

  private requireKey(key: string | undefined): string {
    if (!key)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "This operation requires an idempotency key",
      );
    return key;
  }

  async enqueueOperation(
    actor: Actor,
    operationId: string,
    input: Record<string, unknown>,
    context: OperationContext = {},
  ) {
    const operationTarget: Target = {
      ...(typeof input.databaseId === "string"
        ? { databaseId: input.databaseId }
        : {}),
      ...(typeof input.tableId === "string" ? { tableId: input.tableId } : {}),
    };
    actor = await this.authoriseRequest(actor, operationId, input);
    const type = operationTarget.tableId
      ? "table"
      : operationTarget.databaseId
        ? "database"
        : "organisation";
    const id =
      operationTarget.tableId ?? operationTarget.databaseId ?? actor.orgId;
    const repair = repairReason(operationId, input);
    if (repair !== undefined) {
      const parsed = getOperation(operationId).inputSchema.safeParse(input);
      if (!parsed.success)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Operator repair input is invalid",
          422,
        );
      input = parsed.data as Record<string, unknown>;
    }
    const enqueue = async (client?: PoolClient) => {
      const job = await this.queue.enqueue(
        actor,
        operationId,
        "operation",
        { type, id },
        {
          ...input,
          operationContext: {
            idempotencyKey: context.idempotencyKey,
            requestId: context.requestId,
            source: repair !== undefined ? "operator" : context.source,
          },
        },
        this.requireKey(context.idempotencyKey),
        client,
      );
      return accepted(job);
    };
    if (queuedMutationSet.has(operationId) || repair !== undefined)
      return this.runReceipt(actor, operationId, input, context, enqueue);
    return enqueue(context.client);
  }

  private async authorisedJob(actor: Actor, id: string): Promise<JobRecord> {
    const job = await withOrg(
      this.queue.pool,
      actor.orgId,
      async (client) =>
        (
          await client.query<JobRecord>(
            "SELECT * FROM rootset_control.jobs WHERE id=$1",
            [id],
          )
        ).rows[0],
    );
    if (!job)
      throw new RootsetError("RESOURCE_NOT_FOUND", "Job not found", 404);
    if (
      !["admin"].includes(actor.role) &&
      job.requester_id !== `${actor.kind}:${actor.id}` &&
      (!actor.userId || actor.userId !== job.actor.userId)
    )
      throw new RootsetError("RESOURCE_NOT_FOUND", "Job not found", 404);
    await this.authorise(actor, job.operation_id, target(job));
    return job;
  }

  private async listJobs(actor: Actor, input: Record<string, unknown>) {
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 50)));
    const paging = this.config.metadataPaging;
    if (!paging)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Metadata cursor signing is not configured",
        503,
      );
    const order: "asc" | "desc" | undefined =
      input.order === "desc"
        ? "desc"
        : input.order === "asc"
          ? "asc"
          : undefined;
    const request = {
      ...(order ? { order } : {}),
      resource: `jobs:${actor.orgId}:${actor.workspaceId}`,
      limit,
      cursor: typeof input.cursor === "string" ? input.cursor : null,
      filter: {
        state: input.state ?? null,
        kind: input.kind ?? null,
        databaseId: input.databaseId ?? null,
        tableId: input.tableId ?? null,
      } as JsonValue,
    };
    const position = paging.read(actor, request);
    const rows = await withOrg(
      this.queue.pool,
      actor.orgId,
      async (client) =>
        (
          await client.query<JobRecord>(
            `SELECT * FROM rootset_control.jobs
      WHERE coalesce(input->>'workspaceId',actor->>'workspaceId',org_id)=$7 AND ($1::text IS NULL OR id${order === "desc" ? "<" : ">"}$1) AND ($2::text IS NULL OR state=$2) AND ($3::text IS NULL OR kind=$3 OR ($3='import' AND kind='import_preview') OR ($3='database_restore' AND kind='database_restore_preview'))
      AND ($4::text IS NULL OR (target_type='database' AND target_id=$4) OR (kind IN ('database_restore_preview','database_restore') AND input->>'sourceDatabaseId'=$4)) AND ($5::text IS NULL OR (target_type='table' AND target_id=$5)) ORDER BY id ${order === "desc" ? "DESC" : "ASC"} LIMIT $6`,
            [
              position.afterId,
              input.state ?? null,
              input.kind ?? null,
              input.databaseId ?? null,
              input.tableId ?? null,
              limit + 1,
              actor.workspaceId ?? actor.orgId,
            ],
          )
        ).rows,
    );
    const visible = [];
    const page = paging.paginate(rows, actor, request);
    for (const row of page.data) {
      try {
        visible.push(jobView(await this.authorisedJob(actor, row.id)));
      } catch (error) {
        if (
          !(error instanceof RootsetError) ||
          !["ACCESS_DENIED", "RESOURCE_NOT_FOUND"].includes(error.code)
        )
          throw error;
      }
    }
    return {
      data: visible,
      nextCursor: page.nextCursor,
    };
  }

  private async authoriseArtifact(
    actor: Actor,
    artifact: ArtifactRecord,
  ): Promise<void> {
    await this.authorise(
      actor,
      artifact.purpose === "import_report"
        ? "previewImportRows"
        : artifact.target_type === "database"
          ? "exportDatabase"
          : "exportRows",
      artifact.target_type === "table"
        ? { tableId: artifact.target_id }
        : { databaseId: artifact.target_id },
    );
    if (
      !["admin"].includes(actor.role) &&
      artifact.requester_id !== `${actor.kind}:${actor.id}`
    ) {
      const job = artifact.job_id
        ? await this.authorisedJob(actor, artifact.job_id)
        : null;
      if (!job || !actor.userId || job.actor.userId !== actor.userId)
        throw new RootsetError("RESOURCE_NOT_FOUND", "Artifact not found", 404);
    }
  }

  async getArtifact(actor: Actor, id: string) {
    const artifact = await this.artifacts.get(actor, id);
    await this.authoriseArtifact(actor, artifact);
    if (artifact.state !== "ready")
      throw new RootsetError(
        "JOB_FAILED",
        "Artifact is not ready for retrieval",
        409,
      );
    return {
      id: artifact.id,
      orgId: actor.orgId,
      kind: artifact.purpose === "import_report" ? "import_report" : "export",
      format: artifact.format,
      sizeBytes: Number(artifact.byte_length),
      checksum: artifact.checksum!,
      expiresAt: artifact.expires_at.toISOString(),
      downloadUrl: `${this.config.baseURL ?? ""}/v1/orgs/${actor.orgId}/artifacts/${artifact.id}/download?workspaceId=${actor.workspaceId ?? actor.orgId}`,
      resourceUri: `rootset://workspaces/${actor.workspaceId ?? actor.orgId}/artifacts/${artifact.id}`,
      ...(typeof artifact.metadata.rowCount === "number"
        ? { rowCount: artifact.metadata.rowCount }
        : {}),
      ...(typeof artifact.metadata.tableCount === "number"
        ? { tableCount: artifact.metadata.tableCount }
        : {}),
    };
  }

  async downloadArtifact(actor: Actor, id: string): Promise<ArtifactDownload> {
    const artifact = await this.artifacts.get(actor, id);
    await this.authoriseArtifact(actor, artifact);
    const verified = await this.artifacts.openVerified(actor, artifact);
    verified.stream.once("close", () => {
      void verified.cleanup();
    });
    verified.stream.once("error", () => {
      void verified.cleanup();
    });
    return {
      stream: verified.stream,
      mediaType: artifact.media_type,
      fileName: `rootset-${artifact.id}.${artifact.format}`,
      byteLength: Number(artifact.byte_length),
      checksum: artifact.checksum!,
    };
  }

  private async jobActor(job: JobRecord): Promise<Actor> {
    return this.authorise(job.actor, job.operation_id, target(job));
  }

  private async reconciledResult(
    job: JobRecord,
  ): Promise<JsonValue | undefined> {
    if (["import", "import_preview"].includes(job.kind))
      return this.imports.committedResult(job);
    if (backupJobKinds.includes(job.kind))
      return this.backups.committedResult(job);
    if (restoreJobKinds.includes(job.kind))
      return this.restores.committedResult(job);
    if (job.kind === "operation" && this.config.reconcileOperation) {
      const outcome = await this.config.reconcileOperation(job);
      if (outcome !== undefined) return outcome;
    }
    return undefined;
  }

  async cleanupArtifacts(orgId: string): Promise<number> {
    await this.artifacts.cleanupTemporaryFiles();
    const records = await withOrg(
      this.queue.workerPool,
      orgId,
      async (client) =>
        (
          await client.query<ArtifactRecord>(`SELECT a.* FROM rootset_control.artifacts a
      WHERE a.state<>'deleted' AND ((a.expires_at<=now() AND a.state IN ('uploading','ready','failed','deleting')))
      AND NOT EXISTS(SELECT 1 FROM rootset_control.jobs j WHERE j.id=a.job_id AND j.state IN ('queued','running'))
      ORDER BY a.expires_at LIMIT 20 FOR UPDATE SKIP LOCKED`)
        ).rows,
    );
    const maintenance: Actor = {
      kind: "operator",
      id: "artifact-retention",
      orgId,
      role: "admin",
      scopes: ["*"],
    };
    let removed = 0;
    for (const artifact of records) {
      if (!artifact.object_key.startsWith(`rootset/${orgId}/`))
        throw new RootsetError(
          "ACCESS_DENIED",
          "Artifact retention refused an object outside the owned organisation namespace",
          403,
        );
      await this.artifacts.remove(maintenance, artifact);
      removed++;
    }
    return removed;
  }

  async runOnce(
    orgId: string,
    options: { backups?: boolean } = {},
  ): Promise<boolean> {
    const reconciled = await this.queue.reconcilePending(orgId, (job) =>
      this.reconciledResult(job),
    );

    const job = await this.queue.claim(
      orgId,
      options.backups === false ? null : this.backups.backendId,
    );

    if (!job) return reconciled.length > 0;
    job.deadline =
      Date.now() + Number(job.input.maxRuntimeSeconds ?? 3600) * 1000;
    let leaseLost = false;
    let heartbeatRunning = false;
    const heartbeat = setInterval(
      () => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void this.queue
          .heartbeat(job)
          .then((alive) => {
            if (!alive) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          })
          .finally(() => {
            heartbeatRunning = false;
          });
      },
      Math.max(1000, Math.floor((this.queue.leaseSeconds * 1000) / 3)),
    );
    heartbeat.unref();
    try {
      if (restoreJobKinds.includes(job.kind)) {
        const prior = await this.restores.committedResult(job);
        if (prior !== undefined) {
          await this.queue.finish(job, "succeeded", prior);
          return true;
        }
      }
      if (["import", "import_preview"].includes(job.kind)) {
        const prior = await this.imports.committedResult(job);
        if (prior !== undefined) {
          await this.queue.finish(job, "succeeded", prior);
          return true;
        }
      }
      if (job.kind === "operation" && this.config.reconcileOperation) {
        const prior = await this.config.reconcileOperation(job);
        if (prior !== undefined) {
          await this.queue.finish(job, "succeeded", prior);
          return true;
        }
      }
      if (
        (job.input.operationContext as Record<string, unknown> | undefined)
          ?.admissionBinding !== undefined
      )
        this.storedAdmission(job);
      const actor = backupJobKinds.includes(job.kind)
        ? job.actor
        : await this.jobActor(job);
      if (job.cancel_requested) throw new JobCancelled();
      let result: JsonValue;
      if (backupJobKinds.includes(job.kind))
        result = await this.backups.run(job);
      else if (restoreJobKinds.includes(job.kind))
        result = await this.restores.run(job);
      else if (job.kind === "export") result = await this.export(actor, job);
      else if (["import", "import_preview"].includes(job.kind))
        result = await this.imports.run(job);
      else if (job.kind === "operation" && this.config.executeOperation)
        result = await this.config.executeOperation(
          actor,
          job.operation_id,
          job.input,
          {
            ...((job.input.operationContext as OperationContext) ?? {}),
            ...(repairReason(job.operation_id, job.input) !== undefined
              ? { admissionSource: this.repairAdmissionSource(job) }
              : {}),
            jobId: job.id,
            jobFence: { jobId: job.id, leaseToken: job.lease_token! },
            requestId:
              repairReason(job.operation_id, job.input) !== undefined
                ? String(
                    (job.input.operationContext as OperationContext)
                      ?.requestId ?? job.id,
                  )
                : job.id,
            idempotencyKey: `job:${job.id}:operation`,
            source:
              repairReason(job.operation_id, job.input) !== undefined
                ? "operator"
                : "worker",
          },
        );
      else
        throw new RootsetError(
          "JOB_FAILED",
          "This job kind has no configured executor",
          500,
        );
      if (leaseLost) throw new LeaseLost();
      await this.config.failpoint?.("job.beforeFinish", job.id);
      await this.queue.finish(
        job,
        result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          result.partial === true
          ? "partially_completed"
          : "succeeded",
        result,
      );
    } catch (error) {
      this.config.onError?.(error, job);
      const diagnostic = error as {
        code?: string;
        constraint?: string;
        table?: string;
      };
      console.error(
        JSON.stringify({
          level: "error",
          event: "job_failed",
          jobId: job.id,
          operationId: job.operation_id,
          code: diagnostic.code ?? "JOB_FAILED",
          ...(diagnostic.constraint
            ? { constraint: diagnostic.constraint }
            : {}),
          ...(diagnostic.table ? { table: diagnostic.table } : {}),
        }),
      );
      await this.queue.fail(job, error);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async export(actor: Actor, job: JobRecord): Promise<JsonValue> {
    if (!this.queue.authenticInput(job))
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Export request metadata changed after admission",
        409,
      );
    const format = job.input.format;
    if (format !== "csv" && format !== "jsonl")
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Export format must be csv or jsonl",
      );
    if (job.target_type === "database")
      return this.exportDatabase(actor, job, format);
    const table = await this.storage.getTable(actor, job.target_id);
    if (table.schemaVersion !== Number(job.input.schemaVersion))
      throw new RootsetError(
        "SCHEMA_VERSION_CONFLICT",
        "Export schema changed before snapshot establishment",
        409,
      );
    if (!this.storage.snapshotTable)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Snapshot export extraction is unavailable",
        500,
      );
    const projection =
      job.operation_id === "exportView"
        ? normalizeExportViewQuery(job.input.query, table.fields)
        : null;
    if (
      projection &&
      stableStringify(projection) !== stableStringify(job.input.exportQuery)
    )
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "The captured export columns or filters changed after admission",
        409,
      );
    return snapshotTransaction(
      this.queue.workerPool,
      actor.orgId,
      table.databaseId,
      async (client) => {
        const source = await this.storage.snapshotTable!(
          actor,
          table.id,
          projection ?? {},
          client,
          { expectedSchemaVersion: Number(job.input.schemaVersion) },
        );
        let rowCount = 0;
        const fields = projection
          ? projection.select.map((id) =>
              source.table.fields.find((field) => field.id === id)!,
            )
          : source.table.fields;
        const checkCurrent = async () => {
          actor = await this.jobActor(job);
          await this.queue.fenced(job, async () => undefined);
        };
        const records = tableExportRows(fields, source.rows, format, {
          check: checkCurrent,
          afterBatch: async () => {
            await this.config.failpoint?.("export.afterBatch", job.id);
          },
          onRows(count) {
            rowCount += count;
          },
        });
        const artifact = await this.artifacts.write(
          actor,
          job,
          { type: "table", id: table.id },
          "export",
          format,
          format === "csv" ? "text/csv" : "application/x-ndjson",
          records,
          {
            schemaVersion: table.schemaVersion,
            snapshot: "repeatable_read",
            exportScope: projection ? "view" : "table",
            fieldIds: fields.map((field) => field.id),
          },
          { beforePublish: checkCurrent },
        );
        await withOrg(this.queue.workerPool, actor.orgId, (connection) =>
          connection.query(
            "UPDATE rootset_control.artifacts SET metadata=metadata||$2::jsonb WHERE id=$1",
            [artifact.id, { rowCount }],
          ),
        );
        return {
          artifactId: artifact.id,
          rowCount,
          checksum: artifact.checksum!,
          byteLength: Number(artifact.byte_length),
          format,
          schemaVersion: source.table.schemaVersion,
          snapshot: "repeatable_read",
          exportScope: projection ? "view" : "table",
          fieldIds: fields.map((field) => field.id),
        };
      },
    );
  }

  private async exportDatabase(
    actor: Actor,
    job: JobRecord,
    format: ExportFormat,
  ): Promise<JsonValue> {
    const check = async () => {
      actor = await this.jobActor(job);
      await this.queue.fenced(job, async () => undefined);
    };
    return snapshotTransaction(
      this.queue.workerPool,
      actor.orgId,
      job.target_id,
      async (client) => {
        const archive = await databaseExport({
          client,
          storage: this.storage,
          actor,
          databaseId: job.target_id,
          rootsetVersion: this.config.rootsetVersion ?? "unknown",
          format,
          check,
          afterBatch: async () => {
            await this.config.failpoint?.("export.afterBatch", job.id);
          },
          afterTable: async () => {
            await this.config.failpoint?.("database-export.afterTable", job.id);
          },
          onTable: async (completed, total) => {
            await this.queue.fenced(job, async (connection) => {
              await connection.query(
                "UPDATE rootset_control.jobs SET stage='exporting',progress=$2,updated_at=now() WHERE id=$1",
                [job.id, { completed, total, unit: "tables" }],
              );
            });
          },
        });
        const artifact = await this.artifacts.write(
          actor,
          job,
          { type: "database", id: job.target_id },
          "export",
          "zip",
          "application/zip",
          archive.stream,
          {
            dataFormat: format,
            snapshot: "repeatable_read",
            snapshotAt: archive.manifest.snapshotAt,
          },
          { beforePublish: check },
        );
        const counts = {
          rowCount: archive.manifest.rowCount,
          tableCount: archive.manifest.tables.length,
        };
        await withOrg(this.queue.workerPool, actor.orgId, (connection) =>
          connection.query(
            "UPDATE rootset_control.artifacts SET metadata=metadata||$2::jsonb WHERE id=$1",
            [artifact.id, counts],
          ),
        );
        return {
          artifactId: artifact.id,
          ...counts,
          checksum: artifact.checksum!,
          byteLength: Number(artifact.byte_length),
          format: "zip",
          dataFormat: format,
          snapshot: "repeatable_read",
          snapshotAt: archive.manifest.snapshotAt,
        };
      },
    );
  }

  async runWorker(options: { signal?: AbortSignal } = {}): Promise<void> {
    const workerId = this.config.workerId
      ? IdSchema.parse(this.config.workerId)
      : newId();
    if (this.config.workerIdFile)
      await writeFile(this.config.workerIdFile, workerId, { mode: 0o600 });
    const heartbeat = async (
      state: "starting" | "ready" | "degraded" | "stopped",
      code: string | null = null,
    ) => {
      await this.queue.workerPool.query(
        `INSERT INTO rootset_control.worker_heartbeats(id,state,last_error_code,backup_backend_id,backup_alert_delivery) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),state=excluded.state,last_error_code=excluded.last_error_code,backup_backend_id=excluded.backup_backend_id,backup_alert_delivery=excluded.backup_alert_delivery`,
        [
          workerId,
          state,
          code,
          this.backups.backendId,
          this.config.backupNotificationsAvailable ?? false,
        ],
      );
    };
    await heartbeat("starting");
    const failures = new Map<string, string>();
    const pause = async (milliseconds: number) => {
      try {
        await delay(milliseconds, undefined, { signal: options.signal });
      } catch (error) {
        if (!options.signal?.aborted) throw error;
      }
    };
    const activity = async (
      name: string,
      work: () => Promise<boolean | void>,
    ) => {
      try {
        const worked = await work();
        failures.delete(name);
        return worked === true;
      } catch (error) {
        const code =
          error instanceof RootsetError ? error.code : "UPSTREAM_UNAVAILABLE";
        failures.set(name, code);
        console.error(
          JSON.stringify({
            level: "error",
            event: "worker_activity_failed",
            activity: name,
            code,
          }),
        );
        return false;
      }
    };
    const loop = async (
      name: string,
      work: () => Promise<boolean | void>,
      milliseconds: number,
    ) => {
      while (!options.signal?.aborted) {
        const worked = await activity(name, work);
        if (!worked) await pause(milliseconds);
      }
    };
    const organisation = async () =>
      (
        await this.queue.workerPool.query<{ id: string }>(
          "SELECT id FROM rootset_control.organisations",
        )
      ).rows[0]?.id;
    await heartbeat("ready");
    const workers = Array.from({ length: 2 }, (_, index) =>
      loop(
        `jobs:${index}`,
        async () => {
          const orgId = await organisation();
          if (orgId && !options.signal?.aborted)
            return this.runOnce(orgId, { backups: index === 1 });
        },
        this.config.pollMilliseconds ?? 500,
      ),
    );
    const maintenance = loop(
      "maintenance",
      async () => {
        const orgId = await organisation();
        if (orgId && !options.signal?.aborted) {
          await activity("backup_scheduler", () =>
            this.backups.scheduleDue(orgId),
          );
          await activity("backup_retention_alerts", () =>
            this.backups.lifecycle.maintain(orgId),
          );
          await activity("backup_spool_cleanup", () =>
            this.backups.cleanupTemporaryFiles(),
          );
          await activity("artifact_cleanup", async () => {
            await this.cleanupArtifacts(orgId);
          });
        }
        if (this.config.outbox && !options.signal?.aborted)
          await activity("email_outbox", () =>
            this.config.outbox!.deliverNext(),
          );
      },
      1000,
    );
    const heartbeats = loop(
      "heartbeat",
      async () => {
        const code = failures.values().next().value ?? null;
        await heartbeat(code ? "degraded" : "ready", code);
      },
      5000,
    );
    try {
      await Promise.all([...workers, maintenance, heartbeats]);
    } finally {
      await heartbeat("stopped");
    }
  }
}
