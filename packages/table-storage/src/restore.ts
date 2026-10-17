import { createHash } from "node:crypto";
import {
  IdSchema,
  RootsetError,
  type FieldDefinition,
  type JsonValue,
  type UniqueRuleCondition,
  type NumberLexeme,
} from "@rootset/contracts";

export const restoreLimits = Object.freeze({
  tables: 1000,
  archiveEntries: 10_000,
  metadataFileBytes: 8 * 1024 ** 2,
  metadataBytes: 64 * 1024 ** 2,
  rowLineBytes: 128 * 1024,
  historyLineBytes: 8 * 1024 ** 2,
  batchRows: 128,
  batchBytes: 8 * 1024 ** 2,
});
export type RestoreIdKind =
  | "table"
  | "field"
  | "unique_rule"
  | "foreign_key"
  | "mutation"
  | "comment"
  | "history"
  | "view";
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function restoredId(
  databaseId: string,
  kind: RestoreIdKind,
  original: string,
): string {
  const digest = createHash("sha256")
    .update(
      `rootset.restore.v1\0${IdSchema.parse(databaseId)}\0${kind}\0${IdSchema.parse(original)}`,
    )
    .digest()
    .subarray(0, 16);
  let value = BigInt(`0x${digest.toString("hex")}`),
    result = "";
  for (let index = 0; index < 26; index++) {
    result = alphabet[Number(value & 31n)]! + result;
    value >>= 5n;
  }
  return result;
}
export function backupTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?!0000)\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00(?::00)?)$/.test(
      value,
    )
  )
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Backup contains an invalid UTC timestamp",
    );
  const normalized = value.replace(" ", "T").replace(/\+00(?::00)?$/, "Z");
  const parsed = new Date(normalized);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== normalized.slice(0, 19)
  )
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Backup contains an invalid calendar timestamp",
    );
  return normalized;
}
export interface RestoreRow {
  id: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  values: Record<string, JsonValue>;
}
export interface RestoreField {
  id: string;
  name: string;
  definition: FieldDefinition;
  position: number;
  state: "active" | "deleted";
  createdAt: string;
  deletedAt: string | null;
}
export interface RestoreUniqueRule {
  id: string;
  name: string;
  fieldIds: string[];
  where?: UniqueRuleCondition;
  strategy: "native" | "registry";
}
export interface RestoreForeignKey {
  id: string;
  fieldIds: string[];
  referencedTableId: string;
  referencedFieldIds: string[];
  referencedRuleId: string;
}
export interface RestoreTable {
  id: string;
  name: string;
  description: string;
  state: "active" | "deleted";
  schemaVersion: number;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  fields: FieldDefinition[];
  allFields: RestoreField[];
  uniqueRules: RestoreUniqueRule[];
  foreignKeys: RestoreForeignKey[];
  counters: { fieldId: string; nextValue: string }[];
}
export type RestoreHistoryKind =
  "comments" | "mutations" | "cell-changes" | "resource-history" | "views";
export interface RestoreHistoryRecord {
  value: Record<string, unknown>;
  numbers: readonly NumberLexeme[];
}
export interface RestoreSource {
  database: { id: string; name: string; description: string };
  tables: RestoreTable[];
  rows(tableId: string): AsyncIterable<RestoreRow[]>;
  history(kind: RestoreHistoryKind): AsyncIterable<RestoreHistoryRecord[]>;
  check(): Promise<void>;
}
