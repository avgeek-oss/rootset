import { createHmac } from "node:crypto";
import {
  canonicalJson,
  IdSchema,
  limits,
  RootsetError,
  ViewPreferencesResultSchema,
  type Actor,
} from "@rootset/contracts";
import { type PoolClient, type Queryable } from "@rootset/database";

export const identityMutationSet: ReadonlySet<string> = new Set([
  "updateProfile",
  "updatePreferences",
  "updateViewPreferences",
  "revokeSession",
  "revokeConnection",
  "updateOrganisation",
  "updateMember",
  "removeMember",
  "inviteMember",
  "cancelInvitation",
  "revokePersonalKey",
  "revokeTeamKey",
  "changePassword",
  "changeEmail",
  "signOutEverywhere",
]);
export const jobsMutationSet: ReadonlySet<string> = new Set([
  "cancelJob",
  "retryJob",
]);
export const queuedMutationSet: ReadonlySet<string> = new Set([
  "deleteDatabase",
  "deleteTable",
  "applySchemaChange",
  "createUniqueRule",
  "createForeignKey",
  "updateField",
  "deleteField",
  "countRows",
  "exportRows",
]);
export const mutationSet: ReadonlySet<string> = new Set([
  ...identityMutationSet,
  ...jobsMutationSet,
  ...queuedMutationSet,
]);

export type MutationLookup =
  { found: false } | { found: true; result: unknown };

export function operationAdmissionBinding(
  actor: Actor,
  operationId: string,
  input: Record<string, unknown>,
  key: string,
  secret: string,
  context: { source?: string } = {},
): string {
  binding(actor, operationId, input, key, secret);
  return (
    "v1:" +
    createHmac("sha256", secret)
      .update("rootset:queued-admission:v1:")
      .update(
        canonicalJson(
          {
            orgId: actor.orgId,
            principal: {
              kind: actor.kind,
              id: actor.id,
              userId: actor.userId ?? null,
              credentialId: actor.credentialId ?? null,
              clientId: actor.clientId ?? null,
            },
            operationId,
            key,
            input: inputValue(input),
            context: {
              source: context.source ?? null,
            },
          },
          { maxDepth: 96 },
        ),
      )
      .digest("hex")
  );
}

export async function lockOperationAdmission(
  client: PoolClient,
  actor: Actor,
  operationId: string,
  key: string,
  secret: string,
): Promise<void> {
  const lock = binding(actor, operationId, {}, key, secret)
    .slice(0, 4)
    .join(":");
  const state = (
    await client.query<{ value: string; active: boolean }>(
      "SELECT current_setting('lock_timeout') AS value,transaction_timestamp()<>statement_timestamp() AS active",
    )
  ).rows[0];
  if (!state?.active)
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "Queued admission requires an active transaction",
      500,
    );
  const milliseconds = /^\d+(ms)?$/.test(state.value)
    ? Number.parseInt(state.value, 10)
    : undefined;
  await client.query("SELECT set_config('lock_timeout',$1,true)", [
    milliseconds && milliseconds < 2000 ? state.value : "2000ms",
  ]);
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "rootset:queued-admission:" + lock,
    ]);
    await client.query("SELECT set_config('lock_timeout',$1,true)", [
      state.value,
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === "55P03")
      throw new RootsetError(
        "DEPENDENCY_UNAVAILABLE",
        "An identical admission is still running; retry the unchanged request",
        503,
        { retryable: true },
      );
    throw error;
  }
}

function inputValue(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
function binding(
  actor: Actor,
  operationId: string,
  input: unknown,
  key: string,
  secret: string,
): string[] {
  if (secret.length < 32 || !/^[A-Za-z][A-Za-z0-9]{0,119}$/.test(operationId))
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "Mutation replay binding is not configured",
      500,
    );
  if (key.length < 8 || key.length > 255 || /[\u0000-\u001f\u007f]/.test(key))
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Idempotency-Key must contain between 8 and 255 printable characters",
      400,
    );
  const hmac = (domain: string, value: unknown) =>
    createHmac("sha256", secret)
      .update(`rootset:control-replay:v1:${domain}:`)
      .update(canonicalJson(value, { maxDepth: 96 }))
      .digest("hex");
  return [
    IdSchema.parse(actor.orgId),
    hmac("principal", {
      kind: actor.kind,
      id: actor.id,
      userId: actor.userId ?? null,
      credentialId: actor.credentialId ?? null,
      clientId: actor.clientId ?? null,
    }),
    operationId,
    hmac("key", key),
    hmac("input", inputValue(input)),
  ];
}
function conflict(): never {
  throw new RootsetError(
    "IDEMPOTENCY_CONFLICT",
    "The idempotency key belongs to a different request",
    409,
  );
}
export function stripMutationSecrets(value: unknown): unknown {
  const json = JSON.stringify(value, (key, item: unknown) =>
    /^(?:new_?password|current_?password|password(?:_?hash)?|(?:key|client|totp|one_?time)?_?secret|token|(?:access|refresh|id)_?token|(?:recovery|backup)_?codes?|private_?key|totp_?(?:uri|code)|verification_?code|authorization_?code|one_?time_?code)$/i.test(
      key,
    )
      ? undefined
      : item,
  );
  if (json === undefined)
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "A mutating operation returned no replayable outcome",
      500,
    );
  return JSON.parse(json) as unknown;
}

