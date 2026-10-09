import {
  getOperation,
  limits,
  operatorsByType,
  operationMap,
  assertValueLexemes,
  assertFieldDefinitionLexemes,
  assertQueryLexemes,
  newId,
  RootsetError,
  QuerySpecSchema,
  FieldInputSchema,
  type Actor,
  type FieldDefinition,
  type NumberLexeme,
  type JsonValue,
  type Row,
} from "@rootset/contracts";
import { assertAccess } from "@rootset/access";
import { withOrg, type Pool, type PoolClient } from "@rootset/database";
import type { IdentityService } from "@rootset/identity";
import {
  lookupMutation,
  mutationSet,
  resolveAdmissionApproval,
} from "@rootset/idempotency";
import type {
  TableStorage,
  DatabaseRecord,
  TableRecord,
  MutationOptions,
  SchemaOptions,
  RowOperation,
  UniqueRule,
  IndexRecord,
  FieldInput,
} from "@rootset/table-storage";
import type { JobsService } from "@rootset/jobs";
import type { Config } from "./config.js";
import { MetadataPaging } from "./paging.js";
import { readUsage } from "./usage.js";
import { mapSchemaJournal } from "./schema-journal.js";

export interface OperationContext {
  requestId?: string;
  idempotencyKey?: string;
  actionId?: string;
  surface?: "browser" | "rest" | "mcp" | "worker" | "operator";
  responseBudget?: number;
  request?: Request;
  signal?: AbortSignal;
  jobId?: string;
  jobFence?: { jobId: string; leaseToken: string };
  beforePublish?: () => Promise<void>;
  admissionSource?: string;
  numericLexemes?: readonly NumberLexeme[];
  approvalClient?: PoolClient;
}
export function readSignal(context: {
  request?: Request;
  signal?: AbortSignal;
}): AbortSignal | undefined {
  const requestSignal = context.request?.signal;
  return context.signal && requestSignal && context.signal !== requestSignal
    ? AbortSignal.any([requestSignal, context.signal])
    : (context.signal ?? requestSignal);
}
function assertReadOpen(context: OperationContext): void {
  if (readSignal(context)?.aborted)
    throw new RootsetError(
      "REQUEST_TIMEOUT",
      "Client request ended before its table read completed",
      408,
    );
}
export interface CoreOptions {
  storage: TableStorage;
  identity: IdentityService;
  jobs: JobsService;
  pool: Pool;
  identityPool: Pool;
  config: Config;
  paging?: MetadataPaging;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RootsetError("VALIDATION_FAILED", "Expected an object");
  return value as Record<string, unknown>;
};
const str = (value: unknown): string => {
  if (typeof value !== "string")
    throw new RootsetError("VALIDATION_FAILED", "Expected a string");
  return value;
};
const num = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RootsetError("VALIDATION_FAILED", "Expected a finite number");
  return value;
};
const iso = (value: unknown): string =>
  new Date(value as string | number | Date).toISOString();
const rowPublic = (value: Row): Row => ({
  id: value.id,
  version: value.version,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
  values: value.values,
});
const databasePublic = (d: DatabaseRecord) => ({
  id: d.id,
  orgId: d.orgId,
  name: d.name,
  description: d.description,
  state: d.state,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});
const tablePublic = (t: TableRecord) => ({
  id: t.id,
  orgId: t.orgId,
  databaseId: t.databaseId,
  name: t.name,
  description: t.description,
  schemaVersion: t.schemaVersion,
  rowCount: t.rowCount,
  state: t.state,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});
