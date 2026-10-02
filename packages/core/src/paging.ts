import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  IdSchema,
  RootsetError,
  canonicalJson,
  limits,
  parseStrictJson,
  type Actor,
  type JsonValue,
} from "@rootset/contracts";

export interface MetadataPageRequest {
  /** Include the collection and its parent IDs, for example databases:<orgId>. */
  resource: string;
  filter?: JsonValue;
  limit?: number;
  cursor?: string | null;
}

export interface MetadataPagePosition {
  afterId: string | null;
  limit: number;
  pageNumber: number;
}

export interface MetadataPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MetadataPagingOptions {
  clock?: () => number;
  lifetimeMs?: number;
  defaultLimit?: number;
  maxLimit?: number;
}

const payloadSchema = z.strictObject({
  version: z.literal(1),
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  afterId: IdSchema,
  pageNumber: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const invalidCursor = (): never => {
  throw new RootsetError(
    "CURSOR_INVALID",
    "The cursor is invalid, expired, or belongs to another request",
    400,
  );
};

/** Stable ULID keyset paging. Database callers can read then fetch limit + 1. */
export class MetadataPaging {
  private readonly key: Buffer;
  private readonly clock: () => number;
  private readonly lifetimeMs: number;
  private readonly defaultLimit: number;
  private readonly maxLimit: number;

  constructor(secret: string, options: MetadataPagingOptions = {}) {
    if (Buffer.byteLength(secret) < 32)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Metadata cursor signing requires a secret of at least 32 bytes",
        500,
      );
    this.key = createHmac("sha256", secret)
      .update("rootset:metadata-paging:v1")
      .digest();
    this.clock = options.clock ?? Date.now;
    this.lifetimeMs = options.lifetimeMs ?? limits.cursorLifetimeMs;
    this.defaultLimit = options.defaultLimit ?? 200;
    this.maxLimit = options.maxLimit ?? limits.queryRows;
    if (
      !Number.isSafeInteger(this.lifetimeMs) ||
      this.lifetimeMs < 1 ||
      this.lifetimeMs > limits.cursorLifetimeMs ||
      !Number.isSafeInteger(this.defaultLimit) ||
      !Number.isSafeInteger(this.maxLimit) ||
      this.defaultLimit < 1 ||
      this.defaultLimit > this.maxLimit ||
      this.maxLimit > limits.queryRows
    )
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Invalid metadata paging limits",
        500,
      );
  }

  private binding(actor: Actor, request: MetadataPageRequest): string {
    if (
      typeof request.resource !== "string" ||
      request.resource.length < 1 ||
      request.resource.length > 512
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Invalid collection identity",
      );
    const limit = request.limit ?? this.defaultLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxLimit)
      throw new RootsetError(
        "VALIDATION_FAILED",
        `Metadata page limit must be between 1 and ${this.maxLimit}`,
      );
    const filter = canonicalJson(request.filter ?? null, { maxDepth: 8 });
    if (Buffer.byteLength(filter) > 4096)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Metadata filter is too large",
      );
    const targets = actor.targets.map((target) => canonicalJson(target)).sort();
    return createHash("sha256")
      .update(
        canonicalJson({
          resource: request.resource,
          filter,
          limit,
          actor: {
            kind: actor.kind,
            id: actor.id,
            orgId: actor.orgId,
            userId: actor.userId ?? null,
            credentialId: actor.credentialId ?? null,
            clientId: actor.clientId ?? null,
            role: actor.role,
            grantVersion: actor.grantVersion ?? null,
            scopes: [...new Set(actor.scopes)].sort(),
            targets,
            unrestricted: actor.unrestricted ?? false,
            operator: actor.operator ?? false,
          },
        }),
      )
      .digest("hex");
  }

  read(actor: Actor, request: MetadataPageRequest): MetadataPagePosition {
    const binding = this.binding(actor, request);
    const limit = request.limit ?? this.defaultLimit;
    if (request.cursor === undefined || request.cursor === null)
      return { afterId: null, limit, pageNumber: 1 };
    if (
      typeof request.cursor !== "string" ||
      request.cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(request.cursor)
    )
      return invalidCursor();
    const [encoded, signature] = request.cursor.split(".") as [string, string];
    const expected = createHmac("sha256", this.key).update(encoded).digest();
    const provided = Buffer.from(signature, "base64url");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected) ||
      provided.toString("base64url") !== signature
    )
      return invalidCursor();
    let payload: z.infer<typeof payloadSchema>;
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) return invalidCursor();
      payload = payloadSchema.parse(
        parseStrictJson(bytes.toString("utf8"), {
          maxBytes: 1024,
          maxDepth: 2,
        }),
      );
    } catch {
      return invalidCursor();
    }
    const now = this.clock();
    if (
      payload.binding !== binding ||
      payload.issuedAt > now ||
      payload.expiresAt <= now ||
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > this.lifetimeMs
    )
      return invalidCursor();
    return {
      afterId: payload.afterId,
      limit,
      pageNumber: payload.pageNumber,
    };
  }

  /** Accepts a full in-memory collection or a SQL keyset result with one extra row. */
  paginate<T extends { id: string }>(
    rows: readonly T[],
    actor: Actor,
    request: MetadataPageRequest,
  ): MetadataPage<T> {
    const position = this.read(actor, request);
    const sorted = rows
      .map((row) => {
        const parsed = IdSchema.safeParse(row.id);
        if (!parsed.success)
          throw new RootsetError(
            "INTERNAL_ERROR",
            "Metadata collection contains an invalid identifier",
            500,
          );
        return { id: parsed.data, row };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index - 1]!.id === sorted[index]!.id)
        throw new RootsetError(
          "INTERNAL_ERROR",
          "Metadata collection contains duplicate identifiers",
          500,
        );
    }
    const available = position.afterId
      ? sorted.filter((item) => item.id > position.afterId!)
      : sorted;
    const selected = available.slice(0, position.limit);
    const hasMore = available.length > position.limit;
    let nextCursor: string | null = null;
    if (hasMore) {
      const now = this.clock();
      const encoded = Buffer.from(
        canonicalJson({
          version: 1,
          binding: this.binding(actor, request),
          afterId: selected.at(-1)!.id,
          pageNumber: position.pageNumber + 1,
          issuedAt: now,
          expiresAt: now + this.lifetimeMs,
        }),
      ).toString("base64url");
      nextCursor = `${encoded}.${createHmac("sha256", this.key).update(encoded).digest("base64url")}`;
    }
    return { data: selected.map(({ row }) => row), hasMore, nextCursor };
  }
}
