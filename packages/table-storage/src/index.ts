import { createHash } from "node:crypto";
import {
  Pool,
  type PoolClient,
  withOrg,
  withOrgRead,
  ReadCancelledError,
  ReadCancellationFailure,
} from "@rootset/database";
import {
  type Actor,
  type FieldDefinition,
  type JsonValue,
  type QuerySpec,
  type Row,
  type QueryResult,
  RootsetError,
  FieldDefinitionSchema,
  IdSchema,
  VersionSchema,
  SchemaVersionSchema,
  OperatorRepairReasonSchema,
  limits,
  newId,
  canonicalJson,
  validateCell,
  validateValues,
  assertRowBytes,
  assertFieldNames,
} from "@rootset/contracts";
import {
  compileQuery,
  compileKeyset,
  CursorCodec,
  buildPage,
  fieldColumn,
} from "./query.js";

function renamedValues(
  values: Record<string, JsonValue>,
  before: FieldDefinition,
  after: FieldDefinition,
): Record<string, JsonValue> {
  if (before.name === after.name) return values;
  const renamed = Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== before.name),
  );
  renamed[after.name] = values[before.name] ?? null;
  return renamed;
}

export type FieldInput = Omit<FieldDefinition, "id">;
export interface DatabaseRecord {
  id: string;
  orgId: string;
  name: string;
  description: string;
  schemaName: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}
export interface TableRecord {
  id: string;
  orgId: string;
  databaseId: string;
  name: string;
  description: string;
  physicalName: string;
  schemaName: string;
  generation: number;
  schemaVersion: number;
  rowCount: number;
  state: string;
  createdAt: string;
  updatedAt: string;
  fields: FieldDefinition[];
}
export interface MutationContext {
  requestId?: string;
  source?: "rest" | "mcp" | "ui" | "import" | "schema" | "operator";
  jobId?: string;
  jobFence?: { jobId: string; leaseToken: string };
  beforePublish?: () => Promise<unknown>;
  repair?: { reason: string; approvalId: string; jobId: string };
}
export interface MutationOptions {
  idempotencyKey?: string;
  expectedSchemaVersion?: number;
  context?: MutationContext;
  onCommit?: (client: PoolClient, outcome: MutationResult) => Promise<void>;
  responseBudget?: number;
}
export type RowOperation =
  | { kind: "create"; values: Record<string, JsonValue> }
  | {
      kind: "update";
      rowId: string;
      values: Record<string, JsonValue>;
      expectedVersion: string;
    }
  | { kind: "delete"; rowId: string; expectedVersion: string };
export interface MutationResult {
  mutationId: string;
  schemaVersion: number;
  rows: Row[];
  deletedIds: string[];
}
export interface SchemaOptions {
  expectedSchemaVersion: number;
  idempotencyKey?: string;
  context?: MutationContext;
}
export interface UniqueRule {
  id: string;
  tableId: string;
  name: string;
  fieldIds: string[];
  strategy: "native" | "registry";
  state: string;
  physicalName: string | null;
  error?: JsonValue;
}
export interface IndexRecord {
  id: string;
  tableId: string;
  fieldId: string;
  kind: "btree" | "trigram" | "json";
  state: string;
  physicalName: string;
  error?: JsonValue;
}
type Raw = Record<string, unknown>;
class SchemaLockBusy extends Error {
  constructor(readonly databaseId: string) {
    super("Database schema lock is busy");
  }
}
const utcTimestamp = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const q = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalJson(value, { maxDepth: 96 }))
    .digest("hex");
async function clientTransaction<T>(
  c: PoolClient,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await c.query("BEGIN");
  try {
    const result = await work(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}
function schemaPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Raw).filter(
      ([key, v]) =>
        key !== "context" &&
        key !== "idempotencyKey" &&
        key !== "onCommit" &&
        key !== "responseBudget" &&
        v !== undefined,
    ),
  );
}
function fieldPatch(
  input: Partial<FieldInput> &
    Partial<SchemaOptions> & { conversion?: unknown },
): Partial<FieldInput> {
  const patch = { ...input };
  delete patch.expectedSchemaVersion;
  delete patch.idempotencyKey;
  delete patch.context;
  delete patch.conversion;
  return patch;
}
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const number = (value: unknown): number => Number(value);
const id = (value: string): string => IdSchema.parse(value);
function fail(
  code: string,
  message: string,
  status = 422,
  details?: JsonValue,
): never {
  throw new RootsetError(code, message, status, details);
}
function storageError(error: unknown): never {
  if (error instanceof ReadCancelledError)
    fail(
      "REQUEST_TIMEOUT",
      "Client request ended before its table read completed",
      408,
    );
  if (error instanceof ReadCancellationFailure)
    throw new RootsetError(
      "DEPENDENCY_UNAVAILABLE",
      "Native read cancellation could not be confirmed safely",
      503,
      { retryAfter: 1 },
    );
  const e = error as { code?: string; message?: string; detail?: string };
  if (e.code === "23505")
    fail("UNIQUE_CONFLICT", "A declared unique tuple already exists", 409);
  if (e.code === "23514") {
    if (e.message?.includes("65536"))
      fail("ROW_SIZE_LIMIT", "Row exceeds canonical byte limit");
    if (e.message?.includes("tables_row_count_check"))
      fail(
        "ROW_LIMIT_REACHED",
        "The table has reached its live row limit",
        409,
      );
    fail(
      "VALIDATION_FAILED",
      "Stored value violates a field or row constraint",
    );
  }
  if (e.code === "42501")
    fail(
      "ACCESS_DENIED",
      "The requested storage operation is not authorised",
      403,
    );
  if (e.code === "55000")
    fail(
      "SCHEMA_MAINTENANCE",
      "The table is undergoing schema maintenance",
      409,
    );
  if (e.code === "57014")
    fail(
      "QUERY_TIMEOUT",
      "Query exceeded its ten-second execution budget",
      408,
    );
  if (e.code === "40P01" || e.code === "40001")
    fail("ROW_VERSION_CONFLICT", "Concurrent mutation requires a retry", 409);
  throw error;
}
function physicalType(f: FieldDefinition): string {
  switch (f.type) {
    case "text":
      return 'text COLLATE "C"';
    case "integer":
      return "bigint";
    case "float":
      return "double precision";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "time":
      return "time(3) without time zone";
    case "date-time":
      return "timestamptz(3)";
    case "json":
      return "jsonb";
  }
}
function parameter(field: FieldDefinition, value: JsonValue): unknown {
  if (value === null) return null;
  if (field.type === "json") return canonicalJson(value);
  if (field.type === "time") return String(value).replace(/Z$/, "");
  return value;
}
function rowFrom(raw: Raw, fields: readonly FieldDefinition[]): Row {
  const values: Record<string, JsonValue> = {};
  for (const field of fields) {
    let v = raw[fieldColumn(field)];
    if (v == null) v = null;
    else if (field.type === "integer") v = Number(v);
    else if (field.type === "date")
      v =
        v instanceof Date
          ? `${v.getFullYear().toString().padStart(4, "0")}-${(v.getMonth() + 1).toString().padStart(2, "0")}-${v.getDate().toString().padStart(2, "0")}`
          : String(v).slice(0, 10);
    else if (field.type === "date-time") v = iso(v);
    else if (field.type === "time") {
      const m = /^(\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(String(v));
      v = m ? `${m[1]}.${(m[2] ?? "").padEnd(3, "0")}Z` : String(v);
    }
    values[field.name] = v as JsonValue;
  }
  return {
    id: String(raw.row_id),
    version: String(raw.row_version),
    createdAt: iso(raw.created_at),
    updatedAt: iso(raw.updated_at),
    values,
  };
}
function name(value: string): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > 200)
    fail("VALIDATION_FAILED", "Name must contain 1–200 characters");
  return value;
}
function context(input: MutationContext = {}): MutationContext {
  return {
    requestId: input.requestId ?? newId(),
    source: input.source ?? "rest",
    ...(input.jobId ? { jobId: input.jobId } : {}),
  };
}
function field(input: FieldInput, fieldId = newId()): FieldDefinition {
  const result = FieldDefinitionSchema.safeParse({ ...input, id: fieldId });
  if (!result.success)
    fail("VALIDATION_FAILED", "Invalid field definition", 422, {
      issues: result.error.issues.map((x) => ({
        path: x.path.join("."),
        message: x.message,
      })),
    });
  return result.data;
}
function fieldFor(table: TableRecord, key: string): FieldDefinition {
  return (
    table.fields.find((f) => f.id === key.toUpperCase() || f.name === key) ??
    fail("VALIDATION_FAILED", "Unknown field")
  );
}
function changedField(
  before: FieldDefinition,
  patch: Partial<FieldInput>,
): FieldDefinition {
  const base = { ...before };
  if (patch.type && patch.type !== before.type) {
    delete base.charLimit;
    delete base.min;
    delete base.max;
  }
  return field({ ...base, ...patch }, before.id);
}
function convertedCell(
  before: FieldDefinition,
  after: FieldDefinition,
  strategy: "strict" | "stringify" | "parse",
  value: JsonValue,
): JsonValue {
  let converted: unknown = value;
  if (value !== null && strategy === "stringify")
    converted = before.type === "json" ? canonicalJson(value) : String(value);
  else if (value !== null && strategy === "parse") {
    if (typeof value !== "string")
      fail("VALIDATION_FAILED", "Parse conversion requires text source");
    if (after.type === "boolean") {
      if (value !== "true" && value !== "false")
        fail(
          "VALIDATION_FAILED",
          "Boolean conversion accepts literal true/false",
        );
      converted = value === "true";
    } else if (after.type === "integer" || after.type === "float") {
      if (!value.trim())
        fail("VALIDATION_FAILED", "Empty text is not a number");
      converted = Number(value);
    } else if (after.type === "json") {
      try {
        converted = JSON.parse(value);
      } catch {
        fail("VALIDATION_FAILED", "Invalid JSON conversion value");
      }
    }
  }
  return validateCell(after, converted);
}
function tablePath(table: TableRecord): string {
  return `${q(table.schemaName)}.${q(table.physicalName)}`;
}

export class TableStorage {
  readonly pool: Pool;
  readonly ddlPool: Pool;
  readonly cursor: CursorCodec;
  constructor(options: { pool: Pool; ddlPool: Pool; cursorSecret: string }) {
    this.pool = options.pool;
    this.ddlPool = options.ddlPool;
    this.cursor = new CursorCodec(options.cursorSecret);
  }
  private async read<T>(
    actor: Actor,
    work: (c: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await (signal
        ? withOrgRead(this.pool, id(actor.orgId), work, signal)
        : withOrg(this.pool, id(actor.orgId), work));
    } catch (error) {
      return storageError(error);
    }
  }
  private async run<T>(
    actor: Actor,
    work: (c: PoolClient) => Promise<T>,
    ddl = false,
  ): Promise<T> {
    let pendingDatabaseId: string | undefined;
    const deadline = Date.now() + limits.queryTimeoutMs;
    for (;;) {
      let connection: PoolClient | undefined;
      let heldDatabaseId: string | undefined;
      try {
        if (!pendingDatabaseId)
          return await withOrg(
            ddl ? this.ddlPool : this.pool,
            id(actor.orgId),
            work,
          );
        connection = await (ddl ? this.ddlPool : this.pool).connect();
        await connection.query("SELECT set_config('rootset.org_id',$1,false)", [
          id(actor.orgId),
        ]);
        for (;;) {
          const acquired = (
            await connection.query<{ acquired: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
              [pendingDatabaseId],
            )
          ).rows[0]!.acquired;
          if (acquired) {
            heldDatabaseId = pendingDatabaseId;
            break;
          }
          if (Date.now() >= deadline)
            fail(
              "QUERY_TIMEOUT",
              "Database schema lock exceeded its ten-second wait budget",
              408,
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return await clientTransaction(connection, async (c) => {
          await c.query("SELECT set_config('rootset.org_id',$1,true)", [
            id(actor.orgId),
          ]);
          return work(c);
        });
      } catch (error) {
        if (error instanceof SchemaLockBusy) {
          pendingDatabaseId = error.databaseId;
          if (Date.now() >= deadline)
            fail(
              "QUERY_TIMEOUT",
              "Database schema lock exceeded its ten-second wait budget",
              408,
            );
        } else return storageError(error);
      } finally {
        if (connection) {
          if (heldDatabaseId)
            await connection
              .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
                heldDatabaseId,
              ])
              .catch(() => undefined);
          await connection.query("RESET rootset.org_id").catch(() => undefined);
          connection.release();
        }
      }
    }
  }
  private async assertPublication(
    c: PoolClient,
    a: Actor,
    ctx: MutationContext | undefined,
    lock = true,
  ): Promise<void> {
    await ctx?.beforePublish?.();
    const fence = ctx?.jobFence;
    if (!fence) return;
    if (ctx.jobId && ctx.jobId !== fence.jobId)
      fail("ACCESS_DENIED", "Worker fence does not match its job context", 403);
    const held = await c.query(
      "SELECT id FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND state='running' AND NOT cancel_requested" +
        (lock ? " FOR UPDATE" : ""),
      [id(fence.jobId), a.orgId, id(fence.leaseToken)],
    );
    if (!held.rowCount)
      fail(
        "JOB_LEASE_LOST",
        "The schema worker no longer owns a current uncancelled lease",
        409,
      );
  }
  private async database(
    c: PoolClient,
    actor: Actor,
    databaseId: string,
    archived = false,
  ): Promise<DatabaseRecord> {
    const r = await c.query<Raw>(
      "SELECT * FROM rootset_control.databases WHERE id=$1 AND org_id=$2" +
        (archived ? "" : " AND state='active'"),
      [id(databaseId), actor.orgId],
    );
    const d = r.rows[0];
    if (!d) fail("RESOURCE_NOT_FOUND", "Database was not found", 404);
    return this.databaseRecord(d);
  }
  private databaseRecord(d: Raw): DatabaseRecord {
    return {
      id: String(d.id),
      orgId: String(d.org_id),
      name: String(d.name),
      description: String(d.description),
      schemaName: String(d.schema_name),
      state: String(d.state),
      createdAt: iso(d.created_at),
      updatedAt: iso(d.updated_at),
    };
  }
  private async table(
    c: PoolClient,
    actor: Actor,
    tableId: string,
    lock = false,
    archived = false,
  ): Promise<TableRecord> {
    const r = await c.query<Raw>(
      `SELECT t.*,d.schema_name,d.state AS database_state FROM rootset_control.tables t JOIN rootset_control.databases d ON d.id=t.database_id WHERE t.id=$1 AND t.org_id=$2 ${archived ? "" : "AND t.state IN ('active','maintenance') AND d.state='active'"} ${lock ? "FOR UPDATE OF t" : ""}`,
      [id(tableId), actor.orgId],
    );
    const t = r.rows[0];
    if (!t) fail("RESOURCE_NOT_FOUND", "Table was not found", 404);
    const fs = await c.query<{ definition: FieldDefinition }>(
      "SELECT definition FROM rootset_control.fields WHERE table_id=$1 AND state=$2 ORDER BY position,id",
      [t.id, "active"],
    );
    return {
      id: String(t.id),
      orgId: String(t.org_id),
      databaseId: String(t.database_id),
      name: String(t.name),
      description: String(t.description ?? ""),
      physicalName: String(t.physical_name),
      schemaName: String(t.schema_name),
      generation: number(t.generation),
      schemaVersion: number(t.schema_version),
      rowCount: number(t.row_count),
      state: String(t.state),
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
      fields: fs.rows.map((x) => x.definition),
    };
  }
  private async barrier(
    c: PoolClient,
    databaseId: string,
    allowIndexBuild = false,
  ): Promise<void> {
    const acquired = await c.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
      [databaseId],
    );
    if (!acquired.rows[0]!.acquired) throw new SchemaLockBusy(databaseId);