const rulePublic = (r: UniqueRule) => ({
  id: r.id,
  tableId: r.tableId,
  fieldIds: r.fieldIds,
  nullPolicy: "distinct",
  strategy: r.strategy,
  state: r.state,
  ...(r.error
    ? { error: typeof r.error === "string" ? r.error : JSON.stringify(r.error) }
    : {}),
});
const indexPublic = (i: IndexRecord) => ({
  id: i.id,
  tableId: i.tableId,
  fieldIds: [i.fieldId],
  kind: i.kind === "json" ? "jsonb" : i.kind,
  state: i.state,
});
function mutationOptions(
  input: Record<string, unknown>,
  ctx: OperationContext,
): MutationOptions {
  const source =
    ctx.surface === "browser"
      ? "ui"
      : ctx.surface === "mcp"
        ? "mcp"
        : ctx.surface === "worker"
          ? "schema"
          : ctx.surface === "operator"
            ? "operator"
            : "rest";
  return {
    idempotencyKey: ctx.idempotencyKey,
    expectedSchemaVersion:
      typeof input.expectedSchemaVersion === "number"
        ? input.expectedSchemaVersion
        : undefined,
    context: {
      requestId: ctx.requestId,
      source,
      jobId: ctx.jobId,
      jobFence: ctx.jobFence,
      beforePublish: ctx.beforePublish,
    },
  };
}
function schemaOptions(
  input: Record<string, unknown>,
  ctx: OperationContext,
): SchemaOptions {
  return {
    ...mutationOptions(input, ctx),
    expectedSchemaVersion: num(input.expectedSchemaVersion),
  };
}
function mutations(input: unknown): RowOperation[] {
  if (!Array.isArray(input))
    throw new RootsetError("VALIDATION_FAILED", "Expected mutation array");
  return input.map((value) => {
    const r = record(value);
    if (r.type === "create")
      return {
        kind: "create",
        values: record(r.values) as Record<string, JsonValue>,
      };
    if (r.type === "update")
      return {
        kind: "update",
        rowId: str(r.rowId),
        expectedVersion: str(r.expectedVersion),
        values: record(r.values) as Record<string, JsonValue>,
      };
    if (r.type === "delete")
      return {
        kind: "delete",
        rowId: str(r.rowId),
        expectedVersion: str(r.expectedVersion),
      };
    throw new RootsetError("VALIDATION_FAILED", "Unsupported mutation type");
  });
}
const asynchronous = new Set([
  "deleteDatabase",
  "deleteTable",
  "applySchemaChange",
  "createIndex",
  "createUniqueRule",
  "updateField",
  "deleteField",
  "countRows",
]);
const queuedFamilies = new Set(["validateImport", "importRows", "exportRows"]);
const jobOperations = new Set([
  "prepareImportUpload",
  "validateImport",
  "importRows",
  "exportRows",
  "getArtifact",
  "listJobs",
  "getJob",
  "cancelJob",
  "retryJob",
]);

export class RootsetCore {
  readonly paging: MetadataPaging;
  constructor(readonly options: CoreOptions) {
    this.paging =
      options.paging ?? new MetadataPaging(options.config.cursorSecret);
  }
  async authorise(
    incoming: Actor,
    operationId: string,
    input: Record<string, unknown>,
  ): Promise<Actor> {
    const actor = await this.options.identity.refreshActor(incoming),
      op = getOperation(operationId);
    const orgId = typeof input.orgId === "string" ? input.orgId : actor.orgId;
    let databaseId =
      typeof input.databaseId === "string" ? input.databaseId : undefined;
    const tableId =
      typeof input.tableId === "string" ? input.tableId : undefined;
    const destructiveReplay =
      operationId === "deleteDatabase" || operationId === "deleteTable";
    if (tableId) {
      const table = await (destructiveReplay
        ? this.options.storage.getArchivedTable(actor, tableId)
        : this.options.storage.getTable(actor, tableId));
      if (databaseId && table.databaseId !== databaseId)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Resource was not found",
          404,
        );
      databaseId = table.databaseId;
    }
    if (databaseId) {
      await (destructiveReplay
        ? this.options.storage.getArchivedDatabase(actor, databaseId)
        : this.options.storage.getDatabase(actor, databaseId));
    }
    for (const scope of op.scopes) {
      assertAccess(actor, {
        scope,
        orgId,
        personal: op.personal,
        ...(!op.personal && op.minimumRole === "admin"
          ? { roles: ["admin"] }
          : {}),
      });
    }
    if (orgId !== actor.orgId)
      throw new RootsetError(
        "RESOURCE_NOT_FOUND",
        "Resource was not found",
        404,
      );
    if (operationId === "mutateRows" && input.repair !== undefined)
      assertAccess(actor, {
        scope: "installation:manage",
        roles: ["admin"],
        personal: true,
        orgId,
      });

