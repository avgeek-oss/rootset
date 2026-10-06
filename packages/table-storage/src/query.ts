import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalJson,
  IdSchema,
  limits,
  RootsetError,
  validateCell,
  validateQuery,
  type FieldDefinition,
  type FieldType,
  type FilterNode,
  type JsonValue,
  type QueryResult,
  type QuerySpec,
  type Row,
} from "@rootset/contracts";

export interface ResolvedSort {
  fieldId: string | null;
  name: string | null;
  column: string;
  type: FieldType | "row_id";
  direction: "asc" | "desc";
}

export interface CompiledQuery {
  where: string;
  params: unknown[];
  orderBy: string;
  projection: FieldDefinition[];
  sorts: ResolvedSort[];
  limit: number;
  queryHash: string;
}

function invalid(message: string): never {
  throw new RootsetError("VALIDATION_FAILED", message, 422);
}

export function fieldColumn(field: Pick<FieldDefinition, "id">): string {
  const id = IdSchema.safeParse(field.id);
  if (!id.success) invalid("Field metadata contains an invalid identifier");
  return `f_${id.data.toLowerCase()}`;
}

function quoteColumn(column: string): string {
  if (column !== "row_id" && !/^f_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(column)) {
    invalid("Query column is not a generated storage identifier");
  }
  return `"${column}"`;
}

function bindValue(field: FieldDefinition, value: unknown): JsonValue {
  // Filter values may lie outside a field's configured population bounds.
  const unbounded: FieldDefinition = {
    id: field.id,
    name: field.name,
    type: field.type,
    ...(field.type === "text" ? { charLimit: limits.rowBytes } : {}),
  };
  const typed = validateCell(unbounded, value);
  if (typed === null)
    invalid("Use isNull or isNotNull to compare nullable cells");
  return typed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function compileQuery(
  fields: readonly FieldDefinition[],
  input: QuerySpec,
): CompiledQuery {
  const spec = validateQuery(input, fields);
  const byName = new Map<string, FieldDefinition>();
  const generated = new Set<string>();
  for (const field of fields) {
    const column = fieldColumn(field);
    if (generated.has(column))
      invalid("Field metadata contains duplicate identifiers");
    generated.add(column);
    for (const key of [field.id, field.name]) {
      if (byName.has(key) && byName.get(key) !== field)
        invalid("Field metadata contains ambiguous names");
      byName.set(key, field);
    }
  }
  function resolve(name: string): FieldDefinition {
    const field = byName.get(name);
    if (!field) invalid(`Unknown field ${name}`);
    return field;
  }

  const params: unknown[] = [];
  const parameter = (value: unknown, cast = ""): string => {
    params.push(value);
    return `$${params.length}${cast}`;
  };

  function filter(node: FilterNode): string {
    if ("and" in node) return `(${node.and.map(filter).join(" AND ")})`;
    if ("or" in node) return `(${node.or.map(filter).join(" OR ")})`;
    const field = resolve(node.field);
    const column = quoteColumn(fieldColumn(field));
    switch (node.op) {
      case "isNull":
        return `${column} IS NULL`;
      case "isNotNull":
        return `${column} IS NOT NULL`;
      case "pathExists":
        return `(${column} #> ${parameter((node.path ?? []).map(String), "::text[]")}) IS NOT NULL`;
      case "pathEq":
        return `(${column} #> ${parameter((node.path ?? []).map(String), "::text[]")}) = ${parameter(canonicalJson(node.value), "::jsonb")}`;
      case "jsonContains":
        return `${column} @> ${parameter(canonicalJson(node.value), "::jsonb")}`;
      case "prefix":
      case "contains":
      case "iContains": {
        const text = bindValue(field, node.value);
        if (typeof text !== "string") invalid("Text predicates require text");
        const escaped = escapeLike(text);
        const pattern = node.op === "prefix" ? `${escaped}%` : `%${escaped}%`;
        return `${column} ${node.op === "iContains" ? "ILIKE" : "LIKE"} ${parameter(pattern)} ESCAPE E'\\\\'`;
      }
      case "between": {
        const bounds = node.value;
        if (!Array.isArray(bounds) || bounds.length !== 2)
          invalid("between requires exactly two values");
        return `${column} BETWEEN ${parameter(bindValue(field, bounds[0]))} AND ${parameter(bindValue(field, bounds[1]))}`;
      }
      case "in": {
        const values = node.value;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.length > limits.queryPredicates
        )
          invalid("in requires one to 100 values");
        return `${column} IN (${values.map((value) => parameter(bindValue(field, value))).join(", ")})`;
      }
      default: {
        const operators = {
          eq: "=",
          ne: "<>",
          lt: "<",
          lte: "<=",
          gt: ">",
          gte: ">=",
        };
        const operator = operators[node.op];
        if (!operator) invalid("Unsupported query operator");
        return `${column} ${operator} ${parameter(bindValue(field, node.value))}`;
      }
    }
  }

  const projection =
    spec.select === undefined ? [...fields] : spec.select.map(resolve);
  if (new Set(projection.map((field) => field.id)).size !== projection.length)
    invalid("Projection repeats a field");
  const sorts: ResolvedSort[] = (spec.orderBy ?? []).map((sort) => {
    const field = resolve(sort.field);
    return {
      fieldId: field.id,
      name: field.name,
      column: fieldColumn(field),
      type: field.type,
      direction: sort.direction,
    };
  });
  if (new Set(sorts.map((sort) => sort.column)).size !== sorts.length)
    invalid("Sorting repeats a field");
  sorts.push({
    fieldId: null,
    name: null,
    column: "row_id",
    type: "row_id",
    direction: "asc",
  });
  const where = spec.where ? filter(spec.where) : "TRUE";
  const orderBy = sorts
    .map(
      (sort) =>
        `${quoteColumn(sort.column)} ${sort.direction.toUpperCase()} NULLS LAST`,
    )
    .join(", ");
  const queryHash = createHash("sha256")
    .update(
      canonicalJson(
        {
          where,
          params,
          projection: projection.map((field) => field.id),
          sorts,
        },
        { maxDepth: 96 },
      ),
    )
    .digest("hex");
  return {
    where,
    params,
    orderBy,
    projection,
    sorts,
    limit: spec.limit ?? limits.restDefaultRows,
    queryHash,
  };
}

