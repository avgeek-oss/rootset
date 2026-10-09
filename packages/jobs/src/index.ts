import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "csv-stringify/sync";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { writeFile } from "node:fs/promises";
import {
  canonicalJson,
  getOperation,
  IdSchema,
  JobAcceptedSchema,
  newId,
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
  resolveAdmissionApproval,
  operationAdmissionBinding,
  lockOperationAdmission,
} from "@rootset/idempotency";
import { ArtifactStore } from "./artifacts.js";
import { ImportRunner } from "./imports.js";
import {
  HistoryArchiveRunner,
  archiveView,
  type HistoryArchiveRecord,
} from "./archives.js";
import {
  DurableQueue,
  JobCancelled,
  LeaseLost,
  snapshotTransaction,
} from "./queue.js";
import { previewSchedule, validateSchedule } from "./schedule.js";
import type {
  ArtifactDownload,
  ArtifactRecord,
  JobRecord,
  JobsOptions,
  OperationContext,
  Target,
} from "./types.js";
export * from "./types.js";
export * from "./queue.js";
export * from "./artifacts.js";
export * from "./schedule.js";
export * from "./imports.js";
export * from "./archives.js";

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
    statusUrl: `/v1/orgs/${job.org_id}/jobs/${job.id}`,
  };
}
function jobView(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    orgId: job.org_id,
    kind: job.kind,
    operationId: job.operation_id,
    state: job.state,
    stage: job.stage,
    ...(job.target_type === "table"
      ? { tableId: job.target_id }
      : job.target_type === "database"
        ? { databaseId: job.target_id }
        : {}),
    progress: {
      completed: Number(job.progress.completed ?? job.progress.committed ?? 0),
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
interface HistoryPolicyRow {
  id: string;
  org_id: string;
  database_id: string;
  table_id: string;
  actor: Actor;
  enabled: boolean;
  cron: string;
  timezone: string;
  retention_days: number;
  max_runtime_seconds: number;
  next_occurrence: Date | null;
  suspension_code: string | null;
  suspended_at: Date | null;
}
function historyPolicyView(row: HistoryPolicyRow | null) {
  return row
    ? {
        enabled: row.enabled,
        cron: row.cron,
        timezone: row.timezone,
        retentionDays: row.retention_days,
        maxRuntimeSeconds: row.max_runtime_seconds,
        ...(row.suspension_code
          ? {
              suspension: {
                code: row.suspension_code,
                at: row.suspended_at!.toISOString(),
              },
            }
          : {}),
      }
    : {
        enabled: false,
        cron: "0 0 * * *",
        timezone: "UTC",
        retentionDays: 365,
        maxRuntimeSeconds: 3600,
      };
}

export class JobsService {
  readonly queue: DurableQueue;
  readonly artifacts: ArtifactStore;
  readonly imports: ImportRunner;
  readonly archives: HistoryArchiveRunner;
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
    approvalId?: string;
    source?: string;
    stepUpApproved?: boolean;
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
          approvalId: current.approvalId,
          source: current.source,
          stepUpApproved: current.stepUpApproved,
          operatorRepair: current.operatorRepair,
        };
      },
    );
    this.artifacts = new ArtifactStore(options.pool, options.config.artifacts);
    this.imports = new ImportRunner(
      this.queue,
      this.artifacts,
      this.storage,
      this.config.failpoint,
      (job) => this.jobActor(job),
    );
    this.archives = new HistoryArchiveRunner(
      this.queue,
      this.artifacts,
      this.storage,
      this.config.failpoint,
      (job) => this.jobActor(job),
    );
  }

  async authorise(
    actor: Actor,
    operationId: string,
    inputTarget: Target,
  ): Promise<Actor> {
    if (this.authoriseCallback) {
      const current = await this.authoriseCallback(
        actor,
        operationId,
        inputTarget,
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
      const archived =
        operationId === "getHistoryArchive" ||
        operationId === "listHistoryArchives";
      const table = await (archived
        ? this.storage.getArchivedTable(actor, inputTarget.tableId)
        : this.storage.getTable(actor, inputTarget.tableId));
      if (inputTarget.databaseId && inputTarget.databaseId !== table.databaseId)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Resource was not found",
          404,
        );
      const database = await (archived
        ? this.storage.getArchivedDatabase(actor, table.databaseId)
        : this.storage.getDatabase(actor, table.databaseId));
      if (
        archived &&
        (table.state === "deleted" || database.state === "deleted") &&
        actor.role !== "admin"
      )
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Retained history was not found",
          404,
        );
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
      (stored.approvalId !== undefined &&
        typeof stored.approvalId !== "string") ||
      !Object.hasOwn(stored, "admissionSource") ||
      !(
        stored.admissionSource === null ||
        typeof stored.admissionSource === "string"
      ) ||
      !Object.hasOwn(stored, "admissionStepUpApproved") ||
      !(
        stored.admissionStepUpApproved === null ||
        typeof stored.admissionStepUpApproved === "boolean"
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
          : undefined,
      stepUpApproved =
        typeof stored.admissionStepUpApproved === "boolean"
          ? stored.admissionStepUpApproved
          : undefined;
    if (
      stored.source !==
        (repairReason(job.operation_id, projected) !== undefined
          ? "operator"
          : source) ||
      stored.stepUpApproved !== stepUpApproved ||
      stored.idempotencyKey !== job.idempotency_key
    )
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Queued admission source or approval state is inconsistent",
        409,
      );
    let storedBinding: string;
    try {
      storedBinding = operationAdmissionBinding(
        job.actor,
        job.operation_id,
        projected,
        job.idempotency_key,
        typeof stored.approvalId === "string" ? stored.approvalId : undefined,
        secret,
        { source, stepUpApproved },
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
      stepUpApproved,
      approvalId:
        typeof stored.approvalId === "string" ? stored.approvalId : undefined,
    };
  }

  private repairAdmissionSource(
    job: JobRecord,
  ): NonNullable<OperationContext["admissionSource"]> {
    const admission = this.storedAdmission(job);
    if (
      job.kind !== "operation" ||
      job.operation_id !== "mutateRows" ||
      !repairReason(job.operation_id, job.input) ||
      admission.stepUpApproved !== true ||
      !admission.approvalId
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Repair has no authenticated approved admission",
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
    const approvalId = resolveAdmissionApproval(input, {
      approvalId: context.approvalId,
    });
    const binding = operationAdmissionBinding(
      actor,
      operationId,
      input,
      key,
      approvalId,
      secret,
      { source: context.source, stepUpApproved: context.stepUpApproved },
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
        approvalId,
        source: context.source,
        stepUpApproved: context.stepUpApproved,
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
      case "prepareImportUpload": {
        await this.storage.getTable(actor, String(input.tableId));
        if (!idempotencyKey)
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Upload preparation requires an idempotency key",
          );
        return this.artifacts.prepareUpload(actor, {
          tableId: String(input.tableId),
          format: String(input.format),
          byteLength: Number(input.byteLength),
          ...(typeof input.checksum === "string"
            ? { checksum: input.checksum }
            : {}),
          idempotencyKey,
        });
      }
      case "validateImport":
      case "importRows": {
        const table = await this.storage.getTable(actor, String(input.tableId));
        const artifact = await this.artifacts.get(
          actor,
          String(input.artifactId),
        );
        await this.authoriseArtifact(actor, artifact);
        if (
          artifact.target_type !== "table" ||
          artifact.target_id !== table.id ||
          (!["import_upload", `import-${input.artifactId}`].includes(
            artifact.purpose,
          ) &&
            !artifact.purpose.startsWith("import-"))
        )
          throw new RootsetError(
            "ACCESS_DENIED",
            "Import artifact belongs to a different source",
            403,
          );
        if (table.schemaVersion !== Number(input.expectedSchemaVersion))
          throw new RootsetError(
            "SCHEMA_VERSION_CONFLICT",
            "Import schema version is stale",
            409,
          );
        return accepted(
          await this.queue.enqueue(
            actor,
            operationId,
            operationId === "validateImport" ? "validate_import" : "import",
            { type: "table", id: table.id },
            input,
            this.requireKey(idempotencyKey),
            context.client,
          ),
        );
      }
      case "exportRows": {
        const table = await this.storage.getTable(actor, String(input.tableId));
        return accepted(
          await this.queue.enqueue(
            actor,
            operationId,
            "export",
            { type: "table", id: table.id },
            { ...input, schemaVersion: table.schemaVersion },
            this.requireKey(idempotencyKey),
            context.client,
          ),
        );
      }
      case "getArtifact":
        return this.getArtifact(actor, String(input.id));
      case "getHistoryRetentionPolicy":
        return this.historyPolicy(actor, String(input.tableId));
      case "setHistoryRetentionPolicy":
        return this.setHistoryPolicy(actor, input, context.client);
      case "archiveHistory": {
        const table = await this.storage.getTable(actor, String(input.tableId));
        const before = new Date(String(input.before));
        if (!Number.isFinite(before.getTime()) || before.getTime() > Date.now())
          throw new RootsetError(
            "VALIDATION_FAILED",
            "History archive cutoff must be a past UTC instant",
          );
        return accepted(
          await this.queue.enqueue(
            actor,
            operationId,
            "history_archive",
            { type: "table", id: table.id },
            input,
            this.requireKey(idempotencyKey),
            context.client,
          ),
        );
      }
      case "listHistoryArchives":
        return this.listHistoryArchives(actor, String(input.tableId), input);
      case "getHistoryArchive":
        return this.getHistoryArchive(
          actor,
          String(input.tableId),
          String(input.id),
        );

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
      if (
        repair !== undefined &&
        (!client ||
          !context.client ||
          !context.approvalId ||
          !context.stepUpApproved ||
          !this.config.recordRepairIntent)
      )
        throw new RootsetError(
          "STEP_UP_REQUIRED",
          "Operator repair requires a bound approved transaction",
          403,
        );
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
            approvalId: context.approvalId,
            stepUpApproved: context.stepUpApproved,
          },
        },
        this.requireKey(context.idempotencyKey),
        client,
      );
      if (repair !== undefined) {
        const original = job.input.operationContext as OperationContext;
        await this.config.recordRepairIntent!(client!, actor, {
          jobId: job.id,
          tableId: job.target_id,
          reason: repairReason(job.operation_id, job.input)!,
          approvalId: original.approvalId!,
          requestId: original.requestId ?? job.id,
        });
      }
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
    const request = {
      resource: `jobs:${actor.orgId}`,
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
      WHERE ($1::text IS NULL OR id>$1) AND ($2::text IS NULL OR state=$2) AND ($3::text IS NULL OR kind=$3)
      AND ($4::text IS NULL OR (target_type='database' AND target_id=$4)) AND ($5::text IS NULL OR (target_type='table' AND target_id=$5)) ORDER BY id ASC LIMIT $6`,
            [
              position.afterId,
              input.state ?? null,
              input.kind ?? null,
              input.databaseId ?? null,
              input.tableId ?? null,
              limit + 1,
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
    const operation =
      artifact.purpose === "history-archive"
        ? "getHistoryArchive"
        : artifact.purpose.startsWith("import")
          ? "validateImport"
          : "exportRows";
    await this.authorise(
      actor,
      operation,
      artifact.target_type === "table"
        ? { tableId: artifact.target_id }
        : { databaseId: artifact.target_id },
    );
    if (
      !["admin"].includes(actor.role) &&
      artifact.purpose !== "history-archive" &&
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
    let artifact = await this.artifacts.get(actor, id);
    await this.authoriseArtifact(actor, artifact);
    if (typeof artifact.metadata.finalizedArtifactId === "string")
      artifact = await this.artifacts.get(
        actor,
        artifact.metadata.finalizedArtifactId,
      );
    if (artifact.state !== "ready")
      throw new RootsetError(
        "JOB_FAILED",
        "Artifact is not ready for retrieval",
        409,
      );
    return {
      id: artifact.id,
      orgId: actor.orgId,
      kind:
        artifact.purpose === "history-archive"
          ? "history_archive"
          : artifact.purpose === "import-rejections"
            ? "report"
            : artifact.purpose.startsWith("import")
              ? "import"
              : "export",
      format: artifact.format,
      sizeBytes: Number(artifact.byte_length),
      checksum: artifact.checksum!,
      expiresAt: artifact.expires_at.toISOString(),
      downloadUrl: `${this.config.baseURL ?? ""}/v1/orgs/${actor.orgId}/artifacts/${artifact.id}/download`,
      resourceUri: `rootset://artifacts/${artifact.id}`,
      ...(typeof artifact.metadata.rowCount === "number"
        ? { rowCount: artifact.metadata.rowCount }
        : {}),
    };
  }

  async downloadArtifact(actor: Actor, id: string): Promise<ArtifactDownload> {
    let artifact = await this.artifacts.get(actor, id);
    await this.authoriseArtifact(actor, artifact);
    if (typeof artifact.metadata.finalizedArtifactId === "string")
      artifact = await this.artifacts.get(
        actor,
        artifact.metadata.finalizedArtifactId,
      );
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

  async uploadArtifact(
    actor: Actor,
    id: string,
    source: AsyncIterable<Uint8Array>,
  ) {
    const artifact = await this.artifacts.get(actor, id);
    if (artifact.target_type !== "table")
      throw new RootsetError(
        "RESOURCE_NOT_FOUND",
        "Import artifact not found",
        404,
      );
    actor = await this.authorise(actor, "prepareImportUpload", {
      tableId: artifact.target_id,
    });
    await this.authoriseArtifact(actor, artifact);
    await this.storage.getTable(actor, artifact.target_id);
    const recheck = async () => {
      await this.authorise(actor, "prepareImportUpload", {
        tableId: artifact.target_id,
      });
      await this.storage.getTable(actor, artifact.target_id);
    };
    const receipt = await this.artifacts.upload(
      actor,
      artifact,
      source,
      recheck,
    );
    await this.artifacts.finalizeUpload(
      actor,
      await this.artifacts.get(actor, id),
      null,
      {
        deadlineAt: Math.min(
          artifact.expires_at.getTime(),
          Date.now() + 600000,
        ),
        beforePublish: recheck,
      },
    );
    await recheck();
    return receipt;
  }

  private async historyPolicy(actor: Actor, tableId: string) {
    await this.storage.getTable(actor, tableId);
    const row = await withOrg(
      this.queue.pool,
      actor.orgId,
      async (client) =>
        (
          await client.query<HistoryPolicyRow>(
            "SELECT * FROM rootset_control.history_retention_policies WHERE table_id=$1",
            [tableId],
          )
        ).rows[0] ?? null,
    );
    return historyPolicyView(row);
  }

  private async setHistoryPolicy(
    actor: Actor,
    input: Record<string, unknown>,
    client?: PoolClient,
  ) {
    const table = await this.storage.getTable(actor, String(input.tableId));
    const cron = String(input.cron),
      timezone = String(input.timezone ?? "UTC");
    validateSchedule(cron, timezone);
    const days = Number(input.retentionDays),
      runtime = Number(input.maxRuntimeSeconds);
    if (
      !Number.isInteger(days) ||
      days < 1 ||
      days > 36500 ||
      !Number.isInteger(runtime) ||
      runtime < 60 ||
      runtime > 86400
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "History retention policy bounds are invalid",
      );
    const run = async (c: PoolClient) =>
      (
        await c.query<HistoryPolicyRow>(
          `INSERT INTO rootset_control.history_retention_policies(id,org_id,table_id,database_id,actor,enabled,retention_days,cron,timezone,max_runtime_seconds,next_occurrence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(table_id) DO UPDATE SET actor=excluded.actor,enabled=excluded.enabled,retention_days=excluded.retention_days,cron=excluded.cron,
      timezone=excluded.timezone,max_runtime_seconds=excluded.max_runtime_seconds,next_occurrence=excluded.next_occurrence,suspension_code=NULL,suspended_at=NULL,updated_at=now() RETURNING *`,
          [
            newId(),
            actor.orgId,
            table.id,
            table.databaseId,
            actor,
            input.enabled === true,
            days,
            cron,
            timezone,
            runtime,
            input.enabled
              ? previewSchedule(cron, timezone, new Date(), 1)[0]
              : null,
          ],
        )
      ).rows[0]!;
    return historyPolicyView(
      client
        ? await run(client)
        : await withOrg(this.queue.pool, actor.orgId, run),
    );
  }

  private async listHistoryArchives(
    actor: Actor,
    tableId: string,
    input: Record<string, unknown>,
  ) {
    await this.storage.getArchivedTable(actor, tableId);
    const paging = this.config.metadataPaging;
    if (!paging)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Metadata cursor signing is not configured",
        503,
      );
    const request = {
      resource: `history_archives:${actor.orgId}:${tableId}`,
      limit: Math.min(100, Math.max(1, Number(input.limit ?? 50))),
      cursor: typeof input.cursor === "string" ? input.cursor : null,
    };
    const position = paging.read(actor, request);
    const rows = await withOrg(
      this.queue.pool,
      actor.orgId,
      async (client) =>
        (
          await client.query<HistoryArchiveRecord>(
            "SELECT * FROM rootset_control.history_archives WHERE table_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3",
            [tableId, position.afterId, position.limit + 1],
          )
        ).rows,
    );
    const page = paging.paginate(rows, actor, request);
    return { data: page.data.map(archiveView), nextCursor: page.nextCursor };
  }

  private async getHistoryArchive(actor: Actor, tableId: string, id: string) {
    await this.storage.getArchivedTable(actor, tableId);
    const row = await withOrg(
      this.queue.pool,
      actor.orgId,
      async (client) =>
        (
          await client.query<HistoryArchiveRecord>(
            "SELECT * FROM rootset_control.history_archives WHERE table_id=$1 AND id=$2",
            [tableId, id],
          )
        ).rows[0],
    );
    if (!row)
      throw new RootsetError(
        "RESOURCE_NOT_FOUND",
        "History archive not found",
        404,
      );
    return archiveView(row);
  }

  async scheduleHistoryDue(orgId: string, now = new Date()): Promise<number> {
    return withOrg(this.queue.workerPool, orgId, async (client) => {
      const policies = (
        await client.query<HistoryPolicyRow>(
          "SELECT * FROM rootset_control.history_retention_policies WHERE enabled AND next_occurrence<=$1 FOR UPDATE SKIP LOCKED LIMIT 10",
          [now],
        )
      ).rows;
      let count = 0;
      for (const policy of policies) {
        let actor: Actor;
        try {
          actor = await this.authoriseHistoryPolicy(
            policy.actor,
            policy.table_id,
          );
        } catch (error) {
          if (
            !(error instanceof RootsetError) ||
            ![
              "UNAUTHENTICATED",
              "ACCESS_DENIED",
              "RESOURCE_NOT_FOUND",
            ].includes(error.code)
          )
            throw error;
          await client.query(
            "UPDATE rootset_control.history_retention_policies SET enabled=false,next_occurrence=NULL,suspension_code=$2,suspended_at=now(),updated_at=now() WHERE id=$1",
            [policy.id, error.code],
          );
          continue;
        }
        const occurrence = policy.next_occurrence!;
        if (
          !(
            await client.query(
              "SELECT 1 FROM rootset_control.history_archive_occurrences WHERE policy_id=$1 AND scheduled_at=$2",
              [policy.id, occurrence],
            )
          ).rowCount
        ) {
          const active = (
            await client.query(
              "SELECT 1 FROM rootset_control.jobs WHERE target_type='table' AND target_id=$1 AND kind='history_archive' AND state IN ('queued','running')",
              [policy.table_id],
            )
          ).rowCount;
          const job = active
            ? null
            : await this.queue.enqueue(
                actor,
                "archiveHistory",
                "history_archive",
                { type: "table", id: policy.table_id },
                {
                  tableId: policy.table_id,
                  before: new Date(
                    occurrence.getTime() - policy.retention_days * 86400000,
                  ).toISOString(),
                  policyId: policy.id,
                  scheduledAt: occurrence.toISOString(),
                  maxRuntimeSeconds: policy.max_runtime_seconds,
                },
                `history-schedule:${policy.id}:${occurrence.toISOString()}`,
                client,
              );
          await client.query(
            "INSERT INTO rootset_control.history_archive_occurrences(policy_id,scheduled_at,job_id,state) VALUES($1,$2,$3,$4)",
            [
              policy.id,
              occurrence,
              job?.id ?? null,
              job ? "enqueued" : "skipped_overlap",
            ],
          );
          if (job) count++;
        }
        await client.query(
          "UPDATE rootset_control.history_retention_policies SET next_occurrence=$2 WHERE id=$1",
          [
            policy.id,
            previewSchedule(policy.cron, policy.timezone, occurrence, 1)[0] ??
              null,
          ],
        );
      }
      return count;
    });
  }

  private authoriseHistoryPolicy(
    actor: Actor,
    tableId: string,
  ): Promise<Actor> {
    return this.config.authoriseHistoryPolicy
      ? this.config.authoriseHistoryPolicy(actor, { tableId })
      : this.authorise(actor, "archiveHistory", { tableId });
  }

  private async scheduledHistoryActor(job: JobRecord): Promise<Actor> {
    const policy = await withOrg(
      this.queue.workerPool,
      job.org_id,
      async (client) =>
        (
          await client.query<HistoryPolicyRow>(
            `SELECT p.* FROM rootset_control.history_retention_policies p JOIN rootset_control.history_archive_occurrences o ON o.policy_id=p.id
      WHERE p.id=$1 AND p.table_id=$2 AND o.job_id=$3 AND o.scheduled_at=$4::timestamptz AND o.state='enqueued'`,
            [job.input.policyId, job.target_id, job.id, job.input.scheduledAt],
          )
        ).rows[0],
    );
    if (!policy)
      throw new RootsetError(
        "ACCESS_DENIED",
        "Scheduled history archive does not have a valid persisted policy occurrence",
        403,
      );
    return this.authoriseHistoryPolicy(policy.actor, policy.table_id);
  }

  private async jobActor(job: JobRecord): Promise<Actor> {
    const actor =
      job.kind === "history_archive" && typeof job.input.policyId === "string"
        ? await this.scheduledHistoryActor(job)
        : await this.authorise(job.actor, job.operation_id, target(job));

    return actor;
  }

  private async reconciledDomain(
    job: JobRecord,
  ): Promise<JsonValue | undefined> {
    return withOrg<JsonValue | undefined>(
      this.queue.workerPool,
      job.org_id,
      async (client): Promise<JsonValue | undefined> => {
        if (job.kind === "history_archive") {
          const row = (
            await client.query<HistoryArchiveRecord>(
              "SELECT * FROM rootset_control.history_archives WHERE job_id=$1 AND table_id=$2 AND state='succeeded' AND verified_at IS NOT NULL",
              [job.id, job.target_id],
            )
          ).rows[0];
          if (row)
            return {
              archiveId: row.id,
              artifactId: row.artifact_id!,
              state: "succeeded",
              verifiedAt: row.verified_at!.toISOString(),
              cellEvents: Number(row.cell_count),
              rowEvents: Number(row.row_count),
            };
        }

        return undefined;
      },
    );
  }

  private async reconciledResult(
    job: JobRecord,
  ): Promise<JsonValue | undefined> {
    if (job.kind === "operation" && this.config.reconcileOperation) {
      const outcome = await this.config.reconcileOperation(job);
      if (outcome !== undefined) return outcome;
    }
    return this.reconciledDomain(job);
  }

  private async synchronizeTerminalRecords(orgId: string): Promise<void> {
    await withOrg(this.queue.workerPool, orgId, (client) =>
      client.query(
        "UPDATE rootset_control.history_archives a SET state=j.state,updated_at=now() FROM rootset_control.jobs j WHERE a.job_id=j.id AND j.state IN ('failed','cancelled') AND a.state NOT IN ('succeeded','failed','cancelled')",
      ),
    );
  }

  async cleanupArtifacts(orgId: string): Promise<number> {
    await this.artifacts.cleanupTemporaryFiles();
    await withOrg(this.queue.workerPool, orgId, async (client) => {
      await client.query(
        "SELECT set_config('idle_in_transaction_session_timeout','600000',true)",
      );
      const staleArchives = (
        await client.query<{
          id: string;
        }>(`SELECT j.id FROM rootset_control.jobs j JOIN rootset_control.history_archives a ON a.job_id=j.id
        WHERE j.state IN ('failed','cancelled') AND j.updated_at<now()-interval '24 hours' AND a.manifest IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM rootset_control.history_gaps g WHERE g.manifest->>'archiveId'=a.id)
        ORDER BY j.updated_at LIMIT 10 FOR UPDATE OF j SKIP LOCKED`)
      ).rows;
      for (const job of staleArchives)
        await client.query(
          "UPDATE rootset_control.history_archives SET manifest=NULL,artifact_id=NULL,verified_at=NULL,updated_at=now() WHERE job_id=$1",
          [job.id],
        );
    });
    const records = await withOrg(
      this.queue.workerPool,
      orgId,
      async (client) =>
        (
          await client.query<ArtifactRecord>(`SELECT a.* FROM rootset_control.artifacts a
      WHERE a.state<>'deleted' AND ((a.purpose<>'history-archive' AND a.expires_at<=now() AND a.state IN ('upload_pending','uploading','ready','failed','deleting')) OR a.metadata->>'cleanupPending'='true'
        OR (a.purpose='history-archive' AND a.created_at<now()-interval '24 hours'
          AND NOT EXISTS(SELECT 1 FROM rootset_control.history_archives h WHERE h.artifact_id=a.id)
          AND NOT EXISTS(SELECT 1 FROM rootset_control.history_gaps g WHERE g.manifest->>'artifactId'=a.id)))
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
      if (
        artifact.metadata.cleanupPending === true &&
        typeof artifact.metadata.finalizedArtifactId === "string"
      ) {
        const cleanupKey =
          typeof artifact.metadata.uploadedObjectKey === "string"
            ? artifact.metadata.uploadedObjectKey
            : artifact.object_key;
        if (!cleanupKey.startsWith(`rootset/${orgId}/`))
          throw new RootsetError(
            "ACCESS_DENIED",
            "Upload cleanup refused an object outside the owned organisation namespace",
            403,
          );
        await this.artifacts.client.send(
          new DeleteObjectCommand({
            Bucket: this.config.artifacts.bucket,
            Key: cleanupKey,
          }),
        );
        await withOrg(this.queue.workerPool, orgId, (client) =>
          client.query(
            "UPDATE rootset_control.artifacts SET metadata=metadata-'cleanupPending' WHERE id=$1",
            [artifact.id],
          ),
        );
      } else {
        await this.artifacts.remove(maintenance, artifact);
        removed++;
      }
    }
    return removed;
  }

  async runOnce(orgId: string): Promise<boolean> {
    const reconciled = await this.queue.reconcilePending(orgId, (job) =>
      this.reconciledResult(job),
    );

    const job = await this.queue.claim(orgId);
    await this.synchronizeTerminalRecords(orgId);

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
      if (job.kind === "operation" && this.config.reconcileOperation) {
        const prior = await this.config.reconcileOperation(job);
        if (prior !== undefined) {
          await this.queue.finish(job, "succeeded", prior);
          return true;
        }
      }
      const prior = await this.reconciledDomain(job);
      if (prior !== undefined) {
        await this.queue.finish(job, "succeeded", prior);
        return true;
      }
      const actor = await this.jobActor(job);
      if (job.cancel_requested) throw new JobCancelled();
      let result: JsonValue;
      if (job.kind === "history_archive")
        result = await this.archives.run(actor, job);
      else if (job.kind === "import" || job.kind === "validate_import") {
        let artifact = await this.artifacts.get(
          actor,
          String(job.checkpoint.artifactId ?? job.input.artifactId),
        );
        if (typeof artifact.metadata.finalizedArtifactId === "string")
          artifact = await this.artifacts.get(
            actor,
            artifact.metadata.finalizedArtifactId,
          );
        if (artifact.state === "upload_pending")
          artifact = await this.artifacts.finalizeUpload(actor, artifact, job);
        await this.queue.checkpoint(
          job,
          { ...job.checkpoint, artifactId: artifact.id },
          job.progress,
          job.kind === "import" ? "importing" : "validating",
        );
        result = await this.imports.run(
          actor,
          job,
          artifact,
          job.kind === "validate_import",
        );
      } else if (job.kind === "export") result = await this.export(actor, job);
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
      {
        await this.queue.fail(job, error);
        const terminal = await withOrg(
          this.queue.workerPool,
          orgId,
          async (client) =>
            (
              await client.query<{ state: string }>(
                "SELECT state FROM rootset_control.jobs WHERE id=$1",
                [job.id],
              )
            ).rows[0],
        );
        if (
          job.kind === "history_archive" &&
          ["failed", "cancelled"].includes(terminal?.state ?? "")
        )
          await withOrg(this.queue.workerPool, orgId, (client) =>
            client.query(
              "UPDATE rootset_control.history_archives SET state=$2,updated_at=now() WHERE job_id=$1",
              [job.id, terminal!.state],
            ),
          );
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async export(actor: Actor, job: JobRecord): Promise<JsonValue> {
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
    return snapshotTransaction(
      this.queue.workerPool,
      actor.orgId,
      table.databaseId,
      async (client) => {
        const source = await this.storage.snapshotTable!(
          actor,
          table.id,
          (job.input.query as Record<string, unknown>) ?? {},
          client,
        );
        const format = String(job.input.format);
        if (!["csv", "jsonl"].includes(format))
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Export format must be csv or jsonl",
          );
        const spreadsheetSafe = job.input.spreadsheetSafe === true;
        let rowCount = 0;
        const fields = source.table.fields;
        const checkCurrent = async () => {
          actor = await this.jobActor(job);
          await this.queue.fenced(job, async () => undefined);
        };
        const afterBatch = () =>
          this.config.failpoint?.("export.afterBatch", job.id);
        async function* records() {
          if (format === "csv")
            yield stringify([fields.map((field) => field.name)]);
          for await (const batch of source.rows) {
            await checkCurrent();
            for (const row of batch) {
              rowCount++;
              if (format === "jsonl")
                yield `${canonicalJson(row.values, { maxDepth: 96 })}\n`;
              else
                yield stringify(
                  [
                    fields.map((field) => {
                      const value = row.values[field.name];
                      let text =
                        value === null
                          ? "\\N"
                          : typeof value === "object"
                            ? canonicalJson(value)
                            : String(value);
                      if (
                        field.type === "text" &&
                        typeof value === "string" &&
                        text.startsWith("\\")
                      )
                        text = `\\${text}`;
                      if (
                        spreadsheetSafe &&
                        typeof value === "string" &&
                        /^[=+\-@\t\r]/.test(text)
                      )
                        text = `'${text}`;
                      return text;
                    }),
                  ],
                  { quoted_empty: true },
                );
            }
            await afterBatch();
          }
        }
        const artifact = await this.artifacts.write(
          actor,
          job,
          { type: "table", id: table.id },
          "export",
          format,
          format === "csv" ? "text/csv" : "application/x-ndjson",
          records(),
          {
            schemaVersion: table.schemaVersion,
            query: job.input.query ?? {},
            snapshot: "repeatable_read",
            spreadsheetSafe,
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
          schemaVersion: table.schemaVersion,
          snapshot: "repeatable_read",
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
        `INSERT INTO rootset_control.worker_heartbeats(id,state,last_error_code) VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),state=excluded.state,last_error_code=excluded.last_error_code`,
        [workerId, state, code],
      );
    };
    await heartbeat("starting");
    const workers = Array.from({ length: 2 }, async (_, index) => {
      while (!options.signal?.aborted) {
        try {
          const orgId = (
            await this.queue.workerPool.query<{ id: string }>(
              "SELECT id FROM rootset_control.organisations",
            )
          ).rows[0]?.id;
          let worked = false;
          let pollError: unknown;
          const activity = async (
            name: string,
            orgId: string | undefined,
            run: () => Promise<boolean | void>,
          ) => {
            try {
              worked = (await run()) === true || worked;
            } catch (error) {
              pollError = error;
              console.error(
                JSON.stringify({
                  level: "error",
                  event: "worker_activity_failed",
                  activity: name,
                  ...(orgId ? { orgId } : {}),
                  code:
                    error instanceof RootsetError
                      ? error.code
                      : "UPSTREAM_UNAVAILABLE",
                }),
              );
            }
          };
          if (orgId && !options.signal?.aborted) {
            if (index === 0)
              await activity("history_scheduler", orgId, async () => {
                await this.scheduleHistoryDue(orgId);
              });
            if (index === 0)
              await activity("artifact_cleanup", orgId, async () => {
                await this.cleanupArtifacts(orgId);
              });
            await activity("job", orgId, () => this.runOnce(orgId));
          }
          if (index === 0 && this.config.outbox)
            await activity("email_outbox", undefined, () =>
              this.config.outbox!.deliverNext(),
            );
          await heartbeat(
            pollError ? "degraded" : "ready",
            pollError instanceof RootsetError
              ? pollError.code
              : pollError
                ? "UPSTREAM_UNAVAILABLE"
                : null,
          );
          if (!worked)
            await delay(this.config.pollMilliseconds ?? 500, undefined, {
              ...(options.signal ? { signal: options.signal } : {}),
            });
        } catch (error) {
          if (options.signal?.aborted) break;
          await heartbeat(
            "degraded",
            error instanceof RootsetError ? error.code : "UPSTREAM_UNAVAILABLE",
          ).catch(() => undefined);
          console.error(
            JSON.stringify({
              level: "error",
              event: "worker_poll_failed",
              code:
                error instanceof RootsetError
                  ? error.code
                  : "UPSTREAM_UNAVAILABLE",
            }),
          );
          await delay(Math.min(5000, this.config.pollMilliseconds ?? 1000));
        }
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      await heartbeat("stopped");
    }
  }
}
