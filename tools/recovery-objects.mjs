import { createReadStream, createWriteStream } from "node:fs";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createDecipheriv, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Pool } from "pg";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(process.argv[2] ?? "");
if (
  !directory.startsWith(
    join(root, "verification/v1-recovery/physical-recovery-"),
  )
)
  throw new Error(
    "Choose the protected Rootset physical-recovery rehearsal directory",
  );
if (((await stat(directory)).mode & 0o077) !== 0)
  throw new Error("Recovery directory must exclude group and other access");
const report = JSON.parse(
  await readFile(join(directory, "report.json"), "utf8"),
);
if (
  report.baseline !== "0001_baseline.sql" ||
  report.status !== "physical_restore_verified"
)
  throw new Error("Physical PostgreSQL recovery must pass first");
const retained = JSON.parse(
  await readFile(join(directory, "protected-keys.json"), "utf8"),
);
const keys = retained.ROOTSET_ENCRYPTION_KEYS
  ? JSON.parse(retained.ROOTSET_ENCRYPTION_KEYS)
  : {
      [retained.ROOTSET_ENCRYPTION_KEY_ID ?? "primary"]:
        retained.ROOTSET_ENCRYPTION_KEY,
    };
process.loadEnvFile(join(root, ".env.test"));
const restoredURL = new URL(process.env.ROOTSET_TEST_DATABASE_URL);
if (
  !["localhost", "127.0.0.1"].includes(restoredURL.hostname) ||
  restoredURL.port !== (process.env.ROOTSET_RECOVERY_SOURCE_PORT ?? "55468")
)
  throw new Error("Use the authorized Rootset fixture configuration");
restoredURL.port = String(report.restoredPort ?? 55469);
const pool = new Pool({ connectionString: restoredURL.toString(), max: 1 });
const require = createRequire(join(root, "packages/core/package.json"));
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const client = new S3Client({
  endpoint: process.env.ROOTSET_S3_ENDPOINT,
  region: process.env.ROOTSET_S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.ROOTSET_S3_ACCESS_KEY,
    secretAccessKey: process.env.ROOTSET_S3_SECRET_KEY,
  },
});
const destination = join(directory, "objects");
await mkdir(destination, { mode: 0o700 });
const objects = [];
try {
  const artifacts = (
    await pool.query(
      "SELECT id,org_id,purpose,object_key,byte_length,ciphertext_length,checksum,ciphertext_checksum,encryption_key_id,iv,tag FROM rootset_control.artifacts WHERE state='ready' ORDER BY id",
    )
  ).rows;
  if (!artifacts.length)
    throw new Error("Recovery requires a nonempty referenced object set");
  for (const artifact of artifacts) {
    const name = createHash("sha256").update(artifact.object_key).digest("hex");
    const path = join(destination, name);
    const response = await client.send(
      new GetObjectCommand({
        Bucket: process.env.ROOTSET_S3_BUCKET,
        Key: artifact.object_key,
      }),
    );
    if (!response.Body)
      throw new Error("A referenced artifact object is missing");
    await pipeline(
      response.Body,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    const key = Buffer.from(keys[artifact.encryption_key_id] ?? "", "hex");
    if (key.length !== 32)
      throw new Error("A retained artifact encryption key is unavailable");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(artifact.iv, "base64"),
    );
    decipher.setAAD(
      Buffer.from(`${artifact.org_id}:${artifact.id}:${artifact.purpose}`),
    );
    decipher.setAuthTag(Buffer.from(artifact.tag, "base64"));
    const cipherHash = createHash("sha256"),
      plainHash = createHash("sha256");
    let cipherBytes = 0,
      plainBytes = 0;
    const ciphertext = new Transform({
      transform(chunk, _, done) {
        cipherBytes += chunk.length;
        cipherHash.update(chunk);
        done(null, chunk);
      },
    });
    const plaintext = new Writable({
      write(chunk, _, done) {
        plainBytes += chunk.length;
        plainHash.update(chunk);
        done();
      },
    });
    await pipeline(createReadStream(path), ciphertext, decipher, plaintext);
    const ciphertextSha256 = cipherHash.digest("hex"),
      plaintextSha256 = plainHash.digest("hex");
    if (
      ciphertextSha256 !== artifact.ciphertext_checksum ||
      plaintextSha256 !== artifact.checksum ||
      BigInt(cipherBytes) !== BigInt(artifact.ciphertext_length) ||
      BigInt(plainBytes) !== BigInt(artifact.byte_length)
    )
      throw new Error("Restored object integrity comparison failed");
    objects.push({
      artifactId: artifact.id,
      objectKey: artifact.object_key,
      localFile: name,
      ciphertextSha256,
      plaintextSha256,
      cipherBytes,
      plainBytes,
      keyId: artifact.encryption_key_id,
    });
  }
  await writeFile(
    join(directory, "object-manifest.json"),
    JSON.stringify(
      { bucket: process.env.ROOTSET_S3_BUCKET, artifacts: objects },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  report.objects = {
    required: artifacts.length,
    copied: objects.length,
    ciphertextAndPlaintextVerified: true,
    plaintextWrittenToDisk: false,
  };
  report.objectRecoveryCompletedAt = new Date().toISOString();
  report.limitations = report.limitations.filter(
    (value) => !value.includes("matching object-copy"),
  );
  report.status =
    report.protectedOutbox.unavailable === 0
      ? "installation_recovery_verified"
      : "protected_key_gap";
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      event: report.status,
      requiredObjects: artifacts.length,
      verifiedObjects: objects.length,
      keyIds: report.keyIds,
    }),
  );
  if (report.status !== "installation_recovery_verified") process.exitCode = 1;
} catch (error) {
  report.objectRecoveryFailure = error.message;
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.error(
    "Object/key recovery failed; the protected report identifies the stage.",
  );
  process.exitCode = 1;
} finally {
  client.destroy();
  await pool.end();
}