    return actor;
  }
  async execute(
    operationId: string,
    actor: Actor,
    value: unknown,
    context: OperationContext = {},
  ): Promise<unknown> {
    return this.run(operationId, actor, value, context, false);
  }
  async executeWorker(
    operationId: string,
    actor: Actor,
    value: unknown,
    context: OperationContext = {},
  ): Promise<unknown> {
    const input = { ...record(value) };
    delete input.operationContext;
    return this.run(
      operationId,
      actor,
      input,
      {
        ...context,
        surface: "worker",
        beforePublish: async () => {
          await this.authorise(actor, operationId, input);
        },
      },
      true,
    );
  }
  async recordOperationOutcome(
    client: PoolClient,
    actor: Actor,
    operationId: string,
    context: OperationContext,
    result: unknown,
  ) {
    if (!context.jobId) return;
    const recorded = await client.query(
      "INSERT INTO rootset_control.operation_outcomes(job_id,org_id,operation_id,job_input_digest,result) SELECT id,org_id,operation_id,input_digest,$4::jsonb FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 AND operation_id=$3 ON CONFLICT(job_id) DO NOTHING",
      [context.jobId, actor.orgId, operationId, JSON.stringify(result)],
    );
    if (!recorded.rowCount) {
      const previous = (
        await client.query<{ operation_id: string; result: unknown }>(
          "SELECT operation_id,result FROM rootset_control.operation_outcomes WHERE job_id=$1 AND org_id=$2",
          [context.jobId, actor.orgId],
        )
      ).rows[0];
      if (!previous || previous.operation_id !== operationId)
        throw new RootsetError(
          "JOB_FAILED",
          "The durable operation outcome could not be bound to this job",
          500,
        );
    }
  }
  private async run(
    operationId: string,
    incoming: Actor,
    value: unknown,
    context: OperationContext,
    worker: boolean,
  ): Promise<unknown> {
    const operation = getOperation(operationId),
      input = record(operation.inputSchema.parse(value));
    if (["listRows", "queryRows"].includes(operationId))
      assertReadOpen(context);
    let actor = await this.authorise(incoming, operationId, input);
    const lexemes = context.numericLexemes ?? [];
    if (lexemes.length) {
      const table =
        typeof input.tableId === "string"
          ? await this.options.storage.getTable(actor, input.tableId)
          : undefined;
      if (table && ["createRow", "updateRow"].includes(operationId))
        assertValueLexemes(table.fields, lexemes);
      if (
        table &&
        ["queryRows", "countRows", "exportRows"].includes(operationId)
      )
        assertQueryLexemes(
          table.fields,
          QuerySpecSchema.parse(input.query ?? {}),
          lexemes,
        );
      if (
        table &&
        operationId === "mutateRows" &&
        Array.isArray(input.mutations)
      )
        input.mutations.forEach((_, i) =>
          assertValueLexemes(table.fields, lexemes, ["mutations", i, "values"]),
        );
      if (operationId === "createTable" && Array.isArray(input.fields))
        input.fields.forEach((f, i) =>
          assertFieldDefinitionLexemes(
            record(f) as unknown as FieldDefinition,
            lexemes,
            ["fields", i],
          ),
        );
      if (operationId === "createField")
        assertFieldDefinitionLexemes(
          record(input.field) as unknown as FieldDefinition,
          lexemes,
          ["field"],
        );
      if (operationId === "updateField" && table) {
        const existing = table.fields.find((f) => f.id === input.fieldId);
        if (existing)
          assertFieldDefinitionLexemes(
            { ...existing, ...record(input.field) },
            lexemes,
            ["field"],
          );
      }
      if (operationId === "applySchemaChange" && table) {
        const change = record(input.change);
        if (change.kind === "add_field")
          assertFieldDefinitionLexemes(
            record(change.field) as unknown as FieldDefinition,
            lexemes,
            ["change", "field"],
          );
        if (change.kind === "update_field") {
          const existing = table.fields.find((f) => f.id === change.fieldId);
          if (existing)
            assertFieldDefinitionLexemes(
              { ...existing, ...record(change.changes) },
              lexemes,
              ["change", "changes"],
            );
        }
      }
    }
    if (operation.idempotencyRequired && !context.idempotencyKey)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Idempotency-Key is required",
        400,
      );
    if (!worker && operationId === "beginAccountAction") {
      const bound = this.options.identity.validateAccountActionRequest(
        actor,
        input,
        {
          ...context,
          surface: context.surface === "operator" ? "worker" : context.surface,
        },
      );
      if (operationMap[bound.operationId])
        await this.authorise(actor, bound.operationId, bound.input);
      if (
        bound.operationId === "mutateRows" &&
        Array.isArray(bound.input.mutations)
      ) {
        const table = await this.options.storage.getTable(
          actor,
          str(bound.input.tableId),
        );
        bound.input.mutations.forEach((_, i) =>
          assertValueLexemes(table.fields, lexemes, [
            "input",
            "mutations",
            i,
            "values",
          ]),
        );
      }
    }
    const repair = operationId === "mutateRows" && input.repair !== undefined;
    const queued =
      !worker &&
      (repair ||
        queuedFamilies.has(operationId) ||
        (asynchronous.has(operationId) &&
          (operationId !== "countRows" ||
            input.exact === true ||
            !!(input.query && record(input.query).where))));
    if (!worker && (jobOperations.has(operationId) || repair))
      actor = await this.options.jobs.authoriseRequest(
        actor,
        operationId,
        input,
      );
    if (
      !worker &&
      !queued &&
      context.idempotencyKey &&
      mutationSet.has(operationId)
    ) {
      const replay = await withOrg(
        this.options.identityPool,
        actor.orgId,
        (client) =>
          lookupMutation(
            client,
            actor,
            operationId,
            input,
            context.idempotencyKey!,
            this.options.config.keyHashSecret,
          ),
      );
      if (replay.found) return replay.result;
    }
    const perform = async (approvedContext: OperationContext) => {
      if (
        !worker &&
        (asynchronous.has(operationId) || repair) &&
        (operationId !== "countRows" ||
          input.exact === true ||
          !!(input.query && record(input.query).where))
      )
        return this.options.jobs.enqueueOperation(actor, operationId, input, {
          idempotencyKey:
            approvedContext.idempotencyKey ??
            (operationId === "countRows" ? `count:${newId()}` : undefined),
          requestId: approvedContext.requestId,
          source: approvedContext.surface,
          approvalId: approvedContext.actionId,
          client: approvedContext.approvalClient,
          stepUpApproved: true,
        });
      let output = await this.dispatch(
        operationId,
        actor,
        input,
        approvedContext,
      );
      if (
        worker &&
        context.jobId &&
        output &&
        typeof output === "object" &&
        "fields" in output
      ) {
        const journal = await withOrg(
          this.options.pool,
          actor.orgId,
          async (c) =>
            (
              await c.query<{ id: string }>(
                "SELECT id FROM rootset_control.schema_operations WHERE idempotency_key=$1",
                [context.idempotencyKey],
              )
            ).rows[0],
        );
        if (journal) output = { ...output, schemaOperationId: journal.id };
      }
      if (worker && context.jobId)
        await withOrg(this.options.pool, actor.orgId, (client) =>
          this.recordOperationOutcome(
            client,
            actor,
            operationId,
            context,
            output,
          ),
        );
      return JSON.parse(JSON.stringify(output)) as unknown;
    };
    const runApproved = async (effectiveContext: OperationContext) => {
      if (
        operation.stepUp !== "never" &&
        !worker &&
        (operationId !== "mutateRows" || repair)
      ) {
        const approvalContext = {
          ...effectiveContext,
          actionId:
            effectiveContext.actionId ??
            (typeof input.approvalId === "string"
              ? input.approvalId
              : undefined),
          surface:
            effectiveContext.surface === "operator"
              ? ("worker" as const)
              : effectiveContext.surface,
        };
        return this.options.identity.withOperationApproval(
          actor,
          operationId,
          input,
          approvalContext,
          (client) =>
            perform({
              ...effectiveContext,
              actionId: approvalContext.actionId,
              approvalClient: client,
            }),
        );
      }
      return perform(effectiveContext);
    };
    if (queued) {
      const approvalId = resolveAdmissionApproval(input, context);
      const idempotencyKey =
        context.idempotencyKey ??
        (operationId === "countRows" ? `count:${newId()}` : undefined);
      const admit = (client: PoolClient) =>
        this.options.jobs.withOperationAdmission(
          actor,
          operationId,
          input,
          {
            idempotencyKey,
            requestId: context.requestId,
            source: context.surface ?? "rest",
            approvalId,
            stepUpApproved: true,
            client,
          },
          (client) =>
            runApproved({
              ...context,
              idempotencyKey,
              approvalClient: client,
              actionId: approvalId,
            }),
        );
      return context.approvalClient
        ? admit(context.approvalClient)
        : withOrg(this.options.identityPool, actor.orgId, admit);
    }
    return runApproved(context);
  }
  private async schemaResult(actor: Actor, tableId: string) {
    const table = await this.options.storage.getTable(actor, tableId);
    const operators = Object.fromEntries(
      table.fields.map((f) => [f.id, [...operatorsByType[f.type]]]),
    );
    return {
      table: tablePublic(table),
      fields: table.fields,
      uniqueRules: (
        await this.options.storage.listUniqueRules(actor, tableId)
      ).map(rulePublic),
      indexes: (await this.options.storage.listIndexes(actor, tableId)).map(
        indexPublic,
      ),
      operators,
      limits: { ...limits },
    };
  }
  private async dispatch(
    id: string,
    a: Actor,
    input: Record<string, unknown>,
    ctx: OperationContext,
  ): Promise<unknown> {
    const s = this.options.storage,
      tableId = typeof input.tableId === "string" ? input.tableId : "",
      databaseId = typeof input.databaseId === "string" ? input.databaseId : "";
    if (jobOperations.has(id))
      return this.options.jobs.execute(id, a, input, {
        idempotencyKey: ctx.idempotencyKey,
        requestId: ctx.requestId,
        source: ctx.surface,
        jobFence: ctx.jobFence,
        approvalId:
          ctx.actionId ??
          (typeof input.approvalId === "string" ? input.approvalId : undefined),
        stepUpApproved: true,
        client: ctx.approvalClient,
      });
    switch (id) {
      case "listDatabases":
        return this.paging.paginate(
          (await s.listDatabases(a)).map((database) => ({
            ...databasePublic(database),
            tableCount: database.tableCount,
          })),
          a,
          {
            resource: "databases",
            limit: typeof input.limit === "number" ? input.limit : undefined,
            cursor: typeof input.cursor === "string" ? input.cursor : undefined,
          },
        );
      case "createDatabase":
        return databasePublic(
          await s.createDatabase(a, {
            name: str(input.name),
            description:
              typeof input.description === "string"
                ? input.description
                : undefined,
            ...mutationOptions(input, ctx),
          }),
        );
      case "getDatabase":
        return databasePublic(await s.getDatabase(a, databaseId));
      case "updateDatabase":
        return databasePublic(
          await s.updateDatabase(a, databaseId, {
            name: typeof input.name === "string" ? input.name : undefined,
            description:
              typeof input.description === "string" ||
              input.description === null
                ? input.description
                : undefined,
            ...mutationOptions(input, ctx),
          }),
        );
      case "deleteDatabase":
        return s.deleteDatabase(a, databaseId, mutationOptions(input, ctx));
      case "listTables":
        return this.paging.paginate(
          (await s.listTables(a, databaseId)).map(tablePublic),
          a,
          {
            resource: `database:${databaseId}:tables`,
            limit: typeof input.limit === "number" ? input.limit : undefined,
            cursor: typeof input.cursor === "string" ? input.cursor : undefined,
          },
        );
      case "createTable": {
        const table = await s.createTable(a, databaseId, {
          name: str(input.name),
          description:
            typeof input.description === "string" || input.description === null
              ? input.description
              : undefined,
          fields: Array.isArray(input.fields)
            ? input.fields.map(
                (f) => FieldInputSchema.parse(f) as unknown as FieldInput,
              )
            : [],
          ...mutationOptions(input, ctx),
        });
        return this.schemaResult(a, table.id);
      }
      case "getTable":
        return tablePublic(await s.getTable(a, tableId));
      case "updateTable":
        return tablePublic(
          await s.updateTable(a, tableId, {
            name: typeof input.name === "string" ? input.name : undefined,
            description:
              typeof input.description === "string" ||
              input.description === null
                ? input.description
                : undefined,
            ...schemaOptions(input, ctx),
          }),
        );
      case "deleteTable":
        return s.deleteTable(a, tableId, schemaOptions(input, ctx));
      case "getTableSchema":
        return this.schemaResult(a, tableId);
      case "listFields":
        return { data: (await s.getTable(a, tableId)).fields };
      case "createField":
        await s.createField(a, tableId, {
          ...(FieldInputSchema.parse(input.field) as unknown as FieldInput),
          ...schemaOptions(input, ctx),
        });
        return this.schemaResult(a, tableId);
      case "updateField": {
        const field = record(input.field);
        await s.updateField(a, tableId, str(input.fieldId), {
          ...field,
          ...schemaOptions(input, ctx),
          ...(input.conversion
            ? {
                conversion: {
                  strategy:
                    input.conversion === "lossless"
                      ? "strict"
                      : field.type === "text"
                        ? "stringify"
                        : "parse",
                } as const,
              }
            : {}),
        });
        return this.schemaResult(a, tableId);
      }
      case "deleteField":
        await s.deleteField(a, tableId, str(input.fieldId), {
          ...schemaOptions(input, ctx),
          removeDependencies: input.removeDependencies === true,
        });
        return this.schemaResult(a, tableId);
      case "reorderFields":
        await s.reorderFields(
          a,
          tableId,
          input.fieldIds as string[],
          schemaOptions(input, ctx),
        );
        return this.schemaResult(a, tableId);
      case "previewSchemaChange":
        return s.previewSchemaChange(a, tableId, {
          expectedSchemaVersion: num(input.expectedSchemaVersion),
          change: input.change,
        });
      case "applySchemaChange": {
        const c = record(input.change);
        const common = { ...input, ...schemaOptions(input, ctx) };
        switch (c.kind) {
          case "add_field":
            return this.dispatch(
              "createField",
              a,
              { ...common, field: c.field },
              ctx,
            );
          case "update_field":
            return this.dispatch(
              "updateField",
              a,
              {
                ...common,
                fieldId: c.fieldId,
                field: c.changes,
                conversion: c.conversion,
              },
              ctx,
            );
          case "delete_field":
            return this.dispatch(
              "deleteField",
              a,
              {
                ...common,
                fieldId: c.fieldId,
                removeDependencies: c.removeDependencies,
              },
              ctx,
            );
          case "reorder_fields":
            return this.dispatch(
              "reorderFields",
              a,
              { ...common, fieldIds: c.fieldIds },
              ctx,
            );
          default:
            throw new RootsetError(
              "VALIDATION_FAILED",
              "Unsupported schema change",
            );
        }
      }
      case "getSchemaOperation": {
        const r = await withOrg(
          this.options.pool,
          a.orgId,
          async (c) =>
            (
              await c.query<Record<string, unknown>>(
                "SELECT s.*,j.id AS job_id,j.input AS job_input FROM rootset_control.schema_operations s LEFT JOIN rootset_control.jobs j ON j.org_id=s.org_id AND s.idempotency_key=$4||j.id||$5 WHERE s.org_id=$1 AND (s.id=$2 OR j.id=$2) AND s.table_id=$3 LIMIT 1",
                [a.orgId, str(input.id), tableId, "job:", ":operation"],
              )
            ).rows[0],
        );
        if (!r)
          throw new RootsetError(
            "RESOURCE_NOT_FOUND",
            "Schema operation was not found",
            404,
          );
        return mapSchemaJournal(r, {
          jobId: typeof r.job_id === "string" ? r.job_id : undefined,
          request: r.job_input ? record(r.job_input) : undefined,
        });
      }
      case "listUniqueRules":
        return { data: (await s.listUniqueRules(a, tableId)).map(rulePublic) };
      case "createUniqueRule":
        return rulePublic(
          await s.createUniqueRule(a, tableId, {
            fieldIds: input.fieldIds as string[],
            ...schemaOptions(input, ctx),
          }),
        );
      case "deleteUniqueRule":
        await s.deleteUniqueRule(
          a,
          tableId,
          str(input.id),
          schemaOptions(input, ctx),
        );
        return { deleted: true };
      case "listIndexes":
        return { data: (await s.listIndexes(a, tableId)).map(indexPublic) };
      case "createIndex": {
        const fields = input.fieldIds as string[];
        if (fields.length !== 1)
          throw new RootsetError(
            "VALIDATION_FAILED",
            "A query index covers one field; composite uniqueness uses unique rules",
          );
        return indexPublic(
          await s.createIndex(a, tableId, {
            fieldId: fields[0]!,
            kind:
              input.kind === "jsonb"
                ? "json"
                : (input.kind as "btree" | "trigram"),
            ...schemaOptions(input, ctx),
          }),
        );
      }
      case "deleteIndex":
        await s.deleteIndex(
          a,
          tableId,
          str(input.id),
          schemaOptions(input, ctx),
        );
        return { deleted: true };
      case "listRows":
        return s.queryRows(
          a,
          tableId,
          QuerySpecSchema.parse(
            Object.fromEntries(
              Object.entries(input).filter(([k]) =>
                ["select", "orderBy", "limit", "cursor"].includes(k),
              ),
            ),
          ),
          {
            surface:
              ctx.surface === "mcp"
                ? "mcp"
                : ctx.surface === "browser"
                  ? "ui"
                  : "rest",
            byteLimit: ctx.responseBudget,
            signal: readSignal(ctx),
          },
        );
      case "queryRows":
        return s.queryRows(a, tableId, QuerySpecSchema.parse(input.query), {
          surface:
            ctx.surface === "mcp"
              ? "mcp"
              : ctx.surface === "browser"
                ? "ui"
                : "rest",
          byteLimit: ctx.responseBudget,
          signal: readSignal(ctx),
        });
      case "getRow":
        return rowPublic(await s.getRow(a, tableId, str(input.rowId)));
      case "createRow": {
        const r = await s.createRow(
          a,
          tableId,
          record(input.values) as Record<string, JsonValue>,
          mutationOptions(input, ctx),
        );
        return { row: rowPublic(r), mutationId: r.mutationId };
      }
      case "updateRow": {
        const r = await s.updateRow(
          a,
          tableId,
          str(input.rowId),
          record(input.values) as Record<string, JsonValue>,
          {
            ...mutationOptions(input, ctx),
            expectedVersion: str(input.expectedVersion),
          },
        );
        return { row: rowPublic(r), mutationId: r.mutationId };
      }
      case "deleteRow": {
        const r = await s.deleteRow(a, tableId, str(input.rowId), {
          ...mutationOptions(input, ctx),
          expectedVersion: str(input.expectedVersion),
        });
        return { deleted: true, mutationId: r.mutationId };
      }
      case "mutateRows": {
        const ops = mutations(input.mutations);
        const format = (r: import("@rootset/table-storage").MutationResult) => {
          let cursor = 0;
          return {
            mutationId: r.mutationId,
            results: ops.map((op) => {
              if (op.kind === "delete")
                return { type: "delete", rowId: op.rowId, deleted: true };
              const row = r.rows[cursor++];
              if (!row)
                throw new RootsetError(
                  "INTERNAL_ERROR",
                  "Committed mutation outcome is incomplete",
                  500,
                );
              return { type: op.kind, rowId: row.id, row: rowPublic(row) };
            }),
          };
        };
        const repair = input.repair as { reason: string } | undefined;
        if (
          repair &&
          (ctx.surface !== "worker" ||
            !ctx.jobId ||
            !ctx.actionId ||
            !ctx.jobFence ||
            !ctx.beforePublish)
        )
          throw new RootsetError(
            "ACCESS_DENIED",
            "Operator repair can execute only through its approved durable job",
            403,
          );
        const repairBudget = repair
          ? ctx.admissionSource === "mcp"
            ? limits.mcpResultBytes - 1024
            : ["browser", "rest", "operator"].includes(
                  ctx.admissionSource ?? "",
                )
              ? limits.restResultBytes
              : undefined
          : undefined;
        if (repair && repairBudget === undefined)
          throw new RootsetError(
            "ACCESS_DENIED",
            "Operator repair requires its authenticated admission source",
            403,
          );
        const r = await s.mutateRows(a, tableId, {
          operations: ops,
          ...mutationOptions(input, ctx),
          ...(repair
            ? {
                responseBudget: repairBudget,
                context: {
                  ...mutationOptions(input, ctx).context,
                  source: "operator" as const,
                  repair: {
                    reason: repair.reason,
                    approvalId: ctx.actionId!,
                    jobId: ctx.jobId!,
                  },
                },
                onCommit: async (
                  client: PoolClient,
                  outcome: import("@rootset/table-storage").MutationResult,
                ) => {
                  await this.recordOperationOutcome(
                    client,
                    a,
                    id,
                    ctx,
                    format(outcome),
                  );
                },
              }
            : {}),
        });
        return format(r);
      }
      case "getTableStatistics": {
        const stats = await s.statistics(a, tableId),
          history = await withOrg(this.options.pool, a.orgId, (c) =>
            c.query<{ count: string }>(
              "SELECT events::text count FROM rootset_control.history_metrics WHERE table_id=$1",
              [tableId],
            ),
          );
        return {
          liveRows: stats.rowCount,
          rowCountKind: "live",
          storageBytes: stats.bytes,
          indexBytes: stats.indexBytes,
          historyEvents: Number(history.rows[0]?.count ?? 0),
          asOf: new Date().toISOString(),
        };
      }
      case "countRows":
        return {
          count:
            input.exact || !!(input.query && record(input.query).where)
              ? await s.exactCount(
                  a,
                  tableId,
                  QuerySpecSchema.parse(input.query ?? {}),
                )
              : (await s.getTable(a, tableId)).rowCount,
          kind:
            input.exact || !!(input.query && record(input.query).where)
              ? "exact"
              : "live",
          asOf: new Date().toISOString(),
        };
      case "getCellHistory": {
        const r = await s.cellHistory(
          a,
          tableId,
          str(input.rowId),
          str(input.fieldId),
          {
            limit: typeof input.limit === "number" ? input.limit : undefined,
            cursor: typeof input.cursor === "string" ? input.cursor : undefined,
            byteLimit: ctx.responseBudget,
          },
        );
        return {
          data: r.data.map(historyPublic),
          nextCursor: r.nextCursor,
          hasMore: r.hasMore,
        };
      }
      case "queryHistory": {
        const r = await s.queryHistory(a, tableId, {
          ...input,
          byteLimit: ctx.responseBudget,
        });
        return {
          data: r.data.map(historyPublic),
          nextCursor: r.nextCursor,
          hasMore: r.hasMore,
        };
      }
      case "getMutation": {
        const row = await withOrg(
          this.options.pool,
          a.orgId,
          async (c) =>
            (
              await c.query<{ table_id: string }>(
                "SELECT table_id FROM rootset_control.mutations WHERE id=$1",
                [input.id],
              )
            ).rows[0],
        );
        if (!row)
          throw new RootsetError(
            "RESOURCE_NOT_FOUND",
            "Mutation was not found",
            404,
          );
        await this.authorise(a, "getRow", { tableId: row.table_id });
        return {
          mutationId: input.id,
          result: await s.getMutation(a, row.table_id, str(input.id)),
        };
      }
      case "getUsage":
        return readUsage(this.options.pool, a);
      default:
        return this.options.identity.execute(id, a, input, {
          ...ctx,
          surface: ctx.surface === "operator" ? "worker" : ctx.surface,
        });
    }
  }
  async windowQuery(
    incoming: Actor,
    value: unknown,
    context: OperationContext = {},
  ) {
    assertReadOpen(context);
    const input = record(value),
      tableId = str(input.tableId);
    const a = await this.authorise(incoming, "queryRows", input);
    const query = QuerySpecSchema.parse(input.query ?? {});
    if (context.numericLexemes?.length)
      assertQueryLexemes(
        (await this.options.storage.getTable(a, tableId)).fields,
        query,
        context.numericLexemes,
      );
    return this.options.storage.queryWindow(
      a,
      tableId,
      {
        query,
        position: input.position as
          number | "first" | "middle" | "last" | undefined,
        sessionId:
          typeof input.sessionId === "string" ? input.sessionId : undefined,
      },
      { signal: readSignal(context) },
    );
  }
}
function historyPublic(r: Record<string, unknown>) {
  const actor = record(r.actor),
    ctx = record(r.context ?? {});
  return {
    id: r.public_id,
    orgId: r.org_id,
    databaseId: r.database_id,
    tableId: r.table_id,
    rowId: r.row_id,
    fieldId: r.field_id,
    mutationId: r.mutation_id,
    requestId:
      typeof ctx.requestId === "string" ? ctx.requestId : String(r.mutation_id),
    actor: {
      id: actor.id,
      kind: actor.kind,
      ...(actor.credentialId ? { credentialId: actor.credentialId } : {}),
      ...(actor.clientId ? { clientId: actor.clientId } : {}),
    },
    source: ctx.source ?? "rest",
    operation: r.operation === "insert" ? "create" : r.operation,
    before: r.old_value,
    after: r.new_value,
    fieldDefinition: r.field_definition,
    previousVersion: r.old_version === null ? null : String(r.old_version),
    version: String(r.new_version ?? r.old_version),
    timestamp: iso(r.changed_at),
  };
}
export function createCore(options: CoreOptions): RootsetCore {
  return new RootsetCore(options);
}