function sortValue(sort: ResolvedSort, value: unknown): unknown {
  if (sort.type === "row_id") {
    const id = IdSchema.safeParse(value);
    if (!id.success) invalid("Cursor row identifier is invalid");
    return id.data;
  }
  if (value === null) return null;
  const typed = bindValue(
    {
      id: sort.fieldId!,
      name: sort.name!,
      type: sort.type,
    },
    value,
  );
  return sort.type === "json" ? canonicalJson(typed) : typed;
}

function sortCast(sort: ResolvedSort): string {
  switch (sort.type) {
    case "integer":
      return "::bigint";
    case "float":
      return "::double precision";
    case "boolean":
      return "::boolean";
    case "date":
      return "::date";
    case "time":
      return "::time";
    case "date-time":
      return "::timestamptz";
    case "json":
      return "::jsonb";
    default:
      return "::text";
  }
}

export function compileKeyset(
  sorts: readonly ResolvedSort[],
  lastTuple: readonly JsonValue[],
  firstParameter = 1,
): { where: string; params: unknown[] } {
  if (!Number.isSafeInteger(firstParameter) || firstParameter < 1)
    invalid("Invalid parameter offset");
  if (
    sorts.length === 0 ||
    sorts.length > limits.querySorts + 1 ||
    sorts.at(-1)?.type !== "row_id" ||
    sorts.at(-1)?.direction !== "asc"
  )
    invalid("Keyset sorting requires the row ID tie-breaker");
  if (sorts.length !== lastTuple.length)
    invalid("Cursor tuple does not match the query sort");
  const params = sorts.map((sort, index) => sortValue(sort, lastTuple[index]));
  const columns = sorts.map((sort) => quoteColumn(sort.column));
  const bindings = sorts.map(
    (sort, index) => `$${firstParameter + index}${sortCast(sort)}`,
  );
  const terms = sorts.map((sort, index) => {
    const prefix = columns
      .slice(0, index)
      .map(
        (column, previous) =>
          `${column} IS NOT DISTINCT FROM ${bindings[previous]}`,
      );
    const advance =
      params[index] === null
        ? "FALSE"
        : `(${columns[index]} ${sort.direction === "asc" ? ">" : "<"} ${bindings[index]}${sort.type === "row_id" ? "" : ` OR ${columns[index]} IS NULL`})`;
    return `(${[...prefix, advance].join(" AND ")})`;
  });
  return { where: `(${terms.join(" OR ")})`, params };
}

