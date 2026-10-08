import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, statfs, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { withOrg, type Pool } from "@rootset/database";
import {
  newId,
  RootsetError,
  OperationContextSchema,
  type Actor,
} from "@rootset/contracts";
import type { ArtifactConfig, ArtifactRecord, JobRecord } from "./types.js";

export function decodeEncryptionKey(value: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value, /^[a-f0-9]{64}$/i.test(value) ? "hex" : "base64");
  if (key.length !== 32)
    throw new RootsetError(
      "CONFIGURATION_INVALID",
      "Artifact encryption key must decode to 32 bytes",
      500,
    );
  return key;
}
function objectFailure(error: unknown): RootsetError | null {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (
    [
      "AccessDenied",
      "Forbidden",
      "InvalidAccessKeyId",
      "SignatureDoesNotMatch",
      "ExpiredToken",
      "InvalidToken",
      "AuthorizationHeaderMalformed",
    ].includes(name)
  )
    return new RootsetError(
      "ARTIFACT_PERMISSION_DENIED",
      "Object storage denied artifact access; check the configured destination credential",
      503,
    );
  if (["NoSuchKey", "NotFound", "IncompleteBody"].includes(name))
    return new RootsetError(
      "ARTIFACT_INCOMPLETE",
      "Artifact upload or object storage content is incomplete",
      409,
    );
  return null;
}

export class ArtifactStore {
  private lastTemporaryCleanup = 0;