    if (!allowIndexBuild) {
      const building = await c.query(
        "SELECT i.id FROM rootset_control.indexes i JOIN rootset_control.tables t ON t.id=i.table_id WHERE t.database_id=$1 AND i.state=$2 LIMIT 1",
        [databaseId, "building"],
      );
      if (building.rowCount)
        fail(
          "SCHEMA_MAINTENANCE",
          "A secondary index build must finish before another schema change",
          409,
        );
    }
  }

  private async audit(
    c: PoolClient,
    a: Actor,
    databaseId: string | null,
    tableId: string | null,
    resourceId: string,
    operation: string,
    before: unknown,
    after: unknown,
    ctx?: MutationContext,
  ): Promise<void> {
    await c.query(
      "INSERT INTO rootset_control.resource_history(org_id,database_id,table_id,resource_id,operation,before_value,after_value,actor,context) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)",
      [
        a.orgId,
        databaseId,
        tableId,
        resourceId,
        operation,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        JSON.stringify(a),
        JSON.stringify(context(ctx)),
      ],
    );
  }
  private async journal(
    c: PoolClient,
    a: Actor,
    t: TableRecord | null,
    databaseId: string,
    kind: string,
    input: unknown,
    options: MutationOptions,
  ): Promise<{ operationId: string; replay: boolean }> {
    const key = options.idempotencyKey ?? newId();
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))", [
      `${a.orgId}:${key}`,
    ]);
    const digest = hash({
      kind,
      databaseId: kind === "database.create" ? null : databaseId,
      tableId: t?.id ?? null,
      input: schemaPayload(input),
    });
    const existing = await c.query<Raw>(
      "SELECT * FROM rootset_control.schema_operations WHERE org_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [a.orgId, key],
    );
    if (existing.rows[0]) {
      const old = existing.rows[0];
      if (old.input_hash !== digest)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "Schema idempotency key was used for a different request",
          409,
        );
      return { operationId: String(old.id), replay: old.state === "committed" };
    }
    const operationId = newId();
    await c.query(
      "INSERT INTO rootset_control.schema_operations(id,org_id,database_id,table_id,idempotency_key,input_hash,expected_version,kind,before_definition,after_definition,plan) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)",
      [
        operationId,
        a.orgId,
        databaseId,
        t?.id ?? null,
        key,
        digest,
        options.expectedSchemaVersion ?? null,
        kind,
        t ? JSON.stringify(t) : null,
        JSON.stringify(schemaPayload(input)),
        JSON.stringify({
          transactional: true,
          ...(options.context?.jobFence
            ? { jobId: options.context.jobFence.jobId }
            : {}),
        }),
      ],
    );
    return { operationId, replay: false };
  }
  private expected(t: TableRecord, expected: number | undefined): void {
    if (expected !== undefined && t.schemaVersion !== expected)
      fail(
        "SCHEMA_VERSION_CONFLICT",
        "Schema version changed; reload before editing",
        409,
        { currentSchemaVersion: t.schemaVersion },
      );
  }
  private async finish(c: PoolClient, op: string, t?: string): Promise<void> {
    if (t)
      await c.query(
        "UPDATE rootset_control.tables SET schema_version=schema_version+1,updated_at=now() WHERE id=$1",
        [t],
      );
    await c.query(
      "UPDATE rootset_control.schema_operations SET state='committed',committed_at=now() WHERE id=$1",
      [op],
    );
  }
  private async createPhysical(
    c: PoolClient,
    t: TableRecord,
    withTrigger = true,
  ): Promise<void> {
    const columns = t.fields
      .map((f) => `${q(fieldColumn(f))} ${physicalType(f)}`)
      .join(",");
    await c.query(
      `CREATE TABLE ${tablePath(t)} (row_id varchar(26) PRIMARY KEY,org_id varchar(26) NOT NULL CHECK(org_id=${literal(t.orgId)}),row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()${columns ? "," + columns : ""})`,
    );
    await c.query(`ALTER TABLE ${tablePath(t)} ENABLE ROW LEVEL SECURITY`);
    await c.query(`ALTER TABLE ${tablePath(t)} FORCE ROW LEVEL SECURITY`);
    await c.query(
      `CREATE POLICY org_isolation ON ${tablePath(t)} USING(org_id=(SELECT rootset_control.current_org_id())) WITH CHECK(org_id=(SELECT rootset_control.current_org_id()))`,
    );
    if (withTrigger) await this.installTrigger(c, t);
  }
  private async installTrigger(c: PoolClient, t: TableRecord): Promise<void> {
    await c.query(
      `CREATE TRIGGER rootset_enforce BEFORE INSERT OR UPDATE OR DELETE ON ${tablePath(t)} FOR EACH ROW EXECUTE FUNCTION rootset_control.enforce_row(${literal(t.id)})`,
    );
  }
  async createDatabase(
    a: Actor,
    input: { name: string; description?: string | null } & MutationOptions,
  ): Promise<DatabaseRecord> {
    return this.run(
      a,
      async (c) => {
        const databaseId = newId();
        const j = await this.journal(
          c,
          a,
          null,
          databaseId,
          "database.create",
          { name: input.name, description: input.description ?? "" },
          input,
        );
        if (j.replay) {
          const old = await c.query<{ database_id: string }>(
            "SELECT database_id FROM rootset_control.schema_operations WHERE id=$1",
            [j.operationId],
          );
          return this.database(c, a, old.rows[0]!.database_id, true);
        }
        await this.assertPublication(c, a, input.context, false);
        const schemaName = `rsd_${databaseId.toLowerCase()}`;
        await c.query(
          "INSERT INTO rootset_control.databases(id,org_id,name,description,schema_name) VALUES($1,$2,$3,$4,$5)",
          [
            databaseId,
            a.orgId,
            name(input.name),
            input.description ?? "",
            schemaName,
          ],
        );
        await c.query(`CREATE SCHEMA ${q(schemaName)}`);
        const result = await this.database(c, a, databaseId);
        await this.assertPublication(c, a, input.context);
        await this.finish(c, j.operationId);
        await this.audit(
          c,
          a,
          databaseId,
          null,
          databaseId,
          "database.create",
          null,
          result,
          input.context,
        );
        return result;
      },
      true,
    );
  }
  async listDatabases(
    a: Actor,
  ): Promise<(DatabaseRecord & { tableCount: number })[]> {
    return this.run(a, async (c) => {
      const r = await c.query<Raw>(
        `SELECT d.*,
          (SELECT count(*) FROM rootset_control.tables t
           WHERE t.database_id=d.id AND t.org_id=d.org_id
             AND t.state IN ('active','maintenance')) AS table_count
         FROM rootset_control.databases d
         WHERE d.org_id=$1 AND d.state='active' ORDER BY d.created_at,d.id`,
        [a.orgId],
      );
      return r.rows.map((d) => ({
        ...this.databaseRecord(d),
        tableCount: Number(d.table_count),
      }));
    });
  }
  async getDatabase(a: Actor, databaseId: string): Promise<DatabaseRecord> {
    return this.run(a, (c) => this.database(c, a, databaseId));
  }
  async getArchivedDatabase(
    a: Actor,
    databaseId: string,
  ): Promise<DatabaseRecord> {
    return this.run(a, (c) => this.database(c, a, databaseId, true));
  }
  async updateDatabase(
    a: Actor,
    databaseId: string,
    input: { name?: string; description?: string | null } & MutationOptions,
  ): Promise<DatabaseRecord> {
    return this.run(
      a,
      async (c) => {
        const before = await this.database(c, a, databaseId, true);
        await this.barrier(c, before.id);
        const j = await this.journal(
          c,
          a,
          null,
          before.id,
          "database.update",
          input,
          input,
        );
        if (j.replay) return before;
        await this.assertPublication(c, a, input.context, false);
        if (before.state !== "active")
          fail("RESOURCE_NOT_FOUND", "Database was not found", 404);
        await c.query(
          "UPDATE rootset_control.databases SET name=$2,description=$3,updated_at=now() WHERE id=$1",
          [
            before.id,
            input.name === undefined ? before.name : name(input.name),
            input.description === undefined
              ? before.description
              : (input.description ?? ""),
          ],
        );
        const after = await this.database(c, a, databaseId);
        await this.assertPublication(c, a, input.context);
        await this.finish(c, j.operationId);
        await this.audit(
          c,
          a,
          before.id,
          null,
          before.id,
          "database.update",
          before,
          after,
          input.context,
        );
        return after;
      },
      true,
    );
  }
  async deleteDatabase(
    a: Actor,
    databaseId: string,
    options: MutationOptions = {},
  ): Promise<{ id: string; state: string }> {
    return this.run(
      a,
      async (c) => {
        const d = await this.database(c, a, databaseId, true);
        await this.barrier(c, d.id);
        const j = await this.journal(
          c,
          a,
          null,
          d.id,
          "database.delete",
          {},
          options,
        );
        if (j.replay) return { id: d.id, state: "deleted" };
        await this.assertPublication(c, a, options.context);
        if (d.state === "deleted") {
          await this.finish(c, j.operationId);
          return { id: d.id, state: "deleted" };
        }
        await c.query(
          "UPDATE rootset_control.databases SET state='deleted',deleted_at=now(),updated_at=now() WHERE id=$1",
          [d.id],
        );
        await c.query(
          "UPDATE rootset_control.tables SET state='deleted',deleted_at=now() WHERE database_id=$1",
          [d.id],
        );
        await this.audit(
          c,
          a,
          d.id,
          null,
          d.id,
          "database.delete",
          d,
          null,
          options.context,
        );
        await this.assertPublication(c, a, options.context);
        await this.finish(c, j.operationId);
        return { id: d.id, state: "deleted" };
      },
      true,
    );
  }
  async createTable(
    a: Actor,
    databaseId: string,
    input: {
      name: string;
      description?: string | null;
      fields?: FieldInput[];
    } & MutationOptions,
  ): Promise<TableRecord> {
    return this.run(
      a,
      async (c) => {
        const d = await this.database(c, a, databaseId, true);
        await this.barrier(c, d.id);
        const fields = (input.fields ?? []).map((f, i) =>
          field({ ...f, order: i }),
        );
        if (fields.length > limits.maxFields)
          fail("VALIDATION_FAILED", "Field limit exceeded");
        assertFieldNames(fields);
        assertRowBytes(
          fields,
          Object.fromEntries(fields.map((f) => [f.name, null])),
        );
        const t: TableRecord = {
          id: newId(),
          orgId: a.orgId,
          databaseId: d.id,
          name: name(input.name),
          description: input.description ?? "",
          physicalName: "",
          schemaName: d.schemaName,
          generation: 1,
          schemaVersion: 1,
          rowCount: 0,
          state: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          fields,
        };
        t.physicalName = `rst_${t.id.toLowerCase()}`;
        const j = await this.journal(
          c,
          a,
          null,
          d.id,
          "table.create",
          {
            name: t.name,
            description: t.description,
            fields: input.fields ?? [],
          },
          input,
        );
        if (j.replay) {
          const rr = await c.query<{ table_id: string }>(
            "SELECT table_id FROM rootset_control.schema_operations WHERE id=$1",
            [j.operationId],
          );
          return this.table(c, a, rr.rows[0]!.table_id, false, true);
        }
        if (d.state !== "active")
          fail("RESOURCE_NOT_FOUND", "Database was not found", 404);
        await this.assertPublication(c, a, input.context, false);
        await c.query(
          "INSERT INTO rootset_control.tables(id,database_id,org_id,name,physical_name,description) VALUES($1,$2,$3,$4,$5,$6)",
          [t.id, d.id, a.orgId, t.name, t.physicalName, t.description],
        );
        for (const f of fields) await this.insertField(c, t, f);
        await this.createPhysical(c, t);
        await c.query(
          "UPDATE rootset_control.schema_operations SET table_id=$2 WHERE id=$1",
          [j.operationId, t.id],
        );
        await this.assertPublication(c, a, input.context);
        await this.finish(c, j.operationId);
        await this.audit(
          c,
          a,
          d.id,
          t.id,
          t.id,
          "table.create",
          null,
          t,
          input.context,
        );
        return t;
      },
      true,
    );
  }
  private async insertField(
    c: PoolClient,
    t: TableRecord,
    f: FieldDefinition,
    state = "active",
  ): Promise<void> {
    await c.query(
      "INSERT INTO rootset_control.fields(id,table_id,org_id,name,definition,position,state) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [
        f.id,
        t.id,
        t.orgId,
        f.name,
        JSON.stringify(f),
        f.order ?? t.fields.length,
        state,
      ],
    );
  }
  async listTables(a: Actor, databaseId: string): Promise<TableRecord[]> {
    return this.run(a, async (c) => {
      const d = await this.database(c, a, databaseId);
      const r = await c.query<{ id: string }>(
        "SELECT id FROM rootset_control.tables WHERE database_id=$1 AND org_id=$2 AND state IN ('active','maintenance') ORDER BY created_at,id",
        [d.id, a.orgId],
      );
      return Promise.all(r.rows.map((t) => this.table(c, a, t.id)));
    });
  }
  async getTable(a: Actor, tableId: string): Promise<TableRecord> {
    return this.run(a, (c) => this.table(c, a, tableId));
  }
  async getArchivedTable(a: Actor, tableId: string): Promise<TableRecord> {
    return this.run(a, (c) => this.table(c, a, tableId, false, true));
  }
  async updateTable(
    a: Actor,
    tableId: string,
    input: { name?: string; description?: string | null } & SchemaOptions,
  ): Promise<TableRecord> {
    return this.schemaChange(
      a,
      tableId,
      "table.update",
      input,
      async (c, t) => {
        await c.query(
          "UPDATE rootset_control.tables SET name=$2,description=$3 WHERE id=$1",
          [
            t.id,
            input.name === undefined ? t.name : name(input.name),
            input.description === undefined
              ? t.description
              : (input.description ?? ""),
          ],
        );
      },
    );
  }
  async deleteTable(
    a: Actor,
    tableId: string,
    options: SchemaOptions,
  ): Promise<{ id: string; state: string }> {
    await this.schemaChange(
      a,
      tableId,
      "table.delete",
      options,
      async (c, t) => {
        await c.query(
          "UPDATE rootset_control.tables SET state='deleted',deleted_at=now() WHERE id=$1",
          [t.id],
        );
      },
    );
    return { id: id(tableId), state: "deleted" };
  }
  private async schemaChange<T extends SchemaOptions>(
    a: Actor,
    tableId: string,
    kind: string,
    input: T,
    change: (
      c: PoolClient,
      t: TableRecord,
      operationId: string,
    ) => Promise<void>,
    replayed?: (c: PoolClient, operationId: string) => Promise<void>,
  ): Promise<TableRecord> {
    return this.run(
      a,
      async (c) => {
        let t = await this.table(c, a, tableId, false, true);
        if (kind === "field.create" || kind === "rule.create")
          await this.barrier(c, t.databaseId);
        t = await this.table(c, a, tableId, true, true);
        const j = await this.journal(c, a, t, t.databaseId, kind, input, input);
        if (j.replay) {
          await replayed?.(c, j.operationId);
          return t;
        }
        await this.database(c, a, t.databaseId);
        this.expected(t, input.expectedSchemaVersion);
        if (t.state !== "active")
          fail("SCHEMA_MAINTENANCE", "Table is in maintenance", 409);
        await this.assertPublication(c, a, input.context, false);
        if (kind === "rule.create" && input.context?.jobFence) {
          await c.query("SET LOCAL statement_timeout='0'");
          await c.query("SET LOCAL lock_timeout='10s'");
        }
        await change(c, t, j.operationId);
        await this.assertPublication(c, a, input.context);
        await this.finish(c, j.operationId, t.id);
        const after = await this.table(c, a, t.id, false, true);
        await this.audit(
          c,
          a,
          t.databaseId,
          t.id,
          t.id,
          kind,
          t,
          after,
          input.context,
        );
        return after;
      },
      true,
    );
  }
  async createField(
    a: Actor,
    tableId: string,
    input: FieldInput & SchemaOptions,
  ): Promise<TableRecord> {
    return this.schemaChange(
      a,
      tableId,
      "field.create",
      input,
      async (c, t) => {
        if (t.fields.length >= limits.maxFields)
          fail("VALIDATION_FAILED", "Field limit exceeded");
        const f = field({
          ...fieldPatch(input),
          name: input.name,
          type: input.type,
          order: t.fields.length,
        });
        const future = [...t.fields, f];
        assertFieldNames(future);
        const value = Object.hasOwn(f, "default") ? f.default! : null;
        if (t.rowCount > 0 || value !== null || Object.hasOwn(f, "default"))
          validateCell(f, value);
        await this.validateRows(c, t, future, (row) => ({
          ...row.values,
          [f.name]: value,
        }));
        await c.query(
          `ALTER TABLE ${tablePath(t)} ADD COLUMN ${q(fieldColumn(f))} ${physicalType(f)}`,
        );
        await this.insertField(c, t, f);
        if (value !== null) {
          const m = await this.newMutation(
            c,
            a,
            t,
            { kind: "field.default", field: f.id },
            newId(),
            context({ ...input.context, source: "schema" }),
          );
          await c.query(
            "SELECT set_config('rootset.schema_write','true',true)",
          );
          await c.query(`UPDATE ${tablePath(t)} SET ${q(fieldColumn(f))}=$1`, [
            parameter(f, value),
          ]);
          await c.query(
            "UPDATE rootset_control.mutations SET outcome=$2::jsonb WHERE id=$1",
            [m.id, JSON.stringify({ fieldId: f.id })],
          );
        }
      },
    );
  }
  private async validateRows(
    c: PoolClient,
    t: TableRecord,
    fields: FieldDefinition[],
    map: (row: Row) => Record<string, JsonValue>,
  ): Promise<void> {
    for await (const batch of this.iterateRows(c, t)) {
      for (const r of batch) {
        const values = validateValues(fields, map(r));
        assertRowBytes(fields, values);
      }
    }
  }
  async updateField(
    a: Actor,
    tableId: string,
    fieldId: string,
    input: Partial<FieldInput> &
      SchemaOptions & {
        conversion?: { strategy: "strict" | "stringify" | "parse" };
      },
  ): Promise<TableRecord> {
    const current = await this.getTable(a, tableId);
    const fieldIdentity = id(fieldId);
    if (input.idempotencyKey) {
      const prior = await this.run(
        a,
        async (c) =>
          (
            await c.query<Raw>(
              "SELECT * FROM rootset_control.schema_operations WHERE org_id=$1 AND idempotency_key=$2",
              [a.orgId, input.idempotencyKey],
            )
          ).rows[0],
      );
      if (prior?.kind === "field.convert" && prior.state === "committed") {
        if (
          prior.input_hash !==
          hash({
            kind: "field.convert",
            databaseId: current.databaseId,
            tableId: current.id,
            input: schemaPayload({ ...input, fieldId: fieldIdentity }),
          })
        )
          fail(
            "IDEMPOTENCY_CONFLICT",
            "Schema idempotency key was used for a different request",
            409,
          );
        return current;
      }
    }
    const old = fieldFor(current, fieldId);
    if (input.type && input.type !== old.type)
      return this.convertField(a, tableId, old.id, input);
    return this.schemaChange(
      a,
      tableId,
      "field.update",
      { ...input, fieldId: fieldIdentity },
      async (c, t) => {
        const before = fieldFor(t, fieldId);
        const patch = fieldPatch(input);
        const f = field({ ...before, ...patch }, before.id);
        const fields = t.fields.map((x) => (x.id === f.id ? f : x));
        assertFieldNames(fields);
        await this.validateRows(c, t, fields, (r) =>
          renamedValues(r.values, before, f),
        );
        await c.query(
          "UPDATE rootset_control.fields SET name=$2,definition=$3::jsonb,position=$4 WHERE id=$1",
          [f.id, f.name, JSON.stringify(f), f.order ?? before.order ?? 0],
        );
      },
    );
  }
  async reorderFields(
    a: Actor,
    tableId: string,
    inputOrIds: ({ fieldIds: string[] } & SchemaOptions) | string[],
    options?: SchemaOptions,
  ): Promise<TableRecord> {
    const input = Array.isArray(inputOrIds)
      ? { fieldIds: inputOrIds, ...options! }
      : inputOrIds;
    return this.schemaChange(
      a,
      tableId,
      "fields.reorder",
      input,
      async (c, t) => {
        if (
          input.fieldIds.length !== t.fields.length ||
          new Set(input.fieldIds).size !== t.fields.length ||
          input.fieldIds.some((x) => !t.fields.some((f) => f.id === x))
        )
          fail(
            "VALIDATION_FAILED",
            "Reordering requires every active field exactly once",
          );
        for (const [i, fid] of input.fieldIds.entries())
          await c.query(
            "UPDATE rootset_control.fields SET position=$2,definition=jsonb_set(definition,'{order}',to_jsonb($2::integer)) WHERE id=$1",
            [fid, i],
          );
      },
    );
  }
  async deleteField(
    a: Actor,
    tableId: string,
    fieldId: string,
    input: SchemaOptions & { removeDependencies?: boolean },
  ): Promise<TableRecord> {
    return this.schemaChange(
      a,
      tableId,
      "field.delete",
      { ...input, fieldId: id(fieldId) },
      async (c, t) => {
        const f = fieldFor(t, fieldId);
        const rules = await c.query<Raw>(
          "SELECT * FROM rootset_control.unique_rules WHERE table_id=$1 AND $2=ANY(field_ids) AND state='active'",
          [t.id, f.id],
        );
        const indexes = await c.query<Raw>(
          "SELECT * FROM rootset_control.indexes WHERE table_id=$1 AND field_id=$2 AND state='active'",
          [t.id, f.id],
        );
        if ((rules.rowCount || indexes.rowCount) && !input.removeDependencies)
          fail(
            "VALIDATION_FAILED",
            "Field has rule/index dependencies; explicit removal approval is required",
          );
        for (const r of rules.rows) await this.removeRule(c, t, r);
        for (const i of indexes.rows) await this.removeIndex(c, t, i);
        await c.query(
          "UPDATE rootset_control.fields SET state='deleted',deleted_at=now() WHERE id=$1",
          [f.id],
        );
        await c.query(
          `ALTER TABLE ${tablePath(t)} DROP COLUMN ${q(fieldColumn(f))}`,
        );
        for (const [position, remaining] of t.fields
          .filter((other) => other.id !== f.id)
          .entries())
          await c.query(
            "UPDATE rootset_control.fields SET position=$2,definition=jsonb_set(definition,'{order}',to_jsonb($2::integer)) WHERE id=$1",
            [remaining.id, position],
          );
      },
    );
  }
  private async newMutation(
    c: PoolClient,
    a: Actor,
    t: TableRecord,
    input: unknown,
    key: string | undefined,
    ctx: MutationContext,
  ): Promise<{ id: string; replay: MutationResult | null }> {
    const digest = hash(input);
    if (key) {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
        `${a.orgId}:${t.id}:${key}`,
      ]);
      const existing = await c.query<Raw>(
        "SELECT * FROM rootset_control.mutations WHERE org_id=$1 AND table_id=$2 AND idempotency_key=$3",
        [a.orgId, t.id, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].input_hash !== digest)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used with different input",
            409,
          );
        return {
          id: String(existing.rows[0].id),
          replay: existing.rows[0].outcome as MutationResult,
        };
      }
    }
    const mutationId = newId();
    await c.query(
      "INSERT INTO rootset_control.mutations(id,org_id,table_id,idempotency_key,input_hash,actor,context,schema_version) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)",
      [
        mutationId,
        a.orgId,
        t.id,
        key ?? null,
        digest,
        JSON.stringify(a),
        JSON.stringify(context(ctx)),
        t.schemaVersion,
      ],
    );
    await c.query("SELECT set_config('rootset.mutation_id',$1,true)", [
      mutationId,
    ]);
    return { id: mutationId, replay: null };
  }
  async mutateRows(
    a: Actor,
    tableId: string,
    input: { operations: RowOperation[] } & MutationOptions,
    client?: PoolClient,
  ): Promise<MutationResult> {
    const work = async (c: PoolClient): Promise<MutationResult> => {
      const currentOrg = await c.query<{ org_id: string }>(
        "SELECT current_setting('rootset.org_id',true) AS org_id",
      );
      if (currentOrg.rows[0]?.org_id !== a.orgId)
        fail(
          "ACCESS_DENIED",
          "Mutation transaction has an invalid organisation context",
          403,
        );
      const sourceBudget =
        input.context?.source === "mcp"
          ? limits.mcpResultBytes
          : limits.restResultBytes;
      if (
        input.responseBudget !== undefined &&
        (!Number.isSafeInteger(input.responseBudget) ||
          input.responseBudget < 1 ||
          input.responseBudget > sourceBudget)
      )
        fail("VALIDATION_FAILED", "Invalid trusted mutation response budget");
      const resultBudget = Math.min(
        input.responseBudget ?? sourceBudget,
        sourceBudget,
      );
      const checkedOutcome = (outcome: MutationResult): string => {
        const serialized = JSON.stringify(outcome);
        if (
          Buffer.byteLength(serialized) + 2048 + input.operations.length * 200 >
          resultBudget
        )
          fail(
            "PAYLOAD_TOO_LARGE",
            "Complete mutation result exceeds the transport byte budget; use a smaller batch",
            413,
          );
        return serialized;
      };
      let repair = input.context?.repair;
      if (repair) {
        if (a.role !== "admin" || !a.userId)
          fail("OPERATOR_REQUIRED", "Repair requires a personal operator", 403);
        if (
          input.context?.source !== "operator" ||
          typeof input.context.beforePublish !== "function" ||
          typeof input.onCommit !== "function" ||
          !input.context.jobFence ||
          input.context.jobId !== repair.jobId ||
          input.context.jobFence.jobId !== repair.jobId
        )
          fail("ACCESS_DENIED", "Repair requires a bound approved worker", 403);
        const reason = OperatorRepairReasonSchema.safeParse(repair.reason);
        if (
          !reason.success ||
          !SchemaVersionSchema.safeParse(input.expectedSchemaVersion).success ||
          !IdSchema.safeParse(repair.approvalId).success ||
          !IdSchema.safeParse(repair.jobId).success ||
          !input.idempotencyKey ||
          input.idempotencyKey.length > 128 ||
          !Array.isArray(input.operations) ||
          !input.operations.length ||
          input.operations.some(
            (operation) =>
              operation.kind !== "update" ||
              !VersionSchema.safeParse(operation.expectedVersion).success,
          )
        )
          fail(
            "VALIDATION_FAILED",
            "Repair requires a bounded reason and updates",
          );
        repair = { ...repair, reason: reason.data };
        canonicalJson({ reason: repair.reason });
      }
      const mutationInput = {
        operations: input.operations,
        expectedSchemaVersion: input.expectedSchemaVersion ?? null,
        ...(repair
          ? {
              repair: {
                reason: repair.reason,
                approvalId: repair.approvalId,
                jobId: repair.jobId,
              },
            }
          : {}),
      };
      let t = await this.table(c, a, tableId, false, true);
      if (input.idempotencyKey) {
        const existing = (
          await c.query<Raw>(
            "SELECT input_hash,outcome FROM rootset_control.mutations WHERE org_id=$1 AND table_id=$2 AND idempotency_key=$3",
            [a.orgId, t.id, input.idempotencyKey],
          )
        ).rows[0];
        if (existing) {
          if (existing.input_hash !== hash(mutationInput))
            fail(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was used with different input",
              409,
            );
          if (existing.outcome) {
            const outcome = existing.outcome as MutationResult;
            if (input.responseBudget !== undefined) checkedOutcome(outcome);
            if (input.onCommit) {
              await this.assertPublication(c, a, input.context);
              await input.onCommit(c, outcome);
            }
            return outcome;
          }
        }
      }
      await this.database(c, a, t.databaseId);
      if (t.state !== "active")
        fail("SCHEMA_MAINTENANCE", "Table is in maintenance", 409);
      if (
        !Array.isArray(input.operations) ||
        input.operations.length < 1 ||
        input.operations.length > limits.mutationBatch
      )
        fail(
          "VALIDATION_FAILED",
          "Mutation batch must contain 1–1000 operations",
        );
      const requestBytes = Buffer.byteLength(JSON.stringify(input));
      if (requestBytes > limits.requestBytes)
        fail("PAYLOAD_TOO_LARGE", "Mutation request exceeds 8 MiB", 413);
      await c.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
        [t.databaseId],
      );

      t = await this.table(c, a, tableId, true);
      this.expected(t, input.expectedSchemaVersion);
      if (t.state !== "active")
        fail("SCHEMA_MAINTENANCE", "Table is in maintenance", 409);
      if (
        !Array.isArray(input.operations) ||
        input.operations.length < 1 ||
        input.operations.length > limits.mutationBatch
      )
        fail(
          "VALIDATION_FAILED",
          "Mutation batch must contain 1–1000 operations",
        );
      if (Buffer.byteLength(JSON.stringify(input)) > limits.requestBytes)
        fail("PAYLOAD_TOO_LARGE", "Mutation request exceeds 8 MiB", 413);
      const m = await this.newMutation(
        c,
        a,
        t,
        mutationInput,
        input.idempotencyKey,
        input.context ?? {},
      );
      if (m.replay) {
        if (input.responseBudget !== undefined) checkedOutcome(m.replay);
        if (input.onCommit) {
          await this.assertPublication(c, a, input.context);
          await input.onCommit(c, m.replay);
        }
        return m.replay;
      }
      const rows: Row[] = [];
      const deletedIds: string[] = [];
      const returnRows = input.context?.source !== "import";
      for (const op of input.operations) {
        if (op.kind === "create") {
          const values = validateValues(t.fields, op.values);
          assertRowBytes(t.fields, values);
          const keys = t.fields.map((f) => q(fieldColumn(f)));
          const params = t.fields.map((f) => parameter(f, values[f.name]!));
          const r = await c.query<Raw>(
            `INSERT INTO ${tablePath(t)}(row_id,org_id${keys.length ? "," + keys.join(",") : ""}) VALUES($1,$2${params.map((_, i) => `,$${i + 3}`).join("")}) RETURNING *`,
            [newId(), a.orgId, ...params],
          );
          if (returnRows) rows.push(rowFrom(r.rows[0]!, t.fields));
        } else if (op.kind === "update") {
          const rowId = id(op.rowId);
          const expected = VersionSchema.parse(op.expectedVersion);
          const found = await c.query<Raw>(
            `SELECT * FROM ${tablePath(t)} WHERE row_id=$1 FOR UPDATE`,
            [rowId],
          );
          if (!found.rows[0])
            fail("RESOURCE_NOT_FOUND", "Row was not found", 404);
          if (String(found.rows[0].row_version) !== expected)
            fail(
              "ROW_VERSION_CONFLICT",
              "Row was changed by another writer",
              409,
              { currentVersion: String(found.rows[0].row_version) },
            );
          const patch = validateValues(t.fields, op.values, "patch");
          const old = rowFrom(found.rows[0], t.fields);
          assertRowBytes(t.fields, { ...old.values, ...patch });
          const fields = t.fields.filter((f) => Object.hasOwn(patch, f.name));
          if (!fields.length) {
            if (returnRows) rows.push(old);
            continue;
          }
          const r = await c.query<Raw>(
            `UPDATE ${tablePath(t)} SET ${fields.map((f, i) => `${q(fieldColumn(f))}=$${i + 2}`).join(",")} WHERE row_id=$1 RETURNING *`,
            [rowId, ...fields.map((f) => parameter(f, patch[f.name]!))],
          );
          if (returnRows) rows.push(rowFrom(r.rows[0]!, t.fields));
        } else if (op.kind === "delete") {
          const rowId = id(op.rowId);
          const expected = VersionSchema.parse(op.expectedVersion);
          const found = await c.query<Raw>(
            `SELECT row_version FROM ${tablePath(t)} WHERE row_id=$1 FOR UPDATE`,
            [rowId],
          );
          if (!found.rows[0])
            fail("RESOURCE_NOT_FOUND", "Row was not found", 404);
          if (String(found.rows[0].row_version) !== expected)
            fail(
              "ROW_VERSION_CONFLICT",
              "Row was changed by another writer",
              409,
              { currentVersion: String(found.rows[0].row_version) },
            );
          await c.query(`DELETE FROM ${tablePath(t)} WHERE row_id=$1`, [rowId]);
          deletedIds.push(rowId);
        } else fail("VALIDATION_FAILED", "Unknown mutation operation");
      }
      const outcome = {
        mutationId: m.id,
        schemaVersion: t.schemaVersion,
        rows,
        deletedIds,
      };
      const outcomeJson = checkedOutcome(outcome);
      await this.assertPublication(c, a, input.context);
      await c.query(
        "UPDATE rootset_control.mutations SET outcome=$2::jsonb WHERE id=$1",
        [m.id, outcomeJson],
      );
      if (repair)
        await c.query(
          "SELECT rootset_control.append_operator_repair_completion($1,$2,$3,$4)",
          [a.orgId, repair.jobId, input.context!.jobFence!.leaseToken, m.id],
        );
      await input.onCommit?.(c, outcome);
      return outcome;
    };
    if (client) {
      try {
        return await work(client);
      } catch (error) {
        storageError(error);
      }
    }
    return this.run(a, work);
  }
  async createRow(
    a: Actor,
    tableId: string,
    values: Record<string, JsonValue>,
    options: MutationOptions = {},
  ): Promise<Row & { mutationId: string }> {
    const r = await this.mutateRows(a, tableId, {
      ...options,
      operations: [{ kind: "create", values }],
    });
    return { ...r.rows[0]!, mutationId: r.mutationId };
  }
  async updateRow(
    a: Actor,
    tableId: string,
    rowId: string,
    values: Record<string, JsonValue>,
    options: MutationOptions & { expectedVersion: string },
  ): Promise<Row & { mutationId: string }> {
    const r = await this.mutateRows(a, tableId, {
      ...options,
      operations: [
        {
          kind: "update",
          rowId,
          values,
          expectedVersion: options.expectedVersion,
        },
      ],
    });
    return { ...r.rows[0]!, mutationId: r.mutationId };
  }
  async deleteRow(
    a: Actor,
    tableId: string,
    rowId: string,
    options: MutationOptions & { expectedVersion: string },
  ): Promise<{ id: string; mutationId: string }> {
    const r = await this.mutateRows(a, tableId, {
      ...options,
      operations: [
        { kind: "delete", rowId, expectedVersion: options.expectedVersion },
      ],
    });
    return { id: id(rowId), mutationId: r.mutationId };
  }
  async getRow(a: Actor, tableId: string, rowId: string): Promise<Row> {
    return this.run(a, async (c) => {
      const t = await this.table(c, a, tableId);
      const r = await c.query<Raw>(
        `SELECT * FROM ${tablePath(t)} WHERE row_id=$1`,
        [id(rowId)],
      );
      if (!r.rows[0]) fail("RESOURCE_NOT_FOUND", "Row was not found", 404);
      return rowFrom(r.rows[0], t.fields);
    });
  }
  async getMutation(
    a: Actor,
    tableId: string,
    mutationId: string,
  ): Promise<MutationResult> {
    return this.run(a, async (c) => {
      await this.table(c, a, tableId);
      const r = await c.query<{ outcome: MutationResult }>(
        "SELECT outcome FROM rootset_control.mutations WHERE id=$1 AND org_id=$2 AND table_id=$3",
        [id(mutationId), a.orgId, id(tableId)],
      );
      return (
        r.rows[0]?.outcome ??
        fail("RESOURCE_NOT_FOUND", "Mutation was not found", 404)
      );
    });
  }
  async queryRows(
    a: Actor,
    tableId: string,
    input: QuerySpec = {},
    options: {
      surface?: "rest" | "mcp" | "ui";
      byteLimit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<QueryResult> {
    return this.read(
      a,
      async (c) => {
        const t = await this.table(c, a, tableId);
        const defaultRows =
          options.surface === "mcp"
            ? limits.mcpDefaultRows
            : options.surface === "ui"
              ? limits.uiDefaultRows
              : limits.restDefaultRows;
        const compiled = compileQuery(t.fields, {
          ...input,
          limit: input.limit ?? defaultRows,
        });
        const binding = {
          orgId: a.orgId,
          tableId: t.id,
          schemaVersion: t.schemaVersion,
          membershipVersion: a.membershipVersion ?? 0,
          actorId: a.id,
          queryHash: compiled.queryHash,
        };
        const params = [...compiled.params];
        let where = compiled.where;
        if (input.cursor) {
          const last = this.cursor.decode(input.cursor, binding);
          const keyset = compileKeyset(compiled.sorts, last, params.length + 1);
          where = `(${where}) AND (${keyset.where})`;
          params.push(...keyset.params);
        }
        const needed = new Map(
          [
            ...compiled.projection,
            ...compiled.sorts.flatMap((s) =>
              s.fieldId ? t.fields.filter((f) => f.id === s.fieldId) : [],
            ),
          ].map((f) => [f.id, f]),
        );
        params.push(compiled.limit + 1);
        await c.query("SELECT set_config('statement_timeout',$1,true)", [
          String(limits.queryTimeoutMs),
        ]);
        const byteLimit = Math.min(
          options.byteLimit ??
            (options.surface === "mcp"
              ? limits.mcpResultBytes
              : limits.restResultBytes),
          options.surface === "mcp"
            ? limits.mcpResultBytes
            : limits.restResultBytes,
        );
        if (!Number.isSafeInteger(byteLimit) || byteLimit < 1)
          fail("VALIDATION_FAILED", "Invalid response byte budget");
        const deadline = Date.now() + limits.queryTimeoutMs;
        await c.query(
          `DECLARE rootset_page NO SCROLL CURSOR FOR SELECT row_id,row_version,created_at,updated_at${needed.size ? "," + [...needed.values()].map((f) => q(fieldColumn(f))).join(",") : ""} FROM ${tablePath(t)} WHERE ${where} ORDER BY ${compiled.orderBy} LIMIT $${params.length}`,
          params,
        );
        const data: Row[] = [];
        let valueBytes = 0,
          nextCursor: string | null = null,
          hasMore = false,
          stop = false;
        let stopReason: QueryResult["page"]["stopReason"] = "end";
        while (!stop && data.length <= compiled.limit) {
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            fail(
              "QUERY_TIMEOUT",
              "Query exceeded its ten-second execution budget",
              408,
            );
          await c.query("SELECT set_config('statement_timeout',$1,true)", [
            String(remaining),
          ]);
          const batch = await c.query<Raw>(
            `FETCH FORWARD ${Math.min(200, compiled.limit + 1 - data.length)} FROM rootset_page`,
          );
          if (!batch.rows.length) break;
          for (const raw of batch.rows) {
            if (data.length >= compiled.limit) {
              hasMore = true;
              stopReason = "row_limit";
              stop = true;
              break;
            }
            const row = rowFrom(raw, compiled.projection);
            const full = rowFrom(raw, [...needed.values()]);
            const cursor = this.cursor.encode(
              binding,
              compiled.sorts.map((s) =>
                s.fieldId ? (full.values[s.name!] ?? null) : row.id,
              ),
            );
            const rowSize = Buffer.byteLength(JSON.stringify(row));
            const envelope = {
              data: [],
              schemaVersion: t.schemaVersion,
              page: {
                returned: data.length + 1,
                requestedLimit: compiled.limit,
                hasMore: true,
                nextCursor: cursor,
                stopReason: "byte_limit",
                consistency: "live",
              },
            };
            const size =
              Buffer.byteLength(JSON.stringify(envelope)) +
              valueBytes +
              rowSize +
              data.length;
            if (size > byteLimit) {
              if (!data.length)
                fail(
                  "PAYLOAD_TOO_LARGE",
                  "One complete row cannot fit the result budget",
                  413,
                );
              hasMore = true;
              stopReason = "byte_limit";
              stop = true;
              break;
            }
            data.push(row);
            valueBytes += rowSize;
            nextCursor = cursor;
          }
          if (batch.rows.length < 200) break;
        }
        if (Date.now() > deadline)
          fail(
            "QUERY_TIMEOUT",
            "Query exceeded its ten-second execution budget",
            408,
          );
        const result: QueryResult = {
          data,
          schemaVersion: t.schemaVersion,
          page: {
            returned: data.length,
            requestedLimit: compiled.limit,
            hasMore,
            nextCursor: hasMore ? nextCursor : null,
            stopReason: hasMore ? stopReason : "end",
            consistency: "live",
          },
        };
        if (Buffer.byteLength(JSON.stringify(result)) > byteLimit)
          fail(
            "PAYLOAD_TOO_LARGE",
            "Response metadata exceeds the result budget",
            413,
          );
        return result;
      },
      options.signal,
    );
  }
  async cellHistory(
    a: Actor,
    tableId: string,
    rowId: string,
    fieldId: string,
    options: { limit?: number; cursor?: string; byteLimit?: number } = {},
  ): Promise<{
    data: Raw[];
    nextCursor: string | null;
    hasMore: boolean;
    gaps: Raw[];
  }> {
    const fid = await this.run(a, async (c) => {
      const t = await this.table(c, a, tableId, false, true);
      const fields = await c.query<Raw>(
        "SELECT id FROM rootset_control.fields WHERE table_id=$1 AND (id=$2 OR name=$2) ORDER BY state LIMIT 1",
        [t.id, fieldId],
      );
      const fid = String(
        fields.rows[0]?.id ??
          fail("RESOURCE_NOT_FOUND", "Field history was not found", 404),
      );
      return fid;
    });
    return this.queryHistory(a, tableId, { ...options, rowId, fieldId: fid });
  }
  async queryHistory(
    a: Actor,
    tableId: string,
    input: {
      rowId?: string;
      fieldId?: string;
      mutationId?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
      byteLimit?: number;
    } = {},
  ): Promise<{
    data: Raw[];
    nextCursor: string | null;
    hasMore: boolean;
    gaps: Raw[];
  }> {
    return this.run(a, async (c) => {
      const t = await this.table(c, a, tableId, false, true);
      const limit = input.limit ?? 200;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.queryRows)
        fail("VALIDATION_FAILED", "History limit must be 1–25000");
      const cap = Math.min(
        input.byteLimit ?? limits.restResultBytes,
        limits.restResultBytes,
      );
      if (!Number.isSafeInteger(cap) || cap < 1)
        fail("VALIDATION_FAILED", "Invalid history byte budget");
      const timestamp: FieldDefinition = {
        id: t.id,
        name: "timestamp",
        type: "date-time",
      };
      const from =
        input.from === undefined
          ? undefined
          : String(validateCell(timestamp, input.from));
      const to =
        input.to === undefined
          ? undefined
          : String(validateCell(timestamp, input.to));
      if (from && to && from > to)
        fail("VALIDATION_FAILED", "History time range is reversed");
      const filters: Raw = {
        rowId: input.rowId ?? null,
        fieldId: input.fieldId ?? null,
        mutationId: input.mutationId ?? null,
        from: from ?? null,
        to: to ?? null,
      };
      const clauses = ["org_id=$1", "table_id=$2"];
      const params: unknown[] = [a.orgId, t.id];
      for (const [key, column] of [
        ["rowId", "row_id"],
        ["fieldId", "field_id"],
        ["mutationId", "mutation_id"],
      ] as const)
        if (input[key]) {
          params.push(id(input[key]!));
          clauses.push(`${column}=$${params.length}`);
        }
      if (from) {
        params.push(from);
        clauses.push(`changed_at>=$${params.length}::timestamptz`);
      }
      if (to) {
        params.push(to);
        clauses.push(`changed_at<=$${params.length}::timestamptz`);
      }
      const binding = {
        orgId: a.orgId,
        tableId: t.id,
        schemaVersion: t.schemaVersion,
        membershipVersion: a.membershipVersion ?? 0,
        actorId: a.id,
        queryHash: hash(filters),
      };
      if (input.cursor) {
        const tuple = this.cursor.decode(input.cursor, binding);
        if (tuple.length !== 2)
          fail("CURSOR_INVALID", "Invalid history cursor", 409);
        params.push(...tuple);
        clauses.push(
          `(changed_at,id)>($${params.length - 1}::timestamptz,$${params.length}::bigint)`,
        );
      }
      const gaps = (
        await c.query<Raw>(
          "SELECT from_time,to_time,manifest->>'archiveId' AS archive_id FROM rootset_control.history_gaps WHERE org_id=$1 AND table_id=$2 ORDER BY from_time LIMIT 1000",
          [a.orgId, t.id],
        )
      ).rows;
      const data: Raw[] = [];
      let bytes =
        Buffer.byteLength(
          JSON.stringify({ data: [], nextCursor: null, hasMore: false, gaps }),
        ) + 2048;
      if (bytes > cap)
        fail(
          "PAYLOAD_TOO_LARGE",
          "History retention metadata exceeds the result budget",
          413,
        );
      params.push(limit + 1);
      await c.query(
        `DECLARE rootset_history NO SCROLL CURSOR FOR SELECT id::text,public_id,org_id,database_id,table_id,row_id,field_id,mutation_id,old_value,new_value,field_definition,old_version::text,new_version::text,operation,actor,context,changed_at,changed_at::text AS cursor_time FROM rootset_control.cell_changes WHERE ${clauses.join(" AND ")} ORDER BY changed_at,id LIMIT $${params.length}`,
        params,
      );
      const deadline = Date.now() + limits.queryTimeoutMs;
      let hasMore = false,
        done = false;
      while (!done) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          fail(
            "QUERY_TIMEOUT",
            "History query exceeded its ten-second execution budget",
            408,
          );
        await c.query("SELECT set_config('statement_timeout',$1,true)", [
          String(remaining),
        ]);
        const requested = Math.min(100, limit + 1 - data.length);
        const fetched = await c.query<Raw>(
          `FETCH FORWARD ${requested} FROM rootset_history`,
        );
        for (const raw of fetched.rows) {
          if (data.length >= limit) {
            hasMore = true;
            done = true;
            break;
          }
          const row = { ...raw, changed_at: iso(raw.changed_at) };
          const size = Buffer.byteLength(JSON.stringify(row)) + 1;
          if (bytes + size > cap) {
            if (!data.length)
              fail(
                "PAYLOAD_TOO_LARGE",
                "One complete history event exceeds the result budget",
                413,
              );
            hasMore = true;
            done = true;
            break;
          }
          data.push(row);
          bytes += size;
        }
        if (fetched.rows.length < requested) done = true;
      }
      const tail = data.at(-1);
      return {
        data,
        nextCursor:
          hasMore && tail
            ? this.cursor.encode(binding, [
                String(tail.cursor_time),
                String(tail.id),
              ])
            : null,
        hasMore,
        gaps,
      };
    });
  }
  async rowHistory(a: Actor, tableId: string, rowId: string): Promise<Raw[]> {
    return this.run(a, async (c) => {
      await this.table(c, a, tableId, false, true);
      return (
        await c.query<Raw>(
          "SELECT * FROM rootset_control.row_events WHERE org_id=$1 AND table_id=$2 AND row_id=$3 ORDER BY changed_at,id LIMIT 25000",
          [a.orgId, id(tableId), id(rowId)],
        )
      ).rows;
    });
  }
  async resourceHistory(
    a: Actor,
    databaseId?: string,
    tableId?: string,
  ): Promise<Raw[]> {
    return this.run(
      a,
      async (c) =>
        (
          await c.query<Raw>(
            "SELECT * FROM rootset_control.resource_history WHERE org_id=$1 AND ($2::text IS NULL OR database_id=$2) AND ($3::text IS NULL OR table_id=$3) ORDER BY changed_at DESC,id DESC LIMIT 1000",
            [a.orgId, databaseId ?? null, tableId ?? null],
          )
        ).rows,
    );
  }
  async statistics(
    a: Actor,
    tableId: string,
  ): Promise<{
    rowCount: number;
    countKind: "live";
    schemaVersion: number;
    indexes: Raw[];
    bytes: number;
    indexBytes: number;
  }> {
    return this.run(a, async (c) => {
      const t = await this.table(c, a, tableId);
      const r = await c.query<{ bytes: string; index_bytes: string }>(
        "SELECT pg_table_size($1::regclass)::text AS bytes,pg_indexes_size($1::regclass)::text AS index_bytes",
        [`${q(t.schemaName)}.${q(t.physicalName)}`],
      );
      return {
        rowCount: t.rowCount,
        countKind: "live",
        schemaVersion: t.schemaVersion,
        indexes: (
          await c.query<Raw>(
            "SELECT id,state,kind FROM rootset_control.indexes WHERE table_id=$1",
            [t.id],
          )
        ).rows,
        bytes: Number(r.rows[0]?.bytes ?? 0),
        indexBytes: Number(r.rows[0]?.index_bytes ?? 0),
      };
    });
  }
  async exactCount(
    a: Actor,
    tableId: string,
    query: QuerySpec = {},
  ): Promise<number> {
    return this.run(a, async (c) => {
      const t = await this.table(c, a, tableId);
      const compiled = compileQuery(t.fields, query);
      return Number(
        (
          await c.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM ${tablePath(t)} WHERE ${compiled.where}`,
            compiled.params,
          )
        ).rows[0]?.count ?? 0,
      );
    });
  }
  async *iterateRows(
    c: PoolClient,
    t: TableRecord,
    batchSize = 1000,
  ): AsyncGenerator<Row[]> {
    let last = "";
    for (;;) {
      const r = await c.query<Raw>(
        `SELECT * FROM ${tablePath(t)} WHERE row_id>$1 ORDER BY row_id LIMIT $2`,
        [last, batchSize],
      );
      if (!r.rows.length) return;
      const rows = r.rows.map((v) => rowFrom(v, t.fields));
      yield rows;
      last = rows.at(-1)!.id;
    }
  }

  private async historyLease(
    c: PoolClient,
    a: Actor,
    tableId: string,
    options: { jobId: string; leaseToken: string },
  ): Promise<void> {
    const valid = await c.query(
      "SELECT id FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 AND target_type='table' AND target_id=$3 AND kind='history_archive' AND state='running' AND lease_token=$4 AND lease_until>clock_timestamp() AND NOT cancel_requested FOR UPDATE",
      [id(options.jobId), a.orgId, id(tableId), id(options.leaseToken)],
    );
    if (!valid.rowCount)
      fail(
        "JOB_LEASE_LOST",
        "History archive worker no longer owns an active lease",
        409,
      );
  }
  async snapshotHistory(
    a: Actor,
    tableId: string,
    input: { from?: string; to: string },
    c: PoolClient,
  ): Promise<{
    metadata: {
      formatVersion: 1;
      table: TableRecord;
      interpretations: { definition: FieldDefinition; state: string }[];
      from: string;
      to: string;
      snapshotAt: string;
      cellCount: number;
      rowCount: number;
    };
    history: () => AsyncIterable<Raw[]>;
  }> {
    const t = await this.table(c, a, tableId, false, true);
    await c.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
      [t.databaseId],
    );
    const timestamp: FieldDefinition = {
      id: t.id,
      name: "timestamp",
      type: "date-time",
    };
    const from = String(
      validateCell(timestamp, input.from ?? "0001-01-01T00:00:00.000Z"),
    );
    const to = String(validateCell(timestamp, input.to));
    if (from >= to)
      fail(
        "VALIDATION_FAILED",
        "History archive requires a nonempty half-open UTC range",
      );
    const now = (
      await c.query<{ snapshot_at: Date; valid: boolean }>(
        "SELECT transaction_timestamp() AS snapshot_at,$1::timestamptz<=transaction_timestamp() AS valid",
        [to],
      )
    ).rows[0]!;
    if (!now.valid)
      fail(
        "VALIDATION_FAILED",
        "History archive cutoff must not be in the future",
      );
    const interpretations = (
      await c.query<{ definition: FieldDefinition; state: string }>(
        "SELECT definition,state FROM rootset_control.fields WHERE org_id=$1 AND table_id=$2 ORDER BY position,id",
        [a.orgId, t.id],
      )
    ).rows;
    const counts: Record<string, number> = {};
    for (const relation of ["cell_changes", "row_events"]) {
      counts[relation] = Number(
        (
          await c.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM rootset_control.${relation} e WHERE e.org_id=$1 AND e.table_id=$2 AND e.changed_at>=$3::timestamptz AND e.changed_at<$4::timestamptz AND NOT EXISTS(SELECT 1 FROM rootset_control.history_gaps g WHERE g.org_id=e.org_id AND g.table_id=e.table_id AND g.manifest ? 'archiveId' AND e.changed_at>=g.from_time AND e.changed_at<g.to_time)`,
            [a.orgId, t.id, from, to],
          )
        ).rows[0]!.count,
      );
    }
    const history = async function* (): AsyncGenerator<Raw[]> {
      for (const relation of ["cell_changes", "row_events"]) {
        let last = "0";
        for (;;) {
          const selected = await c.query<Raw>(
            `SELECT e.*,${utcTimestamp("e.changed_at")} AS changed_at,e.id::text AS source_sequence,e.mutation_id AS original_mutation_id FROM rootset_control.${relation} e WHERE e.org_id=$1 AND e.table_id=$2 AND e.changed_at>=$3::timestamptz AND e.changed_at<$4::timestamptz AND e.id>$5::bigint AND NOT EXISTS(SELECT 1 FROM rootset_control.history_gaps g WHERE g.org_id=e.org_id AND g.table_id=e.table_id AND g.manifest ? 'archiveId' AND e.changed_at>=g.from_time AND e.changed_at<g.to_time) ORDER BY e.id LIMIT 1000`,
            [a.orgId, t.id, from, to, last],
          );
          if (!selected.rows.length) break;
          last = String(selected.rows.at(-1)!.id);
          yield selected.rows.map((raw) => {
            const data = { ...raw };
            delete data.source_sequence;
            delete data.original_mutation_id;
            data.mutation_id = raw.original_mutation_id;
            return {
              recordType: relation === "cell_changes" ? "cell" : "row",
              sequence: String(raw.source_sequence),
              data,
            };
          });
        }
      }
    };
    return {
      metadata: {
        formatVersion: 1,
        table: t,
        interpretations,
        from,
        to,
        snapshotAt: now.snapshot_at.toISOString(),
        cellCount: counts.cell_changes!,
        rowCount: counts.row_events!,
      },
      history: () => history(),
    };
  }
  private async verifiedHistoryArchive(
    c: PoolClient,
    a: Actor,
    tableId: string,
    archiveId: string,
    jobId: string,
  ): Promise<Raw> {
    const row = (
      await c.query<Raw>(
        "SELECT a.*,f.state AS artifact_state,f.purpose,f.target_id,f.checksum,f.byte_length FROM rootset_control.history_archives a JOIN rootset_control.artifacts f ON f.id=a.artifact_id AND f.org_id=a.org_id WHERE a.id=$1 AND a.org_id=$2 AND a.table_id=$3 AND a.job_id=$4 FOR UPDATE OF a",
        [id(archiveId), a.orgId, id(tableId), id(jobId)],
      )
    ).rows[0];
    if (
      !row ||
      !row.verified_at ||
      !row.manifest ||
      row.artifact_state !== "ready" ||
      row.purpose !== "history-archive" ||
      row.target_id !== tableId
    )
      fail(
        "ARTIFACT_UNVERIFIED",
        "History archive has no verified ready artifact",
        409,
      );
    const m = row.manifest as HistoryArchiveManifest;
    if (
      m.archiveId !== row.id ||
      m.orgId !== a.orgId ||
      m.tableId !== tableId ||
      m.databaseId !== row.database_id ||
      m.artifactId !== row.artifact_id ||
      m.checksum !== row.checksum ||
      m.byteLength !== Number(row.byte_length) ||
      !m.verifiedAt ||
      !m.fingerprint ||
      !Number.isSafeInteger(m.cellCount) ||
      !Number.isSafeInteger(m.rowCount) ||
      m.cellCount < 0 ||
      m.rowCount < 0 ||
      m.cellCount !== Number(row.cell_count) ||
      m.rowCount !== Number(row.row_count) ||
      m.from !== iso(row.from_time) ||
      m.to !== iso(row.to_time)
    )
      fail(
        "ARTIFACT_UNVERIFIED",
        "History archive manifest does not match its verified artifact and range",
        409,
      );
    return row;
  }
  async publishHistoryArchive(
    a: Actor,
    tableId: string,
    manifest: HistoryArchiveManifest,
    options: { jobId: string; leaseToken: string },
  ): Promise<{ archiveId: string; gapId: string }> {
    return this.run(
      a,
      async (c) => {
        await this.historyLease(c, a, tableId, options);
        const t = await this.table(c, a, tableId, false, true);
        const archive = await this.verifiedHistoryArchive(
          c,
          a,
          t.id,
          manifest.archiveId,
          options.jobId,
        );
        if (hash(manifest) !== hash(archive.manifest))
          fail(
            "ARTIFACT_UNVERIFIED",
            "Published history manifest differs from verified content",
            409,
          );
        const old = await c.query<{ id: string }>(
          "SELECT id FROM rootset_control.history_gaps WHERE org_id=$1 AND table_id=$2 AND manifest->>'archiveId'=$3",
          [a.orgId, t.id, manifest.archiveId],
        );
        if (old.rows[0])
          return { archiveId: manifest.archiveId, gapId: old.rows[0].id };
        if (archive.state !== "verified")
          fail(
            "ARTIFACT_UNVERIFIED",
            "History archive must complete verification before publication",
            409,
          );
        const overlap = await c.query(
          "SELECT id FROM rootset_control.history_gaps WHERE org_id=$1 AND table_id=$2 AND from_time<$4::timestamptz AND to_time>$3::timestamptz",
          [a.orgId, t.id, manifest.from, manifest.to],
        );
        if (overlap.rowCount)
          fail(
            "STATE_CONFLICT",
            "History archive overlaps a published retained range",
            409,
          );
        const gapId = newId();
        await c.query(
          "INSERT INTO rootset_control.history_gaps(id,org_id,table_id,from_time,to_time,manifest) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
          [
            gapId,
            a.orgId,
            t.id,
            manifest.from,
            manifest.to,
            JSON.stringify(manifest),
          ],
        );
        await c.query(
          "UPDATE rootset_control.history_archives SET state='purging',updated_at=now() WHERE id=$1",
          [manifest.archiveId],
        );
        return { archiveId: manifest.archiveId, gapId };
      },
      true,
    );
  }
  async purgeArchivedHistory(
    a: Actor,
    tableId: string,
    archiveId: string,
    options: { jobId: string; leaseToken: string; batchSize?: number },
  ): Promise<{
    done: boolean;
    deletedCells: number;
    deletedRows: number;
    purgedCells: number;
    purgedRows: number;
  }> {
    const batchSize = options.batchSize ?? 1000;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      fail(
        "VALIDATION_FAILED",
        "History purge batches must contain 1–1000 events per section",
      );
    return this.run(
      a,
      async (c) => {
        await this.historyLease(c, a, tableId, options);
        const archive = await this.verifiedHistoryArchive(
          c,
          a,
          tableId,
          archiveId,
          options.jobId,
        );
        const manifest = archive.manifest as HistoryArchiveManifest;
        const gap = await c.query(
          "SELECT id FROM rootset_control.history_gaps WHERE org_id=$1 AND table_id=$2 AND manifest->>'archiveId'=$3",
          [a.orgId, tableId, archiveId],
        );
        if (!gap.rowCount)
          fail(
            "ARTIFACT_UNVERIFIED",
            "History cannot be purged before the verified archive is published",
            409,
          );
        let deletedCells = 0,
          deletedRows = 0;
        let remaining = false;
        for (const relation of ["cell_changes", "row_events"]) {
          const removed = await c.query(
            `WITH covered AS(SELECT e.id,e.changed_at FROM rootset_control.${relation} e WHERE e.org_id=$1 AND e.table_id=$2 AND e.changed_at>=$3::timestamptz AND e.changed_at<$4::timestamptz ORDER BY e.changed_at,e.id LIMIT $5 FOR UPDATE) DELETE FROM rootset_control.${relation} e USING covered v WHERE e.org_id=$1 AND e.table_id=$2 AND e.id=v.id AND e.changed_at=v.changed_at`,
            [a.orgId, tableId, manifest.from, manifest.to, batchSize],
          );
          if (relation === "cell_changes") deletedCells = removed.rowCount ?? 0;
          else deletedRows = removed.rowCount ?? 0;
          remaining ||= Boolean(
            (
              await c.query(
                `SELECT 1 FROM rootset_control.${relation} WHERE org_id=$1 AND table_id=$2 AND changed_at>=$3::timestamptz AND changed_at<$4::timestamptz LIMIT 1`,
                [a.orgId, tableId, manifest.from, manifest.to],
              )
            ).rowCount,
          );
        }
        const purgedCells = Number(archive.purged_cells) + deletedCells,
          purgedRows = Number(archive.purged_rows) + deletedRows;
        if (
          purgedCells > manifest.cellCount ||
          purgedRows > manifest.rowCount ||
          (!remaining &&
            (purgedCells !== manifest.cellCount ||
              purgedRows !== manifest.rowCount))
        )
          fail(
            "ARTIFACT_UNVERIFIED",
            "Purged history counts differ from the verified archive",
            409,
          );
        await c.query(
          "UPDATE rootset_control.history_archives SET purged_cells=$2,purged_rows=$3,state=$4,updated_at=now() WHERE id=$1",
          [
            archiveId,
            purgedCells,
            purgedRows,
            remaining ? "purging" : "succeeded",
          ],
        );
        return {
          done: !remaining,
          deletedCells,
          deletedRows,
          purgedCells,
          purgedRows,
        };
      },
      true,
    );
  }

  private async rules(c: PoolClient, t: TableRecord): Promise<UniqueRule[]> {
    const r = await c.query<Raw>(
      `SELECT * FROM rootset_control.unique_rules WHERE table_id=$1 AND state<>'deleted' ORDER BY id`,
      [t.id],
    );
    return r.rows.map((v) => ({
      id: String(v.id),
      tableId: t.id,
      name: String(v.name),
      fieldIds: v.field_ids as string[],
      strategy: v.strategy as UniqueRule["strategy"],
      state: String(v.state),
      physicalName: v.physical_name as string | null,
      ...(v.error ? { error: v.error as JsonValue } : {}),
    }));
  }
  async listUniqueRules(a: Actor, tableId: string): Promise<UniqueRule[]> {
    return this.run(a, async (c) =>
      this.rules(c, await this.table(c, a, tableId)),
    );
  }
  private nativeFits(fields: FieldDefinition[]): boolean {
    return (
      fields.reduce(
        (bytes, f) =>
          bytes +
          (f.type === "text"
            ? (f.charLimit ?? limits.textCharLimit) * 4 + 8
            : 24),
        64,
      ) <= 1000
    );
  }
  private tupleSql(fields: FieldDefinition[], prefix = ""): string {
    const values = fields.map(
      (f) =>
        `jsonb_build_array(${literal(f.type)},rootset_control.cell_value(to_jsonb(${prefix || "source_row"}),${literal(JSON.stringify(f))}::jsonb))`,
    );
    return `rootset_control.canonical_json(jsonb_build_array(${values.join(",")}))`;
  }
  private async buildRule(
    c: PoolClient,
    t: TableRecord,
    rule: UniqueRule,
  ): Promise<void> {
    const fields = rule.fieldIds.map((fid) => fieldFor(t, fid));
    const notNull = fields
      .map((f) => `${q(fieldColumn(f))} IS NOT NULL`)
      .join(" AND ");
    const tuple = this.tupleSql(fields);
    const nativeColumns = fields.map((f) => q(fieldColumn(f)));
    const duplicateSql =
      rule.strategy === "native"
        ? `WITH duplicates AS (SELECT ${nativeColumns.join(",")},count(*)::text AS count FROM ${tablePath(t)} WHERE ${notNull} GROUP BY ${nativeColumns.join(",")} HAVING count(*)>1 LIMIT 100) SELECT d.count,ARRAY(SELECT r.row_id FROM ${tablePath(t)} r WHERE ${nativeColumns.map((column) => `r.${column}=d.${column}`).join(" AND ")} ORDER BY r.row_id LIMIT 20) AS row_ids FROM duplicates d`
        : `SELECT ${tuple} COLLATE "C" AS tuple,count(*)::text AS count,(array_agg(row_id ORDER BY row_id))[1:20] AS row_ids FROM ${tablePath(t)} source_row WHERE ${notNull} GROUP BY ${tuple} COLLATE "C" HAVING count(*)>1 LIMIT 100`;
    const duplicates = await c.query<{
      count: string;
      row_ids: string[];
    }>(duplicateSql);
    if (duplicates.rows.length)
      fail(
        "UNIQUE_CONFLICT",
        "Existing rows conflict with this unique rule",
        409,
        {
          fieldIds: rule.fieldIds,
          conflicts: duplicates.rows.map((v) => ({
            count: Number(v.count),
            rowIds: v.row_ids,
          })),
          reportTruncated: duplicates.rows.length === 100,
        },
      );
    if (rule.strategy === "native") {
      await c.query(
        `CREATE UNIQUE INDEX ${q(rule.physicalName!)} ON ${tablePath(t)}(${fields.map((f) => q(fieldColumn(f))).join(",")})`,
      );
    } else {
      await c.query(
        `INSERT INTO rootset_control.unique_entries(rule_id,row_id,digest,tuple) SELECT $1,row_id,rootset_control.unique_digest(${tuple}),${tuple} FROM ${tablePath(t)} source_row WHERE ${notNull}`,
        [rule.id],
      );
      await c.query(
        "INSERT INTO rootset_control.unique_buckets(rule_id,digest) SELECT DISTINCT rule_id,digest FROM rootset_control.unique_entries WHERE rule_id=$1 ON CONFLICT DO NOTHING",
        [rule.id],
      );
    }
  }
  async createUniqueRule(
    a: Actor,
    tableId: string,
    input: { fieldIds: string[]; name?: string } & SchemaOptions,
  ): Promise<UniqueRule> {
    let ruleId = "";
    let outcome: UniqueRule | undefined;
    await this.schemaChange(
      a,
      tableId,
      "rule.create",
      input,
      async (c, t, operationId) => {
        const rules = await this.rules(c, t);
        const indexes = await this.indexes(c, t);
        if (
          rules.filter((r) => r.state === "active").length >=
          limits.maxUniqueRules
        )
          fail("VALIDATION_FAILED", "Unique rule budget exceeded");
        if (
          !input.fieldIds.length ||
          input.fieldIds.length > limits.maxUniqueFields ||
          new Set(input.fieldIds).size !== input.fieldIds.length
        )
          fail("VALIDATION_FAILED", "Rule requires 1–8 distinct scalar fields");
        const fields = input.fieldIds.map((fid) => fieldFor(t, fid));
        if (fields.some((f) => f.type === "json"))
          fail("VALIDATION_FAILED", "JSON uniqueness is outside v1");
        const strategy = this.nativeFits(fields) ? "native" : "registry";
        if (
          strategy === "native" &&
          indexes.filter((i) => i.state === "active").length +
            rules.filter((r) => r.state === "active" && r.strategy === "native")
              .length >=
            limits.maxIndexes
        )
          fail("VALIDATION_FAILED", "Secondary index budget exceeded");
        ruleId = newId();
        const r: UniqueRule = {
          id: ruleId,
          tableId: t.id,
          name: input.name ?? fields.map((f) => f.name).join(" + "),
          fieldIds: fields.map((f) => f.id),
          strategy,
          state: "building",
          physicalName:
            strategy === "native" ? `rsu_${ruleId.toLowerCase()}` : null,
        };
        await c.query(
          "INSERT INTO rootset_control.unique_rules(id,table_id,org_id,name,field_ids,strategy,physical_name) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [r.id, t.id, a.orgId, r.name, r.fieldIds, r.strategy, r.physicalName],
        );
        await this.buildRule(c, t, r);
        await c.query(
          "UPDATE rootset_control.unique_rules SET state='active' WHERE id=$1",
          [r.id],
        );
        outcome = { ...r, state: "active" };
        await c.query(
          "UPDATE rootset_control.schema_operations SET plan=plan||jsonb_build_object('ruleId',$2::text,'outcome',$3::jsonb) WHERE id=$1",
          [operationId, ruleId, JSON.stringify(outcome)],
        );
      },
      async (c, operationId) => {
        const saved = (
          await c.query<{ plan: Raw }>(
            "SELECT plan FROM rootset_control.schema_operations WHERE id=$1 AND org_id=$2",
            [operationId, a.orgId],
          )
        ).rows[0]?.plan;
        outcome = saved?.outcome as UniqueRule | undefined;
        if (
          !outcome ||
          outcome.id !== saved?.ruleId ||
          outcome.tableId !== id(tableId)
        )
          fail(
            "INTERNAL_ERROR",
            "The committed rule creation outcome is unavailable; an arbitrary matching rule cannot be replayed",
            500,
          );
      },
    );
    return (
      outcome ??
      fail("INTERNAL_ERROR", "Rule creation did not persist its outcome", 500)
    );
  }
  private async removeRule(
    c: PoolClient,
    t: TableRecord,
    r: Raw,
  ): Promise<void> {
    if (r.physical_name)
      await c.query(
        `DROP INDEX IF EXISTS ${q(t.schemaName)}.${q(String(r.physical_name))}`,
      );
    await c.query(
      "DELETE FROM rootset_control.unique_entries WHERE rule_id=$1",
      [r.id],
    );
    await c.query(
      "DELETE FROM rootset_control.unique_buckets WHERE rule_id=$1",
      [r.id],
    );
    await c.query(
      "UPDATE rootset_control.unique_rules SET state='deleted' WHERE id=$1",
      [r.id],
    );
  }
  async deleteUniqueRule(
    a: Actor,
    tableId: string,
    ruleId: string,
    input: SchemaOptions,
  ): Promise<TableRecord> {
    return this.schemaChange(
      a,
      tableId,
      "rule.delete",
      { ...input, ruleId: id(ruleId) },
      async (c, t) => {
        const r = await c.query<Raw>(
          "SELECT * FROM rootset_control.unique_rules WHERE id=$1 AND table_id=$2 AND state IN ('active','failed')",
          [id(ruleId), t.id],
        );
        if (!r.rows[0]) fail("RESOURCE_NOT_FOUND", "Rule was not found", 404);
        await this.removeRule(c, t, r.rows[0]);
      },
    );
  }
  private async indexes(c: PoolClient, t: TableRecord): Promise<IndexRecord[]> {
    return (
      await c.query<Raw>(
        `SELECT * FROM rootset_control.indexes WHERE table_id=$1 AND state<>'deleted' ORDER BY id`,
        [t.id],
      )
    ).rows.map((v) => ({
      id: String(v.id),
      tableId: t.id,
      fieldId: String(v.field_id),
      kind: v.kind as IndexRecord["kind"],
      state: String(v.state),
      physicalName: String(v.physical_name),
      ...(v.error ? { error: v.error as JsonValue } : {}),
    }));
  }
  async listIndexes(a: Actor, tableId: string): Promise<IndexRecord[]> {
    return this.run(a, async (c) =>
      this.indexes(c, await this.table(c, a, tableId)),
    );
  }
  async createIndex(
    a: Actor,
    tableId: string,
    input: {
      fieldId?: string;
      fieldIds?: string[];
      kind: "btree" | "trigram" | "json" | "jsonb";
    } & SchemaOptions,
  ): Promise<IndexRecord> {
    const kind = input.kind === "jsonb" ? "json" : input.kind;
    const fieldId =
      input.fieldId ??
      input.fieldIds?.[0] ??
      fail("VALIDATION_FAILED", "An index field is required");
    if (input.fieldIds && input.fieldIds.length !== 1)
      fail("VALIDATION_FAILED", "V1 secondary indexes address one field");
    let indexId = newId();
    let table!: TableRecord;
    const op = await this.run(
      a,
      async (c) => {
        await this.assertPublication(c, a, input.context, false);
        table = await this.table(c, a, tableId);
        await this.barrier(c, table.databaseId, true);
        table = await this.table(c, a, tableId, true);
        const j = await this.journal(
          c,
          a,
          table,
          table.databaseId,
          "index.create",
          input,
          input,
        );
        const saved = await c.query<{ plan: Raw }>(
          "SELECT plan FROM rootset_control.schema_operations WHERE id=$1",
          [j.operationId],
        );
        if (saved.rows[0]?.plan.indexId) {
          indexId = String(saved.rows[0].plan.indexId);
          if (!j.replay) {
            this.expected(table, input.expectedSchemaVersion);
            await c.query(
              "UPDATE rootset_control.indexes SET state='building',error=NULL WHERE id=$1",
              [indexId],
            );
            await c.query(
              "UPDATE rootset_control.schema_operations SET state='building',error=NULL WHERE id=$1",
              [j.operationId],
            );
          }
          return j;
        }
        if (j.replay) return j;
        this.expected(table, input.expectedSchemaVersion);
        const f = fieldFor(table, fieldId);
        if (
          (kind === "trigram" && f.type !== "text") ||
          (kind === "json" && f.type !== "json") ||
          (kind === "btree" && (f.type === "json" || !this.nativeFits([f])))
        )
          fail("VALIDATION_FAILED", "Index type/value width is unsupported");
        const rules = await this.rules(c, table);
        const indexes = await this.indexes(c, table);
        if (indexes.some((index) => index.state === "building"))
          fail(
            "SCHEMA_MAINTENANCE",
            "A secondary index build is already planned for this table",
            409,
          );
        if (
          indexes.filter((i) => i.state !== "deleted" && i.state !== "failed")
            .length +
            rules.filter((r) => r.strategy === "native" && r.state === "active")
              .length >=
          limits.maxIndexes
        )
          fail("VALIDATION_FAILED", "Secondary index budget exceeded");
        await c.query(
          "INSERT INTO rootset_control.indexes(id,table_id,org_id,field_id,kind,physical_name) VALUES($1,$2,$3,$4,$5,$6)",
          [
            indexId,
            table.id,
            a.orgId,
            f.id,
            kind,
            `rsi_${indexId.toLowerCase()}`,
          ],
        );
        await c.query(
          "UPDATE rootset_control.schema_operations SET plan=$2::jsonb,state=$3 WHERE id=$1",
          [
            j.operationId,
            JSON.stringify({
              indexId,
              physicalName: `rsi_${indexId.toLowerCase()}`,
              transactional: false,
              ...(input.context?.jobFence
                ? { jobId: input.context.jobFence.jobId }
                : {}),
            }),
            "building",
          ],
        );
        return j;
      },
      true,
    );
    if (op.replay)
      return (
        (await this.listIndexes(a, tableId)).find((i) => i.id === indexId) ??
        fail("RESOURCE_NOT_FOUND", "Index was not found", 404)
      );
    const f = fieldFor(table, fieldId);
    const connection = await this.ddlPool.connect();
    let buildAttempted = false;
    let operationLocked = false;
    try {
      {
        try {
          await connection.query(
            "SELECT set_config('rootset.org_id',$1,false)",
            [a.orgId],
          );
          await connection.query(
            "SELECT pg_advisory_lock_shared(hashtextextended($1,0))",
            [table.databaseId],
          );
          await connection.query("SET statement_timeout='0'");

          const lockDeadline = Date.now() + limits.queryTimeoutMs;
          while (!operationLocked) {
            const acquired = await connection.query<{ acquired: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1,4)) AS acquired",
              [op.operationId],
            );
            operationLocked = acquired.rows[0]!.acquired;
            if (!operationLocked) {
              if (Date.now() >= lockDeadline)
                fail(
                  "QUERY_TIMEOUT",
                  "Index operation lock exceeded its ten-second wait budget",
                  408,
                );
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          const using = kind === "btree" ? "btree" : "gin";
          const opclass = kind === "trigram" ? " gin_trgm_ops" : "";
          const present = await connection.query<{ indisvalid: boolean }>(
            "SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)",
            [`${q(table.schemaName)}.${q(`rsi_${indexId.toLowerCase()}`)}`],
          );
          if (!present.rows[0]?.indisvalid) {
            buildAttempted = true;
            if (present.rows[0])
              await connection.query(
                `DROP INDEX CONCURRENTLY ${q(table.schemaName)}.${q(`rsi_${indexId.toLowerCase()}`)}`,
              );
            await connection.query(
              `CREATE INDEX CONCURRENTLY ${q(`rsi_${indexId.toLowerCase()}`)} ON ${tablePath(table)} USING ${using}(${q(fieldColumn(f))}${opclass})`,
            );
          }
          await clientTransaction(connection, async (c) => {
            await this.assertPublication(c, a, input.context);
            await c.query(
              "SELECT id FROM rootset_control.tables WHERE id=$1 FOR UPDATE",
              [table.id],
            );
            const journal = await c.query<{ state: string }>(
              "SELECT state FROM rootset_control.schema_operations WHERE id=$1 FOR UPDATE",
              [op.operationId],
            );
            if (journal.rows[0]?.state === "committed") {
              return;
            }
            const r = await c.query<{ indisvalid: boolean }>(
              "SELECT indisvalid FROM pg_index WHERE indexrelid=$1::regclass",
              [`${q(table.schemaName)}.${q(`rsi_${indexId.toLowerCase()}`)}`],
            );
            if (!r.rows[0]?.indisvalid)
              fail("JOB_FAILED", "PostgreSQL did not validate the index");
            await c.query(
              "UPDATE rootset_control.indexes SET state='active' WHERE id=$1",
              [indexId],
            );
            await this.finish(c, op.operationId, table.id);
            await this.audit(
              c,
              a,
              table.databaseId,
              table.id,
              indexId,
              "index.create",
              null,
              { fieldId: f.id, kind },
              input.context,
            );
          });
        } catch (error) {
          if (!operationLocked) storageError(error);
          if (input.context?.jobFence) {
            const fence = input.context.jobFence;
            const owner = await connection.query(
              "SELECT id FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 AND lease_token=$3 AND (state<>'running' OR lease_until>clock_timestamp())",
              [fence.jobId, a.orgId, fence.leaseToken],
            );
            if (!owner.rowCount) storageError(error);
          }
          let cleanupCode: string | undefined;
          if (buildAttempted) {
            try {
              await connection.query(
                `DROP INDEX CONCURRENTLY IF EXISTS ${q(table.schemaName)}.${q(`rsi_${indexId.toLowerCase()}`)}`,
              );
            } catch (cleanupError) {
              cleanupCode = String(
                (cleanupError as { code?: string }).code ?? "UNKNOWN",
              );
            }
          }
          await clientTransaction(connection, async (c) => {
            await c.query(
              "SELECT id FROM rootset_control.tables WHERE id=$1 FOR UPDATE",
              [table.id],
            );
            await c.query(
              "SELECT id FROM rootset_control.schema_operations WHERE id=$1 FOR UPDATE",
              [op.operationId],
            );
            await c.query(
              "UPDATE rootset_control.indexes SET state='failed',error=NULL WHERE id=$1",
              [indexId],
            );
            await c.query(
              "UPDATE rootset_control.schema_operations SET state='failed',plan=jsonb_build_object('indexId',$3::text,'cleanupRequired',$4::boolean),error=$2::jsonb WHERE id=$1",
              [
                op.operationId,
                JSON.stringify({
                  code: cleanupCode
                    ? "INDEX_CLEANUP_FAILED"
                    : "INDEX_BUILD_FAILED",
                }),
                indexId,
                Boolean(cleanupCode),
              ],
            );
          });
          if (cleanupCode)
            fail(
              "INDEX_CLEANUP_FAILED",
              "Index build failed and its allocated index needs operator cleanup",
              503,
              { indexId, cleanupRequired: true, postgresCode: cleanupCode },
            );
          storageError(error);
        }
      }
    } catch (error) {
      storageError(error);
    } finally {
      if (operationLocked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,4))", [
            op.operationId,
          ])
          .catch(() => undefined);
      await connection
        .query("SELECT pg_advisory_unlock_shared(hashtextextended($1,0))", [
          table.databaseId,
        ])
        .catch(() => undefined);
      await connection
        .query("RESET rootset.org_id; RESET statement_timeout")
        .catch(() => undefined);
      connection.release();
    }
    return (await this.listIndexes(a, tableId)).find((i) => i.id === indexId)!;
  }
  private async removeIndex(
    c: PoolClient,
    t: TableRecord,
    r: Raw,
  ): Promise<void> {
    await c.query(
      `DROP INDEX IF EXISTS ${q(t.schemaName)}.${q(String(r.physical_name))}`,
    );
    await c.query(
      "UPDATE rootset_control.indexes SET state='deleted' WHERE id=$1",
      [r.id],
    );
  }
  async deleteIndex(
    a: Actor,
    tableId: string,
    indexId: string,
    input: SchemaOptions,
  ): Promise<TableRecord> {
    return this.schemaChange(
      a,
      tableId,
      "index.delete",
      { ...input, indexId: id(indexId) },
      async (c, t) => {
        const r = await c.query<Raw>(
          "SELECT * FROM rootset_control.indexes WHERE id=$1 AND table_id=$2 AND state IN ('active','failed')",
          [id(indexId), t.id],
        );
        if (!r.rows[0]) fail("RESOURCE_NOT_FOUND", "Index was not found", 404);
        await this.removeIndex(c, t, r.rows[0]);
      },
    );
  }
  private async convertField(
    a: Actor,
    tableId: string,
    fieldId: string,
    input: Partial<FieldInput> &
      SchemaOptions & {
        conversion?: { strategy: "strict" | "stringify" | "parse" };
      },
  ): Promise<TableRecord> {
    if (!input.conversion)
      fail(
        "VALIDATION_FAILED",
        "A populated type change requires an explicit conversion plan",
      );
    let old!: TableRecord;
    let fresh!: TableRecord;
    let operationId = "";
    const strategy = input.conversion.strategy;
    const conversionContext = context({ ...input.context, source: "schema" });
    await this.run(
      a,
      async (c) => {
        await this.assertPublication(c, a, input.context, false);
        old = await this.table(c, a, tableId);
        await this.barrier(c, old.databaseId);
        old = await this.table(c, a, tableId, true);
        this.expected(old, input.expectedSchemaVersion);
        const previous = fieldFor(old, fieldId);
        const dependencies = await c.query<Raw>(
          "SELECT id FROM rootset_control.unique_rules WHERE table_id=$1 AND $2=ANY(field_ids) AND state='active' UNION SELECT id FROM rootset_control.indexes WHERE table_id=$1 AND field_id=$2 AND state='active'",
          [old.id, previous.id],
        );
        if (dependencies.rows.length)
          fail(
            "VALIDATION_FAILED",
            "Remove affected rules/indexes before conversion",
          );
        const changes = fieldPatch(input);
        const next = changedField(previous, changes);
        fresh = {
          ...old,
          physicalName: `rst_${old.id.toLowerCase()}_g${old.generation + 1}`,
          generation: old.generation + 1,
          fields: old.fields.map((f) => (f.id === next.id ? next : f)),
        };
        assertFieldNames(fresh.fields);
        const j = await this.journal(
          c,
          a,
          old,
          old.databaseId,
          "field.convert",
          { ...input, fieldId: previous.id },
          input,
        );
        operationId = j.operationId;
        if (j.replay) return;
        await this.createPhysical(c, fresh, false);
        await c.query(
          "UPDATE rootset_control.tables SET state='maintenance' WHERE id=$1",
          [old.id],
        );
        await c.query(
          "UPDATE rootset_control.schema_operations SET state='staging',plan=$2::jsonb WHERE id=$1",
          [
            operationId,
            JSON.stringify({
              shadow: fresh.physicalName,
              fieldId,
              nextField: next,
              ...(input.context?.jobFence
                ? { jobId: input.context.jobFence.jobId }
                : {}),
            }),
          ],
        );
      },
      true,
    );
    try {
      await this.run(
        a,
        async (c) => {
          await c.query("SET LOCAL statement_timeout='0'");
          await this.barrier(c, old.databaseId);
          const before = fieldFor(old, fieldId),
            after = fieldFor(fresh, fieldId);
          for await (const rows of this.iterateRows(c, old)) {
            await this.assertPublication(c, a, input.context, false);
            for (const row of rows) {
              const value = row.values[before.name]!;
              const values = {
                ...renamedValues(row.values, before, after),
                [after.name]: convertedCell(before, after, strategy, value),
              };
              assertRowBytes(fresh.fields, values);
              const changed =
                canonicalJson(value) !== canonicalJson(values[after.name]);
              const columns = fresh.fields.map((f) => q(fieldColumn(f)));
              await c.query(
                `INSERT INTO ${tablePath(fresh)}(row_id,org_id,row_version,created_at,updated_at${columns.length ? "," + columns.join(",") : ""}) VALUES($1,$2,$3,$4,$5${fresh.fields.map((_, i) => `,$${i + 6}`).join("")})`,
                [
                  row.id,
                  a.orgId,
                  changed ? (BigInt(row.version) + 1n).toString() : row.version,
                  row.createdAt,
                  changed ? new Date().toISOString() : row.updatedAt,
                  ...fresh.fields.map((f) => parameter(f, values[f.name]!)),
                ],
              );
            }
          }
          await c.query(
            "UPDATE rootset_control.schema_operations SET state='staged' WHERE id=$1",
            [operationId],
          );
        },
        true,
      );
      await this.run(
        a,
        async (c) => {
          await c.query("SET LOCAL statement_timeout='0'");
          await this.barrier(c, old.databaseId);
          await this.assertPublication(c, a, input.context, false);
          const t = await this.table(c, a, old.id, true);
          if (t.physicalName !== old.physicalName)
            fail(
              "SCHEMA_VERSION_CONFLICT",
              "Conversion source generation changed",
              409,
            );
          const after = fieldFor(fresh, fieldId);
          for (const rule of await this.rules(c, old)) {
            if (rule.state !== "active" || rule.strategy !== "native") continue;
            const physicalName = `rsu_${rule.id.toLowerCase()}_g${fresh.generation}`;
            const columns = rule.fieldIds.map((fid) =>
              q(fieldColumn(fieldFor(fresh, fid))),
            );
            await c.query(
              `CREATE UNIQUE INDEX ${q(physicalName)} ON ${tablePath(fresh)}(${columns.join(",")})`,
            );
            await c.query(
              "UPDATE rootset_control.unique_rules SET physical_name=$2 WHERE id=$1",
              [rule.id, physicalName],
            );
          }
          for (const index of await this.indexes(c, old)) {
            if (index.state !== "active") continue;
            const physicalName = `rsi_${index.id.toLowerCase()}_g${fresh.generation}`;
            const column = q(fieldColumn(fieldFor(fresh, index.fieldId)));
            await c.query(
              `CREATE INDEX ${q(physicalName)} ON ${tablePath(fresh)} USING ${index.kind === "btree" ? "btree" : "gin"}(${column}${index.kind === "trigram" ? " gin_trgm_ops" : ""})`,
            );
            await c.query(
              "UPDATE rootset_control.indexes SET physical_name=$2 WHERE id=$1",
              [index.id, physicalName],
            );
          }
          const m = await this.newMutation(
            c,
            a,
            t,
            { conversionOperation: operationId },
            `conversion:${operationId}`,
            conversionContext,
          );
          const before = fieldFor(old, fieldId);
          const oldCell = `rootset_control.cell_value(to_jsonb(o),${literal(JSON.stringify(before))}::jsonb)`;
          const newCell = `rootset_control.cell_value(to_jsonb(n),${literal(JSON.stringify(after))}::jsonb)`;
          await c.query(
            `INSERT INTO rootset_control.cell_changes(org_id,database_id,table_id,row_id,field_id,mutation_id,old_value,new_value,field_definition,old_version,new_version,operation,actor,context) SELECT $1,$2,$3,o.row_id,$4,$5,${oldCell},${newCell},$6::jsonb,o.row_version,n.row_version,'conversion',$7::jsonb,$8::jsonb FROM ${tablePath(old)} o JOIN ${tablePath(fresh)} n ON n.row_id=o.row_id WHERE ${oldCell} IS DISTINCT FROM ${newCell}`,
            [
              a.orgId,
              t.databaseId,
              t.id,
              after.id,
              m.id,
              JSON.stringify(after),
              JSON.stringify(a),
              JSON.stringify(conversionContext),
            ],
          );
          await c.query(
            "UPDATE rootset_control.fields SET definition=$2::jsonb,name=$3 WHERE id=$1",
            [after.id, JSON.stringify(after), after.name],
          );
          await this.installTrigger(c, fresh);
          await this.assertPublication(c, a, input.context);
          await c.query(
            "UPDATE rootset_control.tables SET physical_name=$2,generation=$3,state='active' WHERE id=$1",
            [old.id, fresh.physicalName, fresh.generation],
          );
          await this.finish(c, operationId, old.id);
          await this.audit(
            c,
            a,
            old.databaseId,
            old.id,
            after.id,
            "field.convert",
            before,
            after,
            conversionContext,
          );
          await c.query(
            "UPDATE rootset_control.mutations SET outcome=$2::jsonb WHERE id=$1",
            [m.id, JSON.stringify({ operationId })],
          );
        },
        true,
      );
      return this.getTable(a, tableId);
    } catch (error) {
      await this.run(
        a,
        async (c) => {
          if (input.context?.jobFence) {
            const fence = input.context.jobFence;
            const current = await c.query(
              "SELECT id FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 AND lease_token=$3 AND (state<>'running' OR lease_until>clock_timestamp()) FOR UPDATE",
              [fence.jobId, a.orgId, fence.leaseToken],
            );
            if (!current.rowCount) return;
          }
          await this.barrier(c, old.databaseId);
          const live = await this.table(c, a, old.id, true);
          if (live.physicalName === old.physicalName) {
            await c.query(`DROP TABLE IF EXISTS ${tablePath(fresh)}`);
            await c.query(
              "UPDATE rootset_control.tables SET state='active' WHERE id=$1",
              [old.id],
            );
            await c.query(
              "UPDATE rootset_control.schema_operations SET state='failed',error=$2::jsonb WHERE id=$1",
              [operationId, JSON.stringify({ code: "CONVERSION_FAILED" })],
            );
          }
        },
        true,
      );
      throw error;
    }
  }
  async previewSchemaChange(
    a: Actor,
    tableId: string,
    input: { expectedSchemaVersion: number; change: unknown },
  ): Promise<{
    valid: boolean;
    requiresJob: boolean;
    rowCount: number;
    conflicts: {
      rowId: string;
      fieldId?: string;
      code: string;
      message: string;
    }[];
  }> {
    return this.run(a, async (c) => {
      const t = await this.table(c, a, tableId);
      this.expected(t, input.expectedSchemaVersion);
      await c.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
        [t.databaseId],
      );
      if (
        !input.change ||
        typeof input.change !== "object" ||
        Array.isArray(input.change)
      )
        fail("VALIDATION_FAILED", "Invalid schema change");
      const change = input.change as Raw;
      let fields = [...t.fields];
      let transform = (r: Row): Record<string, JsonValue> => r.values;
      let fieldId: string | undefined;
      let converts = false;
      if (change.kind === "add_field") {
        if (t.fields.length >= limits.maxFields)
          fail("VALIDATION_FAILED", "Field limit exceeded");
        const f = field(change.field as FieldInput);
        fields.push(f);
        fieldId = f.id;
        transform = (r) => ({
          ...r.values,
          [f.name]: Object.hasOwn(f, "default") ? f.default! : null,
        });
      } else if (change.kind === "update_field") {
        const before = fieldFor(t, String(change.fieldId));
        const patch = change.changes as Partial<FieldInput>;
        const after = changedField(before, patch);
        fields = fields.map((f) => (f.id === before.id ? after : f));
        transform = (r) => renamedValues(r.values, before, after);
        fieldId = before.id;
        converts = after.type !== before.type;
        if (converts) {
          if (!change.conversion)
            fail(
              "VALIDATION_FAILED",
              "An explicit conversion plan is required",
            );
          const strategy =
            change.conversion === "lossless"
              ? "strict"
              : after.type === "text"
                ? "stringify"
                : "parse";
          transform = (r) => ({
            ...renamedValues(r.values, before, after),
            [after.name]: convertedCell(
              before,
              after,
              strategy,
              r.values[before.name]!,
            ),
          });
        }
      } else if (change.kind === "delete_field") {
        const before = fieldFor(t, String(change.fieldId));
        fieldId = before.id;
        const deps = await c.query<Raw>(
          "SELECT id FROM rootset_control.unique_rules WHERE table_id=$1 AND $2=ANY(field_ids) AND state='active' UNION SELECT id FROM rootset_control.indexes WHERE table_id=$1 AND field_id=$2 AND state='active'",
          [t.id, before.id],
        );
        if (deps.rows.length && !change.removeDependencies)
          fail(
            "VALIDATION_FAILED",
            "Field has dependencies requiring explicit removal",
          );
        fields = fields.filter((f) => f.id !== before.id);
        transform = (r) =>
          Object.fromEntries(
            Object.entries(r.values).filter(([key]) => key !== before.name),
          );
      } else if (change.kind === "reorder_fields") {
        const ids = change.fieldIds as string[];
        if (
          !Array.isArray(ids) ||
          ids.length !== t.fields.length ||
          new Set(ids).size !== ids.length ||
          ids.some((fid) => !t.fields.some((f) => f.id === fid))
        )
          fail("VALIDATION_FAILED", "Every active field must be provided once");
      } else fail("VALIDATION_FAILED", "Unsupported schema change");
      assertFieldNames(fields);
      const conflicts: {
        rowId: string;
        fieldId?: string;
        code: string;
        message: string;
      }[] = [];
      for await (const batch of this.iterateRows(c, t))
        for (const r of batch) {
          try {
            assertRowBytes(fields, validateValues(fields, transform(r)));
          } catch (error) {
            if (conflicts.length < 1000)
              conflicts.push({
                rowId: r.id,
                fieldId,
                code:
                  error instanceof RootsetError
                    ? error.code
                    : "VALIDATION_FAILED",
                message:
                  error instanceof RootsetError
                    ? error.message
                    : "Existing value is incompatible",
              });
          }
        }
      return {
        valid: !conflicts.length,
        requiresJob: t.rowCount > 10000 || (converts && t.rowCount > 0),
        rowCount: t.rowCount,
        conflicts,
      };
    });
  }
  async getSchemaOperation(a: Actor, operationId: string): Promise<Raw> {
    return this.run(a, async (c) => {
      const r = await c.query<Raw>(
        "SELECT * FROM rootset_control.schema_operations WHERE id=$1 AND org_id=$2",
        [id(operationId), a.orgId],
      );
      return (
        r.rows[0] ??
        fail("RESOURCE_NOT_FOUND", "Schema operation was not found", 404)
      );
    });
  }
  async reconcileSchemaOperations(a: Actor): Promise<{ recovered: string[] }> {
    return this.run(
      a,
      async (c) => {
        const rows = await c.query<Raw>(
          "SELECT * FROM rootset_control.schema_operations WHERE org_id=$1 AND state NOT IN ('committed','failed','historical') FOR UPDATE",
          [a.orgId],
        );
        const recovered: string[] = [];
        for (const op of rows.rows) {
          const planJob = (op.plan as Raw)?.jobId;
          if (
            planJob &&
            (
              await c.query(
                "SELECT id FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 AND state='running' AND lease_until>clock_timestamp() AND NOT cancel_requested",
                [planJob, a.orgId],
              )
            ).rowCount
          )
            continue;
          await this.barrier(
            c,
            String(op.database_id),
            op.kind === "index.create",
          );
          const plan = op.plan as Raw;
          if (op.kind === "field.convert" && op.table_id) {
            const t = await this.table(c, a, String(op.table_id), true);
            if (t.physicalName === plan.shadow) {
              await c.query(
                "UPDATE rootset_control.schema_operations SET state='committed',committed_at=coalesce(committed_at,now()) WHERE id=$1",
                [op.id],
              );
            } else {
              if (
                typeof plan.shadow === "string" &&
                /^rst_[a-z0-9]{26}_g[0-9]+$/.test(plan.shadow)
              )
                await c.query(
                  `DROP TABLE IF EXISTS ${q(t.schemaName)}.${q(plan.shadow)}`,
                );
              await c.query(
                "UPDATE rootset_control.tables SET state='active' WHERE id=$1",
                [t.id],
              );
              await c.query(
                "UPDATE rootset_control.schema_operations SET state='failed',error=$2::jsonb WHERE id=$1",
                [
                  op.id,
                  JSON.stringify({
                    code: "RECOVERED_PRE_CUTOVER",
                    retryable: true,
                  }),
                ],
              );
            }
          } else if (op.kind === "index.create" && op.table_id) {
            const t = await this.table(c, a, String(op.table_id));
            const r = await c.query<{ indisvalid: boolean }>(
              "SELECT i.indisvalid FROM pg_index i JOIN pg_class cls ON cls.oid=i.indexrelid JOIN pg_namespace ns ON ns.oid=cls.relnamespace WHERE ns.nspname=$1 AND cls.relname=$2",
              [t.schemaName, plan.physicalName],
            );
            if (r.rows[0]?.indisvalid && !planJob) {
              await c.query(
                "UPDATE rootset_control.indexes SET state='active' WHERE id=$1",
                [plan.indexId],
              );
              await this.finish(c, String(op.id), t.id);
            } else {
              await c.query(
                `DROP INDEX IF EXISTS ${q(t.schemaName)}.${q(String(plan.physicalName))}`,
              );
              const recoveryError = JSON.stringify({
                code: planJob
                  ? "INTERRUPTED_JOB_REQUIRES_RETRY"
                  : "INVALID_INDEX_RECOVERED",
                retryable: true,
              });
              await c.query(
                "UPDATE rootset_control.indexes SET state='failed',error=$2::jsonb WHERE id=$1",
                [plan.indexId, recoveryError],
              );
              await c.query(
                "UPDATE rootset_control.schema_operations SET state='failed',error=$2::jsonb WHERE id=$1",
                [op.id, recoveryError],
              );
            }
          } else
            await c.query(
              "UPDATE rootset_control.schema_operations SET state='failed',error=$2::jsonb WHERE id=$1",
              [op.id, JSON.stringify({ code: "TRANSACTION_ROLLED_BACK" })],
            );
          recovered.push(String(op.id));
        }
        return { recovered };
      },
      true,
    );
  }
  async snapshotTable(
    a: Actor,
    tableId: string,
    input: QuerySpec,
    c: PoolClient,
  ): Promise<{ table: TableRecord; rows: AsyncIterable<Row[]> }> {
    const t = await this.table(c, a, tableId);
    await c.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
      [t.databaseId],
    );
    const compiled = compileQuery(t.fields, { ...input, cursor: undefined });
    async function* iterate(): AsyncGenerator<Row[]> {
      let tuple: JsonValue[] | null = null;
      for (;;) {
        const params = [...compiled.params];
        let where = compiled.where;
        if (tuple) {
          const keyset = compileKeyset(
            compiled.sorts,
            tuple,
            params.length + 1,
          );
          params.push(...keyset.params);
          where = `(${where}) AND (${keyset.where})`;
        }
        const r = await c.query<Raw>(
          `SELECT * FROM ${tablePath(t)} WHERE ${where} ORDER BY ${compiled.orderBy} LIMIT 1000`,
          params,
        );
        if (!r.rows.length) return;
        const full = r.rows.map((raw) => rowFrom(raw, t.fields));
        yield r.rows.map((raw) => rowFrom(raw, compiled.projection));
        const tail = full.at(-1)!;
        tuple = compiled.sorts.map((s) =>
          s.fieldId ? (tail.values[s.name!] ?? null) : tail.id,
        );
      }
    }
    return { table: t, rows: iterate() };
  }

  async queryWindow(
    a: Actor,
    tableId: string,
    input: {
      query?: QuerySpec;
      position?: "first" | "middle" | "last" | number;
      sessionId?: string;
    } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    result: QueryResult;
    sessionId: string;
    position: number;
    totalRows: number | null;
    tableRowCount: number;
    countKind: "live" | "exact" | "unknown";
    anchorsReady: boolean;
  }> {
    return this.read(
      a,
      async (c) => {
        const t = await this.table(c, a, tableId);
        const query = {
          ...input.query,
          limit: Math.min(
            input.query?.limit ?? limits.uiDefaultRows,
            limits.uiDefaultRows,
          ),
          cursor: undefined,
        };
        const compiled = compileQuery(t.fields, query);
        const grantHash = hash({
          actor: a.id,
          membershipVersion: a.membershipVersion ?? 0,
          role: a.role,
        });
        const anchorHash = hash({
          where: compiled.where,
          params: compiled.params,
          sorts: compiled.sorts,
        });
        let sessionId = input.sessionId,
          anchors: Record<string, JsonValue[]> = {};
        if (sessionId) {
          const old = await c.query<Raw>(
            "SELECT * FROM rootset_control.query_sessions WHERE id=$1 AND org_id=$2 AND table_id=$3 AND expires_at>now()",
            [id(sessionId), a.orgId, t.id],
          );
          const s = old.rows[0];
          if (
            !s ||
            Number(s.schema_version) !== t.schemaVersion ||
            s.query_hash !== anchorHash ||
            s.grant_hash !== grantHash
          )
            fail(
              "CURSOR_INVALID",
              "Window session expired or schema/query/authority changed",
              409,
            );
          anchors = s.anchors as Record<string, JsonValue[]>;
        } else {
          sessionId = newId();
          await c.query(
            "INSERT INTO rootset_control.query_sessions(id,org_id,table_id,schema_version,query_hash,grant_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour')",
            [sessionId, a.orgId, t.id, t.schemaVersion, anchorHash, grantHash],
          );
        }
        const position =
          input.position === 0 ? "first" : (input.position ?? "first");
        if (
          typeof position === "number" &&
          (!Number.isSafeInteger(position) || position < 0)
        )
          fail(
            "VALIDATION_FAILED",
            "Window position must be a nonnegative integer",
          );
        let totalRows: number | null = query.where
          ? ((anchors.__count?.[0] as number) ?? null)
          : t.rowCount;
        let desired =
          position === "first"
            ? 0
            : position === "middle"
              ? Math.floor((totalRows ?? t.rowCount) / 2)
              : position === "last"
                ? Math.max(0, (totalRows ?? t.rowCount) - compiled.limit)
                : Math.max(
                    0,
                    Math.min(
                      Math.floor(position),
                      Math.max(0, (totalRows ?? t.rowCount) - 1),
                    ),
                  );
        if (
          (desired > 0 ||
            ((position === "middle" || position === "last") &&
              totalRows === null)) &&
          !Object.keys(anchors).length
        ) {
          const cols = compiled.sorts.map((s) => q(s.column));
          const r = await c.query<Raw>(
            `WITH ranked AS (SELECT row_number() OVER(ORDER BY ${compiled.orderBy})-1 AS rank${query.where ? ",count(*) OVER() AS matching_count" : ""},${cols.join(",")} FROM ${tablePath(t)} WHERE ${compiled.where}) SELECT * FROM ranked WHERE rank%10000=0 ORDER BY rank`,
            compiled.params,
          );
          for (const raw of r.rows) {
            const whole = rowFrom(raw, t.fields);
            anchors[String(raw.rank)] = compiled.sorts.map((s) =>
              s.fieldId ? (whole.values[s.name!] ?? null) : String(raw.row_id),
            );
          }
          anchors.__count = [
            query.where ? Number(r.rows[0]?.matching_count ?? 0) : t.rowCount,
          ];
          totalRows = Number(anchors.__count[0]);
          desired =
            position === "middle"
              ? Math.floor(totalRows / 2)
              : position === "last"
                ? Math.max(0, totalRows - compiled.limit)
                : typeof position === "number"
                  ? Math.min(position, Math.max(0, totalRows - 1))
                  : 0;
          await c.query(
            "UPDATE rootset_control.query_sessions SET anchors=$2::jsonb WHERE id=$1",
            [sessionId, JSON.stringify(anchors)],
          );
        }
        const rank = Math.max(
          0,
          ...Object.keys(anchors)
            .map(Number)
            .filter((n) => n <= desired),
        );
        let where = compiled.where;
        const params = [...compiled.params];
        if (rank > 0 && anchors[String(rank)]) {
          const keyset = compileKeyset(
            compiled.sorts,
            anchors[String(rank)]!,
            params.length + 1,
          );
          where = `(${where}) AND ((${keyset.where}) OR ${q("row_id")}=$${params.length + keyset.params.length}::text)`;
          params.push(...keyset.params);
        }
        const localOffset = Math.max(0, desired - rank);
        if (localOffset >= 10000)
          fail("QUERY_TIMEOUT", "Window anchors need refreshing");
        params.push(compiled.limit + 1, localOffset);
        const needed = new Map(compiled.projection.map((f) => [f.id, f]));
        for (const sort of compiled.sorts)
          if (sort.fieldId) needed.set(sort.fieldId, fieldFor(t, sort.fieldId));
        const raw = await c.query<Raw>(
          `SELECT row_id,row_version,created_at,updated_at${needed.size ? "," + [...needed.values()].map((f) => q(fieldColumn(f))).join(",") : ""} FROM ${tablePath(t)} WHERE ${where} ORDER BY ${compiled.orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        const binding = {
          orgId: a.orgId,
          tableId: t.id,
          schemaVersion: t.schemaVersion,
          membershipVersion: a.membershipVersion ?? 0,
          actorId: a.id,
          queryHash: compiled.queryHash,
        };
        const full = new Map(
          raw.rows.map((v) => [
            String(v.row_id),
            rowFrom(v, [...needed.values()]),
          ]),
        );
        const page = buildPage(
          raw.rows.map((v) => rowFrom(v, compiled.projection)),
          {
            limit: compiled.limit,
            byteLimit: limits.restResultBytes - 512,
            schemaVersion: t.schemaVersion,
            cursorForRow: (r) =>
              this.cursor.encode(
                binding,
                compiled.sorts.map((s) =>
                  s.fieldId ? (full.get(r.id)!.values[s.name!] ?? null) : r.id,
                ),
              ),
          },
        );
        return {
          result: page,
          sessionId,
          position: desired,
          totalRows,
          tableRowCount: t.rowCount,
          countKind: query.where
            ? totalRows === null
              ? "unknown"
              : "exact"
            : "live",
          anchorsReady: Object.keys(anchors).length > 0,
        };
      },
      options.signal,
    );
  }
}
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface HistoryArchiveManifest {
  formatVersion: 1;
  archiveId: string;
  orgId: string;
  databaseId: string;
  tableId: string;
  from: string;
  to: string;
  snapshotAt: string;
  cellCount: number;
  rowCount: number;
  artifactId: string;
  checksum: string;
  byteLength: number;
  fingerprint: string;
  interpretations: unknown[];
  verifiedAt: string;
}
