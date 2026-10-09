import { createHash } from "node:crypto";
import { canonicalJson } from "@rootset/contracts";

function historyContent(record: Record<string, unknown>): string {
  const outer = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const data =
    outer.recordType && outer.data && typeof outer.data === "object"
      ? { ...(outer.data as Record<string, unknown>) }
      : outer;
  for (const key of ["id", "public_id", "org_id", "database_id"])
    delete data[key];
  return canonicalJson(
    outer.recordType
      ? { recordType: outer.recordType, sequence: outer.sequence, data }
      : data,
    { maxDepth: 96 },
  );
}

export class HistoryFingerprint {
  private sum = 0n;
  count = 0;
  add(record: Record<string, unknown>) {
    const digest = createHash("sha512")
      .update(historyContent(record))
      .digest("hex");
    this.sum = (this.sum + BigInt(`0x${digest}`)) & ((1n << 512n) - 1n);
    this.count++;
  }
  digest() {
    return `${this.count}:${this.sum.toString(16).padStart(128, "0")}`;
  }
}