  async cleanupTemporaryFiles(now = Date.now()): Promise<number> {
    if (now - this.lastTemporaryCleanup < 3600000) return 0;
    this.lastTemporaryCleanup = now;
    let removed = 0;
    const temporaryRoot = this.config.tempDirectory ?? tmpdir();
    for (const name of await readdir(temporaryRoot)) {
      if (!/^rootset-artifact-[A-Za-z0-9]{6}$/.test(name)) continue;
      const path = join(temporaryRoot, name);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (typeof process.getuid === "function" &&
          info.uid !== process.getuid()) ||
        info.mtimeMs > now - 48 * 3600000
      )
        continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
  readonly client: S3Client;
  private readonly encryptionKey: Buffer;
  constructor(
    readonly pool: Pool,
    readonly config: ArtifactConfig,
  ) {
    this.encryptionKey = decodeEncryptionKey(config.encryptionKey);
    this.client = new S3Client({
      region: config.region ?? "us-east-1",
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async get(actor: Actor, id: string): Promise<ArtifactRecord> {
    return withOrg(this.pool, actor.orgId, async (client) => {
      const artifact = (
        await client.query<ArtifactRecord>(
          "SELECT * FROM rootset_control.artifacts WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!artifact || artifact.state === "deleted")
        throw new RootsetError("RESOURCE_NOT_FOUND", "Artifact not found", 404);
      if (
        artifact.expires_at.getTime() <= Date.now() ||
        artifact.state === "expired"
      )
        throw new RootsetError(
          "ARTIFACT_EXPIRED",
          "This artifact has expired",
          410,
        );
      return artifact;
    });
  }

  async prepareUpload(
    actor: Actor,
    input: {
      tableId: string;
      format: string;
      byteLength: number;
      checksum?: string;
      idempotencyKey: string;
    },
  ) {
    if (
      !OperationContextSchema.shape.idempotencyKey.safeParse(
        input.idempotencyKey,
      ).success
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Upload preparation requires a valid idempotency key",
        400,
      );
    const maxBytes = this.config.maxUploadBytes ?? 134_217_728;
    if (
      !Number.isSafeInteger(input.byteLength) ||
      input.byteLength < 1 ||
      input.byteLength > maxBytes
    )
      throw new RootsetError(
        "PAYLOAD_TOO_LARGE",
        `Import uploads must contain 1-${maxBytes} bytes`,
        413,
      );
    if (!["csv", "jsonl"].includes(input.format))
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Import format must be csv or jsonl",
      );
    if (input.checksum && !/^[0-9a-f]{64}$/.test(input.checksum))
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Checksum must be lowercase SHA-256 hex",
      );
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify([
          actor.orgId,
          actor.kind,
          actor.id,
          input.tableId,
          input.idempotencyKey,
        ]),
      )
      .digest("hex");
    const objectKey = `rootset/${actor.orgId}/uploads/${requestDigest}`;
    const artifact = await withOrg(this.pool, actor.orgId, async (client) => {
      const inserted = await client.query<ArtifactRecord>(
        `INSERT INTO rootset_control.artifacts
        (id,org_id,requester_id,target_type,target_id,purpose,object_key,state,format,media_type,declared_bytes,expected_checksum,expires_at)
        VALUES($1,$2,$3,'table',$4,'import_upload',$5,'upload_pending',$6,$7,$8,$9,$10) ON CONFLICT(object_key) DO NOTHING RETURNING *`,
        [
          newId(),
          actor.orgId,
          `${actor.kind}:${actor.id}`,
          input.tableId,
          objectKey,
          input.format,
          input.format === "csv" ? "text/csv" : "application/x-ndjson",
          input.byteLength,
          input.checksum ?? null,
          expiresAt,
        ],
      );
      const stored =
        inserted.rows[0] ??
        (
          await client.query<ArtifactRecord>(
            "SELECT * FROM rootset_control.artifacts WHERE object_key=$1",
            [objectKey],
          )
        ).rows[0];
      if (
        !stored ||
        Number(stored.declared_bytes) !== input.byteLength ||
        stored.format !== input.format ||
        stored.expected_checksum !== (input.checksum ?? null)
      )
        throw new RootsetError(
          "IDEMPOTENCY_CONFLICT",
          "Upload preparation has different input",
          409,
        );
      if (stored.expires_at.getTime() <= Date.now())
        throw new RootsetError(
          "ARTIFACT_EXPIRED",
          "This upload preparation expired; use a new idempotency key",
          410,
        );
      return stored;
    });
    const headers: Record<string, string> = {
      "content-type": this.config.uploadBaseURL
        ? "application/octet-stream"
        : artifact.media_type,
    };
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: artifact.object_key,
      ContentType: artifact.media_type,
      ContentLength: input.byteLength,
    });
    return {
      artifactId: artifact.id,
      uploadUrl: this.config.uploadBaseURL
        ? `${this.config.uploadBaseURL.replace(/\/$/, "")}/v1/orgs/${actor.orgId}/artifacts/${artifact.id}/upload`
        : await getSignedUrl(this.client, command, {
            expiresIn: Math.max(
              1,
              Math.floor((artifact.expires_at.getTime() - Date.now()) / 1000),
            ),
          }),
      method: "PUT" as const,
      headers,
      expiresAt: artifact.expires_at.toISOString(),
      maxBytes,
      byteLength: input.byteLength,
    };
  }

  async upload(
    actor: Actor,
    artifact: ArtifactRecord,
    source: AsyncIterable<Uint8Array>,
    recheck?: () => Promise<void>,
  ): Promise<{ artifactId: string; byteLength: number; checksum: string }> {
    const declared = Number(artifact.declared_bytes);
    if (
      artifact.purpose !== "import_upload" ||
      artifact.state !== "upload_pending" ||
      !Number.isSafeInteger(declared) ||
      declared < 1 ||
      declared > (this.config.maxUploadBytes ?? 134217728)
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Artifact is not a pending bounded import upload",
      );
    const token = newId(),
      attemptId = newId(),
      key = `rootset/${actor.orgId}/uploads/${artifact.id}/${token}`;
    const current = await withOrg(this.pool, actor.orgId, async (client) => {
      const row = (
        await client.query<ArtifactRecord>(
          "SELECT * FROM rootset_control.artifacts WHERE id=$1 FOR UPDATE",
          [artifact.id],
        )
      ).rows[0];
      if (
        !row ||
        row.state !== "upload_pending" ||
        row.expires_at.getTime() <= Date.now()
      )
        throw new RootsetError(
          "ARTIFACT_EXPIRED",
          "This import upload is no longer available",
          410,
        );
      if (typeof row.metadata.uploadedObjectKey === "string") return row;
      if (
        typeof row.metadata.httpUploadUntil === "string" &&
        new Date(row.metadata.httpUploadUntil).getTime() > Date.now()
      )
        throw new RootsetError(
          "STATE_CONFLICT",
          "An upload is already in progress for this artifact",
          409,
        );
      await client.query(
        `INSERT INTO rootset_control.artifacts(id,org_id,requester_id,target_type,target_id,purpose,object_key,state,format,media_type,declared_bytes,metadata,expires_at)
        VALUES($1,$2,$3,'table',$4,'import_upload_attempt',$5,'uploading',$6,'application/octet-stream',$7,$8,$9)`,
        [
          attemptId,
          actor.orgId,
          artifact.requester_id,
          artifact.target_id,
          key,
          artifact.format,
          declared,
          { parentArtifactId: artifact.id },
          artifact.expires_at,
        ],
      );
      await client.query(
        "UPDATE rootset_control.artifacts SET metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$1",
        [
          artifact.id,
          {
            httpUploadToken: token,
            httpUploadUntil: artifact.expires_at.toISOString(),
          },
        ],
      );
      return row;
    });
    const hash = createHash("sha256");
    let bytes = 0;
    async function* checked() {
      for await (const value of source) {
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > declared)
          throw new RootsetError(
            "PAYLOAD_TOO_LARGE",
            "Upload exceeded its declared byte length",
            413,
          );
        hash.update(chunk);
        yield chunk;
      }
      if (bytes !== declared)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Upload byte length does not match its declaration",
        );
    }
    if (typeof current.metadata.uploadedObjectKey === "string") {
      await pipeline(
        Readable.from(checked()),
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        {
          signal: AbortSignal.timeout(
            Math.max(
              1,
              Math.min(600000, current.expires_at.getTime() - Date.now()),
            ),
          ),
        },
      );
      const checksum = hash.digest("hex");
      if (checksum !== current.metadata.uploadedChecksum)
        throw new RootsetError(
          "IDEMPOTENCY_CONFLICT",
          "This artifact was already uploaded with different content",
          409,
        );
      await recheck?.();
      return { artifactId: artifact.id, byteLength: bytes, checksum };
    }
    const sink = new PassThrough();
    const transfer = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: sink,
        ContentType: "application/octet-stream",
      },
      queueSize: 2,
      partSize: 5 * 1024 ** 2,
      leavePartsOnError: false,
    });
    const timer = setTimeout(
      () => {
        sink.destroy(
          new RootsetError(
            "ARTIFACT_EXPIRED",
            "Import upload exceeded its transfer deadline",
            410,
          ),
        );
        void transfer.abort();
      },
      Math.max(1, Math.min(600000, current.expires_at.getTime() - Date.now())),
    );
    timer.unref();
    try {
      await Promise.all([
        pipeline(Readable.from(checked()), sink),
        transfer.done(),
      ]);
      const checksum = hash.digest("hex");
      if (current.expected_checksum && checksum !== current.expected_checksum)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Upload checksum does not match its declaration",
        );
      await recheck?.();
      await withOrg(this.pool, actor.orgId, async (client) => {
        const finished = await client.query(
          `UPDATE rootset_control.artifacts SET metadata=(metadata-'httpUploadToken'-'httpUploadUntil')||$3::jsonb,updated_at=now()
          WHERE id=$1 AND state='upload_pending' AND expires_at>clock_timestamp() AND metadata->>'httpUploadToken'=$2 RETURNING id`,
          [
            artifact.id,
            token,
            {
              uploadedObjectKey: key,
              uploadedChecksum: checksum,
              uploadedBytes: bytes,
            },
          ],
        );
        if (!finished.rowCount)
          throw new RootsetError(
            "ARTIFACT_EXPIRED",
            "Upload completion no longer owns the pending artifact",
            410,
          );
        await client.query(
          "UPDATE rootset_control.artifacts SET state='ready',byte_length=$2,checksum=$3,updated_at=now() WHERE id=$1",
          [attemptId, bytes, checksum],
        );
      });
      return { artifactId: artifact.id, byteLength: bytes, checksum };
    } catch (error) {
      await transfer.abort().catch(() => undefined);
      await this.client
        .send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
        .catch(() => undefined);
      await withOrg(this.pool, actor.orgId, async (client) => {
        await client.query(
          "UPDATE rootset_control.artifacts SET state='failed',updated_at=now() WHERE id=$1",
          [attemptId],
        );
        await client.query(
          "UPDATE rootset_control.artifacts SET metadata=metadata-'httpUploadToken'-'httpUploadUntil' WHERE id=$1 AND metadata->>'httpUploadToken'=$2",
          [artifact.id, token],
        );
      });
      throw objectFailure(error) ?? error;
    } finally {
      clearTimeout(timer);
    }
  }

  async write(
    actor: Actor,
    job: JobRecord | null,
    target: { type: ArtifactRecord["target_type"]; id: string },
    purpose: string,
    format: string,
    mediaType: string,
    source: AsyncIterable<string | Buffer> | Readable,
    metadata: Record<string, unknown> = {},
    options: {
      lifetimeSeconds?: number;
      maxBytes?: number;
      expiresAt?: Date;
      deadlineAt?: number;
      beforePublish?: () => Promise<void>;
      allowCancelled?: boolean;
    } = {},
  ): Promise<ArtifactRecord> {
    const objectKey = `rootset/${actor.orgId}/${target.type}/${target.id}/${job?.id ?? newId()}/${job?.lease_token ?? "direct"}/${purpose}/${newId()}`;
    const key = this.encryptionKey;
    const iv = randomBytes(12);
    const expiresAt =
      options.expiresAt ??
      new Date(
        Date.now() +
          (options.lifetimeSeconds ??
            this.config.artifactLifetimeSeconds ??
            86400) *
            1000,
      );
    const artifact = await withOrg(this.pool, actor.orgId, async (client) => {
      if (job) {
        const lease = await client.query(
          "SELECT 1 FROM rootset_control.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() AND ($3::boolean OR NOT cancel_requested)",
          [job.id, job.lease_token, options.allowCancelled ?? false],
        );
        if (!lease.rowCount)
          throw new RootsetError(
            "JOB_FAILED",
            "Worker lease was lost before artifact creation",
            409,
          );
      }
      const result = await client.query<ArtifactRecord>(
        `INSERT INTO rootset_control.artifacts
        (id,org_id,job_id,requester_id,target_type,target_id,purpose,object_key,state,format,media_type,iv,metadata,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'uploading',$9,$10,$11,$12,$13)
        RETURNING *`,
        [
          newId(),
          actor.orgId,
          job?.id ?? null,
          `${actor.kind}:${actor.id}`,
          target.type,
          target.id,
          purpose,
          objectKey,
          format,
          mediaType,
          iv.toString("base64"),
          metadata,
          expiresAt,
        ],
      );
      return result.rows[0]!;
    });
    const plainHash = createHash("sha256");
    const cipherHash = createHash("sha256");
    let length = 0;
    let cipherLength = 0;
    const maximum =
      options.maxBytes ?? this.config.maxArtifactBytes ?? 64 * 1024 ** 3;
    const countPlain = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        length += chunk.length;
        if (length > maximum) {
          callback(
            new RootsetError(
              "PAYLOAD_TOO_LARGE",
              "Artifact exceeds the configured byte budget",
              413,
            ),
          );
          return;
        }
        plainHash.update(chunk);
        callback(null, chunk);
      },
    });
    const countCipher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        cipherLength += chunk.length;
        cipherHash.update(chunk);
        callback(null, chunk);
      },
    });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${actor.orgId}:${artifact.id}:${purpose}`));
    const sink = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: objectKey,
        Body: sink,
        ContentType: "application/octet-stream",
      },
      queueSize: 2,
      partSize: 5 * 1024 ** 2,
      leavePartsOnError: false,
    });
    const deadlineAt = job?.deadline ?? options.deadlineAt;
    const deadline = deadlineAt
      ? setTimeout(
          () => {
            sink.destroy(
              new RootsetError(
                "JOB_FAILED",
                "Artifact upload exceeded the maximum operation runtime",
                408,
              ),
            );
            void upload.abort();
          },
          Math.max(1, deadlineAt - Date.now()),
        )
      : undefined;
    deadline?.unref();
    try {
      await Promise.all([
        pipeline(
          source instanceof Readable ? source : Readable.from(source),
          countPlain,
          cipher,
          countCipher,
          sink,
        ),
        upload.done(),
      ]);
      const checksum = plainHash.digest("hex");
      const ciphertextChecksum = cipherHash.digest("hex");
      const tag = cipher.getAuthTag().toString("base64");
      if (deadlineAt !== undefined && Date.now() >= deadlineAt)
        throw new RootsetError(
          "ARTIFACT_EXPIRED",
          "Artifact upload exceeded its permitted runtime",
          410,
        );
      await options.beforePublish?.();
      const stored = await withOrg(this.pool, actor.orgId, async (client) => {
        const result = await client.query<ArtifactRecord>(
          `UPDATE rootset_control.artifacts SET state='ready',byte_length=$2,ciphertext_length=$3,checksum=$4,ciphertext_checksum=$5,tag=$6,updated_at=now()
          WHERE id=$1 AND ($7::char(26) IS NULL OR EXISTS(SELECT 1 FROM rootset_control.jobs j WHERE j.id=$7 AND j.lease_token=$8 AND j.state='running' AND j.lease_until>now() AND ($9::boolean OR NOT j.cancel_requested))) RETURNING *`,
          [
            artifact.id,
            length,
            cipherLength,
            checksum,
            ciphertextChecksum,
            tag,
            job?.id ?? null,
            job?.lease_token ?? null,
            options.allowCancelled ?? false,
          ],
        );
        if (!result.rows[0])
          throw new RootsetError(
            "JOB_FAILED",
            "Artifact completion lost its worker lease",
            409,
          );
        return result.rows[0];
      });
      return stored;
    } catch (error) {
      await upload.abort().catch(() => undefined);
      await withOrg(this.pool, actor.orgId, (client) =>
        client.query(
          "UPDATE rootset_control.artifacts SET state='failed',updated_at=now() WHERE id=$1 AND state='uploading'",
          [artifact.id],
        ),
      );
      throw objectFailure(error) ?? error;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  async finalizeUpload(
    actor: Actor,
    artifact: ArtifactRecord,
    job: JobRecord | null,
    options: { deadlineAt?: number; beforePublish?: () => Promise<void> } = {},
  ): Promise<ArtifactRecord> {
    if (typeof artifact.metadata.finalizedArtifactId === "string")
      return this.get(actor, artifact.metadata.finalizedArtifactId);
    if (artifact.state === "ready") return artifact;
    if (artifact.state !== "upload_pending")
      throw new RootsetError(
        "VALIDATION_FAILED",
        "The import artifact is not an uploaded file",
      );
    const deadlineAt = job?.deadline ?? options.deadlineAt;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
      throw new RootsetError(
        "ARTIFACT_EXPIRED",
        "Import encryption exceeded its permitted runtime",
        410,
      );
    const requestOptions =
      deadlineAt === undefined
        ? undefined
        : {
            abortSignal: AbortSignal.timeout(
              Math.max(1, deadlineAt - Date.now()),
            ),
          };
    const uploadedKey =
      typeof artifact.metadata.uploadedObjectKey === "string"
        ? artifact.metadata.uploadedObjectKey
        : artifact.object_key;
    let head;
    try {
      head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: uploadedKey,
        }),
        requestOptions,
      );
    } catch (error) {
      const failure = objectFailure(error);
      if (failure) throw failure;
      throw new RootsetError(
        "UPSTREAM_UNAVAILABLE",
        "Object storage could not verify the uploaded file",
        503,
      );
    }
    if (
      head.ContentLength !== Number(artifact.declared_bytes) ||
      !head.ContentLength ||
      head.ContentLength > (this.config.maxUploadBytes ?? 134_217_728)
    )
      throw new RootsetError(
        "PAYLOAD_TOO_LARGE",
        "Uploaded size differs from the declared bounded upload",
        413,
      );
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: uploadedKey,
      }),
      requestOptions,
    );
    if (!response.Body)
      throw new RootsetError(
        "JOB_FAILED",
        "Object storage returned an empty upload",
        502,
      );
    const hash = createHash("sha256");
    let count = 0;
    const source = response.Body as Readable;
    const expected =
      artifact.expected_checksum ??
      (typeof artifact.metadata.uploadedChecksum === "string"
        ? artifact.metadata.uploadedChecksum
        : null);
    async function* verify() {
      for await (const value of source) {
        const chunk = Buffer.from(value);
        count += chunk.length;
        if (count > Number(artifact.declared_bytes))
          throw new RootsetError(
            "PAYLOAD_TOO_LARGE",
            "Upload exceeded its declared size",
            413,
          );
        hash.update(chunk);
        yield chunk;
      }
      if (
        count !== Number(artifact.declared_bytes) ||
        (expected && hash.digest("hex") !== expected)
      )
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Upload checksum or byte length does not match",
        );
    }
    const encrypted = await this.write(
      actor,
      job,
      { type: "table", id: artifact.target_id },
      `import-${artifact.id}`,
      artifact.format,
      artifact.media_type,
      verify(),
      { sourceArtifactId: artifact.id },
      { maxBytes: Number(artifact.declared_bytes), ...options },
    );
    await options.beforePublish?.();
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
      throw new RootsetError(
        "ARTIFACT_EXPIRED",
        "Import encryption exceeded its permitted runtime",
        410,
      );
    const published = await withOrg(this.pool, actor.orgId, async (client) => {
      const pointer = await client.query(
        "UPDATE rootset_control.artifacts SET metadata=metadata||$2::jsonb,expires_at=$3,updated_at=now() WHERE id=$1 AND NOT(metadata ? 'finalizedArtifactId') RETURNING id",
        [
          artifact.id,
          { finalizedArtifactId: encrypted.id },
          encrypted.expires_at,
        ],
      );
      if (pointer.rowCount) return encrypted;
      const existing = (
        await client.query<{ metadata: ArtifactRecord["metadata"] }>(
          "SELECT metadata FROM rootset_control.artifacts WHERE id=$1",
          [artifact.id],
        )
      ).rows[0];
      if (
        !existing ||
        typeof existing.metadata.finalizedArtifactId !== "string"
      )
        throw new RootsetError(
          "ARTIFACT_INCOMPLETE",
          "Import encryption lost its source artifact binding",
          409,
        );
      return (
        await client.query<ArtifactRecord>(
          "SELECT * FROM rootset_control.artifacts WHERE id=$1",
          [existing.metadata.finalizedArtifactId],
        )
      ).rows[0]!;
    });
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: uploadedKey,
        }),
      );
    } catch {
      await withOrg(this.pool, actor.orgId, (client) =>
        client.query(
          "UPDATE rootset_control.artifacts SET metadata=metadata||'{\"cleanupPending\":true}'::jsonb WHERE id=$1",
          [artifact.id],
        ),
      );
    }
    return published;
  }

  async openVerified(
    actor: Actor,
    artifact: ArtifactRecord,
  ): Promise<{ stream: Readable; cleanup(): Promise<void> }> {
    await this.cleanupTemporaryFiles();
    if (
      artifact.state !== "ready" ||
      !artifact.checksum ||
      !artifact.ciphertext_checksum ||
      !artifact.iv ||
      !artifact.tag
    )
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Artifact has not reached a readable verified state",
        409,
      );
    const key = this.encryptionKey;
    const temporaryRoot = this.config.tempDirectory ?? tmpdir();
    const space = await statfs(temporaryRoot);
    const reserve = this.config.minimumTempFreeBytes ?? 1024 ** 3;
    if (space.bavail * space.bsize < Number(artifact.byte_length) + reserve)
      throw new RootsetError(
        "CAPACITY_LIMIT",
        "Artifact validation requires more temporary disk capacity",
        503,
      );
    const directory = await mkdtemp(join(temporaryRoot, "rootset-artifact-"));
    const file = join(directory, "ciphertext");
    const cleanup = async () => {
      await rm(directory, { recursive: true, force: true });
    };
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: artifact.object_key,
        }),
      );
      if (!response.Body)
        throw new RootsetError("JOB_FAILED", "Artifact object is missing", 502);
      const ciphertextHash = createHash("sha256");
      const plainHash = createHash("sha256");
      let plainLength = 0;
      let cipherLength = 0;
      const countCipher = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          cipherLength += chunk.length;
          if (cipherLength > Number(artifact.ciphertext_length)) {
            callback(
              new RootsetError(
                "BACKUP_UNVERIFIED",
                "Artifact ciphertext exceeded its authenticated byte length",
                409,
              ),
            );
            return;
          }
          ciphertextHash.update(chunk);
          callback(null, chunk);
        },
      });
      const countPlain = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          plainLength += chunk.length;
          if (plainLength > Number(artifact.byte_length)) {
            callback(
              new RootsetError(
                "BACKUP_UNVERIFIED",
                "Artifact plaintext exceeded its declared byte length",
                409,
              ),
            );
            return;
          }
          plainHash.update(chunk);
          callback(null, chunk);
        },
      });
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(artifact.iv, "base64"),
      );
      decipher.setAAD(
        Buffer.from(`${actor.orgId}:${artifact.id}:${artifact.purpose}`),
      );
      decipher.setAuthTag(Buffer.from(artifact.tag, "base64"));
      await pipeline(
        response.Body as Readable,
        countCipher,
        createWriteStream(file, { mode: 0o600 }),
      );
      await pipeline(
        createReadStream(file),
        decipher,
        countPlain,
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      );
      if (
        plainLength !== Number(artifact.byte_length) ||
        cipherLength !== Number(artifact.ciphertext_length) ||
        plainHash.digest("hex") !== artifact.checksum ||
        ciphertextHash.digest("hex") !== artifact.ciphertext_checksum
      )
        throw new RootsetError(
          "BACKUP_UNVERIFIED",
          "Artifact checksum or length validation failed",
          409,
        );
      const readable = new PassThrough();
      const authenticated = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(artifact.iv, "base64"),
      );
      authenticated.setAAD(
        Buffer.from(`${actor.orgId}:${artifact.id}:${artifact.purpose}`),
      );
      authenticated.setAuthTag(Buffer.from(artifact.tag, "base64"));
      void pipeline(createReadStream(file), authenticated, readable).catch(
        (error) => {
          readable.destroy(error);
        },
      );
      return { stream: readable, cleanup };
    } catch (error) {
      await cleanup();
      if (error instanceof RootsetError) throw error;
      const objectError = objectFailure(error);
      if (objectError) throw objectError;
      throw new RootsetError(
        "BACKUP_UNVERIFIED",
        "Artifact authentication or object read failed",
        409,
      );
    }
  }

  async remove(actor: Actor, artifact: ArtifactRecord): Promise<void> {
    await withOrg(this.pool, actor.orgId, (client) =>
      client.query(
        "UPDATE rootset_control.artifacts SET state='deleting',updated_at=now() WHERE id=$1",
        [artifact.id],
      ),
    );
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: artifact.object_key,
      }),
    );
    if (typeof artifact.metadata.uploadedObjectKey === "string") {
      if (
        !artifact.metadata.uploadedObjectKey.startsWith(
          `rootset/${actor.orgId}/`,
        )
      )
        throw new RootsetError(
          "ACCESS_DENIED",
          "Raw upload cleanup is outside the owned organisation namespace",
          403,
        );
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: artifact.metadata.uploadedObjectKey,
        }),
      );
    }
    await withOrg(this.pool, actor.orgId, (client) =>
      client.query(
        "UPDATE rootset_control.artifacts SET state='deleted',updated_at=now() WHERE id=$1",
        [artifact.id],
      ),
    );
  }
}
