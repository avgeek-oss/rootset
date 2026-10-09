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
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { withOrg, type Pool } from "@rootset/database";
import { newId, RootsetError, type Actor } from "@rootset/contracts";
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
        "ARTIFACT_UNVERIFIED",
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
                "ARTIFACT_UNVERIFIED",
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
                "ARTIFACT_UNVERIFIED",
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
          "ARTIFACT_UNVERIFIED",
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
        "ARTIFACT_UNVERIFIED",
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
    await withOrg(this.pool, actor.orgId, (client) =>
      client.query(
        "UPDATE rootset_control.artifacts SET state='deleted',updated_at=now() WHERE id=$1",
        [artifact.id],
      ),
    );
  }
}
