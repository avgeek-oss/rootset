import { createHash } from "node:crypto";
import { RootsetError, type Actor } from "@rootset/contracts";

type RequestId = string | number;
type Entry = {
  principal: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
export function validMcpRequestId(value: unknown): value is RequestId {
  return typeof value === "string"
    ? value.length <= 128
    : typeof value === "number" && Number.isSafeInteger(value);
}
function principal(actor: Actor): string {
  // Stable authoritative identities, never the raw bearer or mutable role/grants.
  return createHash("sha256")
    .update(
      JSON.stringify([
        actor.orgId,
        actor.kind,
        actor.id,
        actor.credentialId ?? null,
        actor.clientId ?? null,
        actor.userId ?? null,
      ]),
    )
    .digest("hex");
}
function key(actor: Actor, requestId: RequestId): string {
  if (!validMcpRequestId(requestId))
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Use a bounded string or safe integer request identifier.",
      400,
    );
  return (
    principal(actor) + ":" + typeof requestId + ":" + JSON.stringify(requestId)
  );
}

export class McpReadRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly counts = new Map<string, number>();
  constructor(
    private readonly options = {
      maximumEntries: 1024,
      maximumPerPrincipal: 128,
      lifetimeMs: 120_000,
    },
  ) {
    if (
      !Number.isSafeInteger(options.maximumEntries) ||
      options.maximumEntries < 1 ||
      options.maximumEntries > 1024 ||
      !Number.isSafeInteger(options.maximumPerPrincipal) ||
      options.maximumPerPrincipal < 1 ||
      options.maximumPerPrincipal > 128 ||
      !Number.isSafeInteger(options.lifetimeMs) ||
      options.lifetimeMs < 1 ||
      options.lifetimeMs > 120_000
    )
      throw new RangeError("Read cancellation registry bounds are invalid.");
  }
  get size(): number {
    return this.entries.size;
  }
  assertAvailable(actor: Actor, requestId: RequestId): void {
    if (this.entries.has(key(actor, requestId)))
      throw new RootsetError(
        "VALIDATION_FAILED",
        "This MCP request identifier is already active.",
        400,
      );
  }
  begin(
    actor: Actor,
    requestId: RequestId,
    upstream: AbortSignal,
  ): { signal: AbortSignal; release: () => void } {
    this.assertAvailable(actor, requestId);
    const owner = principal(actor),
      count = this.counts.get(owner) ?? 0;
    if (
      this.entries.size >= this.options.maximumEntries ||
      count >= this.options.maximumPerPrincipal
    )
      throw new RootsetError(
        "RATE_LIMITED",
        "Too many active MCP table reads.",
        429,
        { retryAfter: 1 },
      );
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Abort at the finite deadline, retaining the slot until execution/cleanup joins.
      controller.abort();
    }, this.options.lifetimeMs);
    timer.unref();
    const entry = { principal: owner, controller, timer },
      id = key(actor, requestId);
    this.entries.set(id, entry);
    this.counts.set(owner, count + 1);
    let closed = false;
    return {
      signal: AbortSignal.any([upstream, controller.signal]),
      release: () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (this.entries.get(id) !== entry) return;
        this.entries.delete(id);
        const remaining = (this.counts.get(owner) ?? 1) - 1;
        if (remaining === 0) this.counts.delete(owner);
        else this.counts.set(owner, remaining);
      },
    };
  }
  cancel(actor: Actor, requestId: RequestId): void {
    this.entries.get(key(actor, requestId))?.controller.abort();
  }
}