function mutationOutcome(operationId: string, value: unknown): unknown {
  if (operationId !== "updateViewPreferences")
    return stripMutationSecrets(value);
  const result = ViewPreferencesResultSchema.safeParse(value);
  if (!result.success)
    throw new RootsetError(
      "INTERNAL_ERROR",
      "The view preference mutation returned an invalid outcome",
      500,
    );
  return result.data;
}

/** Reauthorise the current principal and target before any replay lookup. */
export async function lookupMutation(
  connection: Queryable,
  actor: Actor,
  operationId: string,
  input: unknown,
  key: string,
  secret: string,
): Promise<MutationLookup> {
  const parameters = binding(actor, operationId, input, key, secret);
  const row = (
    await connection.query<{ input_digest: string; outcome: unknown }>(
      "SELECT input_digest,outcome FROM rootset_control.control_mutation_replays WHERE org_id=$1 AND principal_binding=$2 AND operation_id=$3 AND key_digest=$4 AND expires_at>clock_timestamp() AND outcome IS NOT NULL",
      parameters.slice(0, 4),
    )
  ).rows[0];
  if (!row) return { found: false };
  if (row.input_digest !== parameters[4]) conflict();
  return { found: true, result: row.outcome };
}

/** Use an active organisation transaction; the receipt and effects commit together. */
export async function runMutation<T>(
  client: PoolClient,
  actor: Actor,
  operationId: string,
  input: unknown,
  key: string,
  secret: string,
  work: () => Promise<T>,
): Promise<T> {
  const parameters = binding(actor, operationId, input, key, secret);
  const transactionState = (
    await client.query<{ value: string; active: boolean }>(
      "SELECT current_setting('lock_timeout') AS value,transaction_timestamp()<>statement_timestamp() AS active",
    )
  ).rows[0]!;
  if (!transactionState.active)
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "Mutation replay requires an active transaction",
      500,
    );
  const oldTimeout = transactionState.value;
  const oldMilliseconds = /^\d+(ms)?$/.test(oldTimeout)
    ? Number.parseInt(oldTimeout, 10)
    : undefined;
  await client.query("SELECT set_config('lock_timeout',$1,true)", [
    oldMilliseconds && oldMilliseconds < 2000 ? oldTimeout : "2000ms",
  ]);
  try {
    await client.query(
      "INSERT INTO rootset_control.control_mutation_replays(org_id,principal_binding,operation_id,key_digest,input_digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      parameters,
    );
    const row = (
      await client.query<{
        input_digest: string;
        outcome: unknown;
        completed: boolean;
        expired: boolean;
      }>(
        "SELECT input_digest,outcome,outcome IS NOT NULL AS completed,expires_at<=clock_timestamp() AS expired FROM rootset_control.control_mutation_replays WHERE org_id=$1 AND principal_binding=$2 AND operation_id=$3 AND key_digest=$4 FOR UPDATE",
        parameters.slice(0, 4),
      )
    ).rows[0];
    if (!row)
      throw new RootsetError(
        "ACCESS_DENIED",
        "Mutation replay is outside the active organisation",
        403,
      );
    await client.query("SELECT set_config('lock_timeout',$1,true)", [
      oldTimeout,
    ]);
    if (!row.expired && row.input_digest !== parameters[4]) conflict();
    if (!row.expired && row.completed) return row.outcome as T;
    if (row.expired)
      await client.query(
        "UPDATE rootset_control.control_mutation_replays SET input_digest=$5,outcome=NULL,created_at=now(),expires_at=now()+$6::bigint*interval '1 millisecond' WHERE org_id=$1 AND principal_binding=$2 AND operation_id=$3 AND key_digest=$4",
        [...parameters, limits.idempotencyLifetimeMs],
      );
    const result = mutationOutcome(operationId, await work()) as T;
    await client.query(
      "UPDATE rootset_control.control_mutation_replays SET outcome=$5::jsonb WHERE org_id=$1 AND principal_binding=$2 AND operation_id=$3 AND key_digest=$4",
      [...parameters.slice(0, 4), JSON.stringify(result)],
    );
    return result;
  } catch (error) {
    if ((error as { code?: string })?.code === "55P03")
      throw new RootsetError(
        "DEPENDENCY_UNAVAILABLE",
        "An identical mutation is still running; retry the unchanged request",
        503,
        { retryable: true },
      );
    throw error;
  }
}