export interface CursorBinding {
  orgId: string;
  tableId: string;
  schemaVersion: number;
  membershipVersion: number;
  queryHash: string;
  actorId: string;
}

function cursorInvalid(
  message = "Cursor is invalid; restart the query",
): never {
  throw new RootsetError("CURSOR_INVALID", message, 409);
}

function validBinding(binding: CursorBinding): boolean {
  return (
    IdSchema.safeParse(binding.orgId).success &&
    IdSchema.safeParse(binding.tableId).success &&
    Number.isSafeInteger(binding.schemaVersion) &&
    binding.schemaVersion > 0 &&
    Number.isSafeInteger(binding.membershipVersion) &&
    binding.membershipVersion >= 0 &&
    typeof binding.actorId === "string" &&
    binding.actorId.length > 0 &&
    binding.actorId.length <= 256 &&
    /^[a-f0-9]{64}$/.test(binding.queryHash)
  );
}

export class CursorCodec {
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    secret: string | Uint8Array,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.secret =
      typeof secret === "string"
        ? Buffer.from(secret, "utf8")
        : Buffer.from(secret);
    if (this.secret.byteLength < 32)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Cursor signing secret requires at least 32 bytes",
        500,
      );
    this.ttlMs = options.ttlMs ?? limits.cursorLifetimeMs;
    if (
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 1 ||
      this.ttlMs > limits.cursorLifetimeMs
    )
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Cursor lifetime is invalid",
        500,
      );
    this.now = options.now ?? Date.now;
  }

  encode(binding: CursorBinding, lastTuple: readonly JsonValue[]): string {
    if (
      !validBinding(binding) ||
      lastTuple.length < 1 ||
      lastTuple.length > limits.querySorts + 1
    )
      cursorInvalid();
    for (const value of lastTuple) canonicalJson(value);
    const issuedAt = this.now();
    const payload = Buffer.from(
      canonicalJson(
        {
          version: 1,
          binding,
          lastTuple,
          issuedAt,
          expiresAt: issuedAt + this.ttlMs,
        },
        { maxDepth: 96 },
      ),
      "utf8",
    ).toString("base64url");
    if (payload.length > 131_072) cursorInvalid("Cursor tuple is too large");
    return `${payload}.${this.sign(payload).toString("base64url")}`;
  }

  decode(cursor: string, binding: CursorBinding): JsonValue[] {
    if (
      !validBinding(binding) ||
      typeof cursor !== "string" ||
      cursor.length > 131_200 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)
    )
      cursorInvalid();
    const [payload, signature] = cursor.split(".") as [string, string];
    const supplied = Buffer.from(signature, "base64url");
    const expected = this.sign(payload);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      cursorInvalid();
    if (supplied.toString("base64url") !== signature) cursorInvalid();
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      cursorInvalid();
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      cursorInvalid();
    const value = decoded as {
      version?: unknown;
      binding?: unknown;
      lastTuple?: unknown;
      issuedAt?: unknown;
      expiresAt?: unknown;
    };
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.issuedAt) ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.issuedAt as number) > this.now() + 60_000 ||
      (value.expiresAt as number) <= this.now() ||
      (value.expiresAt as number) - (value.issuedAt as number) > this.ttlMs ||
      (value.expiresAt as number) <= (value.issuedAt as number)
    )
      cursorInvalid(
        "Cursor expired or has an invalid lifetime; restart the query",
      );
    try {
      if (canonicalJson(value.binding) !== canonicalJson(binding))
        cursorInvalid("Cursor authority or query changed; restart the query");
      if (
        !Array.isArray(value.lastTuple) ||
        value.lastTuple.length < 1 ||
        value.lastTuple.length > limits.querySorts + 1
      )
        cursorInvalid();
      for (const entry of value.lastTuple) canonicalJson(entry);
    } catch (error) {
      if (error instanceof RootsetError && error.code === "CURSOR_INVALID")
        throw error;
      cursorInvalid();
    }
    return value.lastTuple as JsonValue[];
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(payload).digest();
  }
}

