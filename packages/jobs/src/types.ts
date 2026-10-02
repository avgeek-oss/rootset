import type { Pool, PoolClient } from "@rootset/database";
import type { Actor, JsonValue } from "@rootset/contracts";
import type { Readable } from "node:stream";
import type {
  TableStorage,
  TableRecord,
  DatabaseSnapshotMetadata,
  SnapshotSource as NativeSnapshotSource,
  RestoreResult as NativeRestoreResult,
} from "@rootset/table-storage";

export interface Target {
  databaseId?: string;
  tableId?: string;
}
export interface OperationContext {
  jobFence?: { jobId: string; leaseToken: string };
  client?: PoolClient;
  idempotencyKey?: string;
  requestId?: string;
  source?: string;
  approvalId?: string;
  stepUpApproved?: boolean;
}
export interface ArtifactConfig {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  encryptionKeys: Record<string, string | Buffer>;
  activeKeyId: string;
  maxUploadBytes?: number;
  maxArtifactBytes?: number;
  artifactLifetimeSeconds?: number;
  minimumTempFreeBytes?: number;
  tempDirectory?: string;
  uploadBaseURL?: string;
}
export interface JobsConfig {
  idempotencySecret?: string;
  authoriseHistoryPolicy?: (
    actor: Actor,
    target: { tableId: string },
  ) => Promise<Actor>;
  deletionRetention?:
    | (() => Promise<{
        organisationDays: number | null;
        accountAuditDays: number | null;
      }>)
    | { organisationDays: number | null; accountAuditDays: number | null };
  notificationStatus?: (
    deliveryId: string,
  ) => Promise<"pending" | "sent" | "failed">;
  deletionMetadata?: (
    orgId: string,
  ) => Promise<{ organisationDeletedAt: string | null }>;
  purgeAccountAudit?: (
    orgId: string,
    before: string,
    client?: PoolClient,
  ) => Promise<number>;
  authorisePolicy?: (
    actor: Actor,
    target: { databaseId: string },
  ) => Promise<Actor>;
  metadataPaging?: {
    read(
      actor: Actor,
      request: {
        resource: string;
        filter?: JsonValue;
        limit?: number;
        cursor?: string | null;
      },
    ): { afterId: string | null; limit: number; pageNumber: number };
    paginate<T extends { id: string }>(
      rows: readonly T[],
      actor: Actor,
      request: {
        resource: string;
        filter?: JsonValue;
        limit?: number;
        cursor?: string | null;
      },
    ): { data: T[]; nextCursor: string | null; hasMore: boolean };
  };
  workerId?: string;
  workerIdFile?: string;
  artifacts: ArtifactConfig;
  baseURL?: string;
  workerConcurrency?: number;
  leaseSeconds?: number;
  pollMilliseconds?: number;
  importBatchSize?: number;
  maxAttempts?: number;
  organisationIds?: () => Promise<string[]>;
  outbox?: { deliverNext(): Promise<boolean> };
  notify?: (event: {
    orgId: string;
    databaseId: string;
    backupId: string;
    state: string;
    verifiedAt?: string;
    error?: JsonValue;
  }) => Promise<void | { state: "pending" | "sent"; deliveryId?: string }>;
  failpoint?: (point: string, jobId: string) => Promise<void>;
  onError?: (error: unknown, job: JobRecord) => void;
  reconcileOperation?: (job: JobRecord) => Promise<JsonValue | undefined>;
  executeOperation?: (
    actor: Actor,
    operationId: string,
    input: Record<string, unknown>,
    context: OperationContext & { jobId: string },
  ) => Promise<JsonValue>;
}
export type TableInfo = TableRecord;
export type SnapshotMetadata = DatabaseSnapshotMetadata;
export type SnapshotSource = NativeSnapshotSource;
export type RestoreResult = NativeRestoreResult;
export type StoragePort = Pick<
  TableStorage,
  | "getTable"
  | "getRow"
  | "getDatabase"
  | "listUniqueRules"
  | "queryRows"
  | "mutateRows"
  | "snapshotDatabase"
  | "snapshotTable"
  | "restoreDatabase"
  | "publishRestore"
  | "discardRestore"
  | "acquireRestoreBarrier"
  | "releaseRestoreBarrier"
  | "snapshotHistory"
  | "publishHistoryArchive"
  | "purgeArchivedHistory"
>;
export interface JobsOptions {
  pool: Pool;
  ddlPool: Pool;
  storage: StoragePort;
  config: JobsConfig;
  authorise?: (
    actor: Actor,
    operationId: string,
    target: Target,
  ) => Promise<void | Actor>;
}
export interface JobRecord {
  id: string;
  org_id: string;
  kind: string;
  operation_id: string;
  actor: Actor;
  requester_id: string;
  target_type: "table" | "database" | "organisation";
  target_id: string;
  input: Record<string, unknown>;
  input_digest: string;
  idempotency_key: string;
  state: string;
  stage: string;
  attempt: number;
  max_attempts: number;
  lease_token: string | null;
  lease_until: Date | null;
  cancel_requested: boolean;
  checkpoint: Record<string, unknown>;
  progress: {
    committed?: number;
    rejected?: number;
    completed?: number;
    total?: number;
    unit?: string;
  };
  result: JsonValue | null;
  error: JsonValue | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  deadline?: number;
}
export interface ArtifactRecord {
  id: string;
  org_id: string;
  job_id: string | null;
  requester_id: string;
  target_type: "table" | "database" | "organisation";
  target_id: string;
  purpose: string;
  object_key: string;
  state: string;
  format: string;
  media_type: string;
  declared_bytes: string | null;
  byte_length: string | null;
  ciphertext_length: string | null;
  checksum: string | null;
  ciphertext_checksum: string | null;
  encryption_key_id: string | null;
  iv: string | null;
  tag: string | null;
  expected_checksum: string | null;
  metadata: Record<string, unknown>;
  expires_at: Date;
  created_at: Date;
}
export interface ArtifactDownload {
  stream: Readable;
  mediaType: string;
  fileName: string;
  byteLength: number;
  checksum: string;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
