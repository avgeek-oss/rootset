import { createHash } from "node:crypto";
import {
  newId,
  OperationContextSchema,
  RootsetError,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";
import { withOrg, type Pool, type PoolClient } from "@rootset/database";
import { stableStringify, type JobRecord } from "./types.js";

export class LeaseLost extends Error {
  constructor() {
    super("The worker no longer owns this job lease");
  }
}
export class JobCancelled extends Error {
  constructor() {
    super("Cancellation was requested");
  }
}

function durableInput(input: Record<string, unknown>) {
  const result = { ...input };
  const correlation = input.operationContext;
  if (
    correlation &&
    typeof correlation === "object" &&
    !Array.isArray(correlation)
  ) {
    const retained = { ...(correlation as Record<string, unknown>) };
    delete retained.requestId;
    if (Object.values(retained).some((value) => value !== undefined))
      result.operationContext = retained;
    else delete result.operationContext;
  }
  return result;
}

export class DurableQueue {
  constructor(
    readonly pool: Pool,
    readonly workerPool: Pool,
    readonly leaseSeconds = 30,
    readonly maxAttempts = 3,
    private readonly admission?: (
      actor: Actor,
      operationId: string,
      key: string,
      client?: PoolClient,
    ) =>
      | {
          binding: string;
          fields: string[];
          source?: string;
          operatorRepair: boolean;
        }
      | undefined,
  ) {}

  authenticInput(job: JobRecord): boolean {
    const digest = (input: Record<string, unknown>) =>
      createHash("sha256")
        .update(
          stableStringify({
            actor: job.requester_id,
            orgId: job.org_id,
            operationId: job.operation_id,
            target: { type: job.target_type, id: job.target_id },
            input,
          }),
        )
        .digest("hex");
    return digest(durableInput(job.input)) === job.input_digest;
  }

  async enqueue(
    actor: Actor,
    operationId: string,
    kind: string,
    target: { type: JobRecord["target_type"]; id: string },
    input: Record<string, unknown>,
    idempotencyKey: string,
    client?: PoolClient,
  ): Promise<JobRecord> {
    if (
      !OperationContextSchema.shape.idempotencyKey.safeParse(idempotencyKey)
        .success ||
      !idempotencyKey
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "A bounded idempotency key is required",
      );
    const provenance = this.admission?.(
      actor,
      operationId,
      idempotencyKey,
      client,
    );
    const context = input.operationContext;
    const originalContext =
      context && typeof context === "object" && !Array.isArray(context)
        ? (context as Record<string, unknown>)
        : {};
    if (
      Object.hasOwn(originalContext, "admissionBinding") ||
      Object.hasOwn(originalContext, "admissionFields") ||
      Object.hasOwn(originalContext, "admissionSource") ||
      Object.hasOwn(originalContext, "admissionStepUpApproved")
    )
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Queued admission provenance is reserved",
        500,
      );
    const admittedSource = provenance?.operatorRepair
      ? "operator"
      : provenance?.source;
    if (
      provenance &&
      ((originalContext.source !== undefined &&
        originalContext.source !== admittedSource) ||
        (originalContext.idempotencyKey !== undefined &&
          originalContext.idempotencyKey !== idempotencyKey))
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Queued admission context does not match the admitted request",
        403,
      );
    const persistedInput: Record<string, unknown> = {
      ...input,
      ...(provenance
        ? {
            operationContext: {
              ...originalContext,
              admissionBinding: provenance.binding,
              admissionFields: provenance.fields,
              admissionSource: provenance.source ?? null,
              idempotencyKey,
              ...(admittedSource ? { source: admittedSource } : {}),
            },
          }
        : {}),
    };
    const requesterId = `${actor.kind}:${actor.id}`;
    const digestInput = (
      value: Record<string, unknown>,
      boundTarget = target,
    ) =>
      createHash("sha256")
        .update(
          stableStringify({
            actor: requesterId,
            orgId: actor.orgId,
            operationId,
            target: boundTarget,
            input: value,
          }),
        )
        .digest("hex");
    const digest = digestInput(durableInput(persistedInput));
    const run = async (connection: PoolClient) => {
      const inserted = await connection.query<JobRecord>(
        `INSERT INTO rootset_control.jobs
        (id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key,max_attempts)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(org_id,requester_id,operation_id,idempotency_key) DO NOTHING RETURNING *`,
        [
          newId(),
          actor.orgId,
          kind,
          operationId,
          actor,
          requesterId,
          target.type,
          target.id,
          persistedInput,
          digest,
          idempotencyKey,
          this.maxAttempts,
        ],
      );
      const existing =
        inserted.rows[0] ??
        (
          await connection.query<JobRecord>(
            `SELECT * FROM rootset_control.jobs WHERE org_id=$1 AND requester_id=$2 AND operation_id=$3 AND idempotency_key=$4`,
            [actor.orgId, requesterId, operationId, idempotencyKey],
          )
        ).rows[0];
      const matches =
        existing &&
        this.authenticInput(existing) &&
        existing.input_digest === digest;
      if (!matches)
        throw new RootsetError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key has different job input",
          409,
        );
      return existing;
    };
    return client ? run(client) : withOrg(this.pool, actor.orgId, run);
  }

  async claim(
    orgId: string,
    backupBackendId: string | null = null,
  ): Promise<JobRecord | null> {
    return withOrg(this.workerPool, orgId, async (client) => {
      const result = await client.query<JobRecord>(
        `WITH candidate AS (
        SELECT id FROM rootset_control.jobs WHERE org_id=$1
          AND ((state='queued' AND next_attempt_at<=now()) OR (state='running' AND lease_until<now()))
          AND (kind NOT IN ('database_backup','backup_destination_test','database_restore_preview','database_restore') OR ($4::text IS NOT NULL AND input->>'backendId'=$4))
          AND attempt<max_attempts ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE rootset_control.jobs j SET state='running',stage=CASE WHEN j.state='running' THEN 'recovering' ELSE j.stage END,
          attempt=attempt+1,lease_token=$2,lease_until=now()+$3*interval '1 second',heartbeat_at=now(),updated_at=now()
        FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
        [orgId, newId(), this.leaseSeconds, backupBackendId],
      );
      await client.query(
        `UPDATE rootset_control.jobs SET state=CASE WHEN coalesce((progress->>'committed')::bigint,0)>0 THEN 'partially_completed' ELSE 'failed' END,
        result=CASE WHEN coalesce((progress->>'committed')::bigint,0)>0 THEN jsonb_build_object('partial',true,'committed',coalesce((progress->>'committed')::bigint,0),'rejected',coalesce((progress->>'rejected')::bigint,0),'reason','lease_exhausted') ELSE result END,
        stage='lease_exhausted',lease_token=NULL,lease_until=NULL,error='{"code":"JOB_FAILED","message":"The worker lease expired after the last allowed attempt"}',completed_at=now(),updated_at=now()
        WHERE org_id=$1 AND state='running' AND lease_until<now() AND attempt>=max_attempts`,
        [orgId],
      );
      return result.rows[0] ?? null;
    });
  }

  async reconcilePending(
    orgId: string,
    resolve: (job: JobRecord) => Promise<JsonValue | undefined>,
  ): Promise<JobRecord[]> {
    return withOrg(this.workerPool, orgId, async (client) => {
      const candidates = (
        await client.query<JobRecord>(
          "SELECT * FROM rootset_control.jobs WHERE org_id=$1 AND ((state='queued' AND attempt>0) OR (state='running' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 25",
          [orgId],
        )
      ).rows;
      const completed: JobRecord[] = [];
      for (const job of candidates) {
        const result = await resolve(job);
        if (result === undefined) continue;
        const saved = await client.query<JobRecord>(
          "UPDATE rootset_control.jobs SET state='succeeded',stage='reconciled',result=$2,error=NULL,lease_token=NULL,lease_until=NULL,completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
          [job.id, result],
        );
        completed.push(saved.rows[0]!);
      }
      return completed;
    });
  }

  async heartbeat(job: JobRecord): Promise<boolean> {
    return withOrg(this.workerPool, job.org_id, async (client) => {
      const result = await client.query(
        `UPDATE rootset_control.jobs SET lease_until=now()+$4*interval '1 second',heartbeat_at=now(),updated_at=now()
        WHERE id=$1 AND org_id=$2 AND lease_token=$3 AND state='running' AND lease_until>now() RETURNING id`,
        [job.id, job.org_id, job.lease_token, this.leaseSeconds],
      );
      return result.rowCount === 1;
    });
  }

  async fenced<T>(
    job: JobRecord,
    operation: (client: PoolClient, current: JobRecord) => Promise<T>,
    options: { allowCancelled?: boolean; allowExpiredDeadline?: boolean } = {},
  ): Promise<T> {
    if (
      !options.allowExpiredDeadline &&
      job.deadline !== undefined &&
      Date.now() > job.deadline
    )
      throw new RootsetError(
        "JOB_FAILED",
        "The operation exceeded its configured maximum runtime",
        408,
      );
    return withOrg(this.workerPool, job.org_id, async (client) => {
      const current = (
        await client.query<JobRecord>(
          "SELECT * FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [job.id, job.org_id],
        )
      ).rows[0];
      if (
        !current ||
        current.state !== "running" ||
        current.lease_token !== job.lease_token ||
        !current.lease_until ||
        current.lease_until.getTime() <= Date.now()
      )
        throw new LeaseLost();
      if (current.cancel_requested && !options.allowCancelled)
        throw new JobCancelled();
      return operation(client, current);
    });
  }

  async checkpoint(
    job: JobRecord,
    checkpoint: Record<string, unknown>,
    progress: JobRecord["progress"],
    stage?: string,
  ): Promise<void> {
    await this.fenced(job, async (client) => {
      await client.query(
        `UPDATE rootset_control.jobs SET checkpoint=$2,progress=$3,stage=coalesce($4,stage),updated_at=now() WHERE id=$1`,
        [job.id, checkpoint, progress, stage ?? null],
      );
    });
    job.checkpoint = checkpoint;
    job.progress = progress;
    if (stage) job.stage = stage;
  }

  async finish(
    job: JobRecord,
    state: string,
    result: JsonValue,
    stage = state,
  ): Promise<void> {
    await this.fenced(
      job,
      async (client) => {
        await client.query(
          `UPDATE rootset_control.jobs SET state=$2,stage=$3,result=$4,error=NULL,lease_token=NULL,lease_until=NULL,completed_at=now(),updated_at=now() WHERE id=$1`,
          [job.id, state, stage, result],
        );
      },
      { allowCancelled: true, allowExpiredDeadline: true },
    );
  }

  async fail(job: JobRecord, error: unknown): Promise<void> {
    if (error instanceof LeaseLost) return;
    const safeError =
      error instanceof RootsetError
        ? error.toJSON()
        : {
            code: "JOB_FAILED",
            message:
              error instanceof JobCancelled
                ? "Cancellation was requested"
                : "The background operation failed; inspect redacted worker logs",
          };
    const transient =
      (!(error instanceof RootsetError) && !(error instanceof JobCancelled)) ||
      (error instanceof RootsetError &&
        ["UPSTREAM_UNAVAILABLE", "RATE_LIMITED"].includes(error.code));
    await withOrg(this.workerPool, job.org_id, async (client) => {
      const current = (
        await client.query<JobRecord>(
          "SELECT * FROM rootset_control.jobs WHERE id=$1 AND lease_token=$2 FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rows[0];
      if (
        !current ||
        current.state !== "running" ||
        !current.lease_until ||
        current.lease_until.getTime() <= Date.now()
      )
        return;
      const partial = Number(current.progress.committed ?? 0) > 0;
      const retry =
        transient &&
        current.attempt < current.max_attempts &&
        !current.cancel_requested;
      const state = retry
        ? "queued"
        : partial
          ? "partially_completed"
          : current.cancel_requested || error instanceof JobCancelled
            ? "cancelled"
            : "failed";
      const partialResult = partial
        ? {
            committed: Number(current.progress.committed ?? 0),
            rejected: Number(current.progress.rejected ?? 0),
            partial: true,
            cancelled:
              current.cancel_requested || error instanceof JobCancelled,
          }
        : null;
      await client.query(
        `UPDATE rootset_control.jobs SET state=$2,stage=$3,error=$4,lease_token=NULL,lease_until=NULL,
        next_attempt_at=now()+$5*interval '1 second',completed_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,result=coalesce($6,result),updated_at=now() WHERE id=$1`,
        [
          job.id,
          state,
          retry ? "retry_wait" : state,
          safeError,
          Math.min(300, 2 ** current.attempt),
          partialResult,
        ],
      );
    });
  }

  async cancel(
    actor: Actor,
    id: string,
    resolve?: (job: JobRecord) => Promise<JsonValue | undefined>,
    suppliedClient?: PoolClient,
  ): Promise<JobRecord> {
    const run = async (client: PoolClient) => {
      const locked = (
        await client.query<JobRecord>(
          "SELECT * FROM rootset_control.jobs WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (locked?.state === "queued" && resolve) {
        const outcome = await resolve(locked);
        if (outcome !== undefined)
          return (
            await client.query<JobRecord>(
              "UPDATE rootset_control.jobs SET state='succeeded',stage='reconciled',result=$2,error=NULL,completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
              [id, outcome],
            )
          ).rows[0]!;
      }
      const record = (
        await client.query<JobRecord>(
          `UPDATE rootset_control.jobs SET cancel_requested=true,
        state=CASE WHEN state='queued' THEN CASE WHEN coalesce((progress->>'committed')::bigint,0)>0 THEN 'partially_completed' ELSE 'cancelled' END ELSE state END,
        result=CASE WHEN state='queued' AND coalesce((progress->>'committed')::bigint,0)>0 THEN jsonb_build_object('committed',coalesce((progress->>'committed')::bigint,0),'rejected',coalesce((progress->>'rejected')::bigint,0),'partial',true,'cancelled',true) ELSE result END,
        completed_at=CASE WHEN state='queued' THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1 AND state IN ('queued','running') RETURNING *`,
          [id],
        )
      ).rows[0];
      if (record) return record;
      const previous = (
        await client.query<JobRecord>(
          "SELECT * FROM rootset_control.jobs WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!previous)
        throw new RootsetError("RESOURCE_NOT_FOUND", "Job not found", 404);
      return previous;
    };
    return suppliedClient
      ? run(suppliedClient)
      : withOrg(this.pool, actor.orgId, run);
  }

  async retry(
    actor: Actor,
    id: string,
    suppliedClient?: PoolClient,
  ): Promise<JobRecord> {
    const run = async (client: PoolClient) => {
      const record = (
        await client.query<JobRecord>(
          `UPDATE rootset_control.jobs SET state='queued',stage='retry_queued',attempt=0,
        cancel_requested=false,lease_token=NULL,lease_until=NULL,error=NULL,next_attempt_at=now(),completed_at=NULL,updated_at=now()
        WHERE id=$1 AND state IN ('failed','partially_completed','cancelled') RETURNING *`,
          [id],
        )
      ).rows[0];
      if (!record)
        throw new RootsetError(
          "JOB_FAILED",
          "Only terminal failed, cancelled or partial jobs can be retried",
          409,
        );
      return record;
    };
    return suppliedClient
      ? run(suppliedClient)
      : withOrg(this.pool, actor.orgId, run);
  }
}

export async function snapshotTransaction<T>(
  pool: Pool,
  orgId: string,
  databaseId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let discard = false;
  let connectionError: Error | undefined;
  const onConnectionError = (error: Error) => {
    connectionError ??= error;
    discard = true;
  };
  client.on("error", onConnectionError);
  try {
    // Acquire before BEGIN: a SELECT set_config can establish a repeatable
    // snapshot before a transactional barrier has actually acquired its lock.
    await client.query(
      "SELECT pg_advisory_lock_shared(hashtextextended($1,0))",
      [databaseId],
    );
    locked = true;
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('rootset.org_id',$1,true)", [orgId]);
    const result = await run(client);
    if (connectionError) throw connectionError;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (!connectionError) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    throw connectionError ?? error;
  } finally {
    if (locked && !connectionError) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock_shared(hashtextextended($1,0))",
          [databaseId],
        );
      } catch {
        discard = true;
      }
    }
    client.release(discard);
    client.removeListener("error", onConnectionError);
  }
}