export interface PageOptions {
  limit: number;
  byteLimit: number;
  schemaVersion: number;
  cursorForRow: (row: Row) => string;
  sourceHasMore?: boolean;
  envelope?: Record<string, JsonValue>;
}

export function buildPage(
  rows: readonly Row[],
  options: PageOptions,
): QueryResult {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > limits.queryRows
  )
    invalid("Query limit must be between 1 and 25,000");
  if (
    !Number.isSafeInteger(options.byteLimit) ||
    options.byteLimit < 1 ||
    options.byteLimit > limits.restResultBytes
  )
    invalid("Query byte limit is invalid");
  if (!Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 1)
    invalid("Schema version is invalid");
  const data: Row[] = [];
  let rowBytes = 0;
  let nextCursor: string | null = null;
  let stopReason: QueryResult["page"]["stopReason"] = "end";
  const metadata = (
    returned: number,
    hasMore: boolean,
    cursor: string | null,
    reason: QueryResult["page"]["stopReason"],
  ): QueryResult => ({
    data: [],
    schemaVersion: options.schemaVersion,
    page: {
      returned,
      requestedLimit: options.limit,
      hasMore,
      nextCursor: cursor,
      stopReason: reason,
      consistency: "live",
    },
  });
  const bytes = (
    meta: QueryResult,
    valuesBytes: number,
    count: number,
  ): number =>
    Buffer.byteLength(
      JSON.stringify({ ...options.envelope, ...meta }),
      "utf8",
    ) +
    valuesBytes +
    Math.max(0, count - 1);
  if (bytes(metadata(0, false, null, "end"), 0, 0) > options.byteLimit)
    throw new RootsetError(
      "PAYLOAD_TOO_LARGE",
      "Query response metadata exceeds the byte budget",
      413,
    );
  for (let index = 0; index < Math.min(rows.length, options.limit); index++) {
    const row = rows[index]!;
    const rowSize = Buffer.byteLength(JSON.stringify(row), "utf8");
    const hasMore = index + 1 < rows.length || options.sourceHasMore === true;
    const cursor = hasMore ? options.cursorForRow(row) : null;
    const reason = hasMore ? "row_limit" : "end";
    // Reserve the longest stopping label so a later byte boundary still fits.
    if (
      bytes(
        metadata(index + 1, hasMore, cursor, hasMore ? "byte_limit" : reason),
        rowBytes + rowSize,
        index + 1,
      ) > options.byteLimit
    ) {
      stopReason = "byte_limit";
      break;
    }
    data.push(row);
    rowBytes += rowSize;
    nextCursor = cursor;
    stopReason = reason;
  }
  const hasMore = data.length < rows.length || options.sourceHasMore === true;
  if (hasMore && data.length === 0)
    throw new RootsetError(
      "PAYLOAD_TOO_LARGE",
      "One complete row cannot fit the response byte budget",
      413,
    );
  if (hasMore && nextCursor === null)
    nextCursor = options.cursorForRow(data.at(-1)!);
  const result = {
    ...metadata(
      data.length,
      hasMore,
      hasMore ? nextCursor : null,
      hasMore ? stopReason : "end",
    ),
    data,
  };
  if (
    Buffer.byteLength(
      JSON.stringify({ ...options.envelope, ...result }),
      "utf8",
    ) > options.byteLimit
  )
    throw new RootsetError(
      "PAYLOAD_TOO_LARGE",
      "Query response exceeds the byte budget",
      413,
    );
  return result;
}
