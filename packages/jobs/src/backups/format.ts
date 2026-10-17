import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { open as openZip, type Entry, type ZipFile as ZipReader } from "yauzl";
import { RootsetError } from "@rootset/contracts";

const MAGIC = Buffer.from("ROOTSET-BACKUP\n");
const TAG_BYTES = 16;
export const BACKUP_FORMAT_VERSION = 1;
export const DEFAULT_BACKUP_MAX_BYTES = 32 * 1024 ** 3;
export interface BackupEntry {
  name: string;
  content: AsyncIterable<string | Buffer>;
}
export interface BackupManifest {
  format: "rootset.database-backup";
  formatVersion: 1;
  rootsetVersion: string;
  databaseId: string;
  orgId: string;
  snapshotAt: string;
  scheduledAt: string;
  tables: {
    id: string;
    name: string;
    schemaVersion: number;
    rowCount: number;
  }[];
  files: { name: string; bytes: number; sha256: string }[];
}
export function backupKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
export async function writeBackupPackage(options: {
  path: string;
  key: Buffer;
  entries: BackupEntry[];
  manifest: BackupManifest;
  check: () => Promise<void>;
  maxBytes?: number;
  minimumFreeBytes?: number;
}) {
  if (options.key.length !== 32)
    throw new Error("Backup encryption requires a 32-byte key");
  const maxBytes = options.maxBytes ?? DEFAULT_BACKUP_MAX_BYTES;
  if (maxBytes > 63 * 1024 ** 3 || maxBytes < 1)
    throw new Error(
      "Backup packages must fit within the AES-GCM message limit",
    );
  const nonce = randomBytes(12);
  const metadata = Buffer.from(
    JSON.stringify({
      format: "rootset.database-backup",
      formatVersion: BACKUP_FORMAT_VERSION,
      archive: "zip64",
      cipher: "aes-256-gcm",
      keyId: backupKeyId(options.key),
      nonce: nonce.toString("base64"),
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(metadata.length);
  const header = Buffer.concat([MAGIC, length, metadata]);
  const cipher = createCipheriv("aes-256-gcm", options.key, nonce);
  cipher.setAAD(header);
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const sources: Readable[] = [];
  const names = new Set<string>();
  for (const entry of options.entries) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(entry.name) ||
      entry.name.split("/").includes("..") ||
      entry.name.startsWith("/") ||
      names.has(entry.name) ||
      entry.name === "manifest.json"
    )
      throw new Error(
        "Backup archive entry names must be unique relative paths",
      );
    names.add(entry.name);
    async function* content() {
      const hash = createHash("sha256");
      let bytes = 0;
      await options.check();
      for await (const value of entry.content) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
      options.manifest.files.push({
        name: entry.name,
        bytes,
        sha256: hash.digest("hex"),
      });
    }
    const source = Readable.from(content());
    sources.push(source);
    source.on("error", (error) => output.destroy(error));
    zip.addReadStream(source, entry.name, { forceZip64Format: true });
  }
  async function* manifestContent() {
    yield JSON.stringify(options.manifest);
  }
  zip.addReadStream(Readable.from(manifestContent()), "manifest.json", {
    forceZip64Format: true,
  });
  zip.on("error", (error) => output.destroy(error));
  zip.end({ forceZip64Format: true, comment: "" });
  const hash = createHash("sha256");
  let bytes = 0;
  let checkedBytes = -Infinity;
  const meter = new Transform({
    async transform(chunk: Buffer, _encoding, callback) {
      try {
        bytes += chunk.length;
        if (bytes > maxBytes)
          throw new RootsetError(
            "PAYLOAD_TOO_LARGE",
            "The backup exceeds the worker's configured package size limit",
            413,
          );
        if (bytes - checkedBytes >= 8 * 1024 ** 2) {
          await options.check();
          const disk = await statfs(dirname(options.path));
          if (
            disk.bavail * disk.bsize <
            (options.minimumFreeBytes ?? 1024 ** 3) + chunk.length
          )
            throw new RootsetError(
              "UPSTREAM_UNAVAILABLE",
              "The backup spool has insufficient free disk space",
              503,
            );
          checkedBytes = bytes;
        }
        hash.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  async function* encrypted() {
    yield header;
    for await (const chunk of output) yield cipher.update(chunk as Buffer);
    yield cipher.final();
    yield cipher.getAuthTag();
  }
  try {
    await pipeline(
      Readable.from(encrypted()),
      meter,
      createWriteStream(options.path, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    output.destroy();
    for (const source of sources) source.destroy();
    throw error;
  }
  return {
    bytes,
    checksum: hash.digest("hex"),
    keyId: backupKeyId(options.key),
  };
}

/** Internal format reader for recovery rehearsals; no restore operation is exposed. */
export async function decryptBackupPackage(
  source: string,
  destination: string,
  key: Buffer,
  options: { check?: () => Promise<void> } = {},
): Promise<void> {
  const file = await open(source, "r");
  let header: Buffer;
  let parsed: { keyId: string; nonce: string };
  let offset: number;
  let size: number;
  let tag: Buffer;
  try {
    size = (await file.stat()).size;
    const prefix = Buffer.alloc(MAGIC.length + 4);
    await file.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("Unrecognised Rootset backup");
    const length = prefix.readUInt32BE(MAGIC.length);
    if (
      length < 1 ||
      length > 4096 ||
      size < prefix.length + length + TAG_BYTES
    )
      throw new Error("Truncated backup header");
    const body = Buffer.alloc(length);
    await file.read(body, 0, length, prefix.length);
    const value = JSON.parse(body.toString("utf8"));
    if (
      value.format !== "rootset.database-backup" ||
      value.formatVersion !== 1 ||
      value.archive !== "zip64" ||
      value.cipher !== "aes-256-gcm" ||
      value.keyId !== backupKeyId(key) ||
      typeof value.nonce !== "string" ||
      Buffer.from(value.nonce, "base64").length !== 12
    )
      throw new Error("Unsupported backup format or incorrect encryption key");
    parsed = value;
    header = Buffer.concat([prefix, body]);
    offset = header.length;
    tag = Buffer.alloc(TAG_BYTES);
    await file.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await file.close();
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parsed.nonce, "base64"),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await options.check?.();
  const target = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  let created = false;
  target.once("open", () => {
    created = true;
  });
  let checkedBytes = 0;
  const checked = new Transform({
    async transform(chunk: Buffer, _encoding, callback) {
      try {
        checkedBytes += chunk.length;
        if (checkedBytes >= 8 * 1024 ** 2) {
          await options.check?.();
          checkedBytes = 0;
        }
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  try {
    await pipeline(
      createReadStream(source, { start: offset, end: size - TAG_BYTES - 1 }),
      checked,
      decipher,
      target,
    );
    await options.check?.();
  } catch (error) {
    if (created) await rm(destination, { force: true });
    throw error;
  }
}

export async function inspectBackupArchive(
  path: string,
  maxBytes = DEFAULT_BACKUP_MAX_BYTES,
  options: { maxEntries?: number; check?: () => Promise<void> } = {},
): Promise<BackupManifest> {
  const zip = await new Promise<ZipReader>((resolve, reject) =>
    openZip(path, { lazyEntries: true }, (error, value) =>
      error ? reject(error) : resolve(value!),
    ),
  );
  const files = new Map<string, { bytes: number; sha256: string }>();
  let manifest: BackupManifest | undefined;
  let total = 0;
  try {
    for await (const entry of backupArchiveEntries(zip)) {
      await options.check?.();
      if (
        files.size >= (options.maxEntries ?? 100_000) ||
        files.has(entry.fileName) ||
        entry.fileName.endsWith("/") ||
        entry.uncompressedSize > maxBytes
      )
        throw new Error("Invalid backup entry");
      const stream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(entry, (error, value) =>
          error ? reject(error) : resolve(value!),
        ),
      );
      const hash = createHash("sha256");
      let bytes = 0;
      const chunks: Buffer[] = [];
      let checkedBytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        checkedBytes += chunk.length;
        if (checkedBytes >= 8 * 1024 ** 2) {
          await options.check?.();
          checkedBytes = 0;
        }
        total += chunk.length;
        if (total > maxBytes)
          throw new Error("Backup archive exceeds the inspection budget");
        hash.update(chunk);
        if (entry.fileName === "manifest.json") {
          if (bytes > 8 * 1024 ** 2)
            throw new Error("Backup manifest is too large");
          chunks.push(chunk);
        }
      }
      if (entry.fileName === "manifest.json")
        manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      files.set(entry.fileName, { bytes, sha256: hash.digest("hex") });
    }
    if (
      !manifest ||
      manifest.format !== "rootset.database-backup" ||
      manifest.formatVersion !== 1 ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== files.size - 1
    )
      throw new Error("Incomplete or unsupported backup manifest");
    const expectedNames = new Set<string>();
    for (const entry of manifest.files) {
      const actual = files.get(entry.name);
      if (
        expectedNames.has(entry.name) ||
        entry.name === "manifest.json" ||
        !actual ||
        actual.bytes !== entry.bytes ||
        actual.sha256 !== entry.sha256
      )
        throw new Error("Backup content checksum mismatch");
      expectedNames.add(entry.name);
    }
    return manifest;
  } finally {
    zip.close();
  }
}
export async function* backupArchiveEntries(
  zip: ZipReader,
): AsyncGenerator<Entry> {
  for (;;) {
    const entry = await new Promise<Entry | undefined>((resolve, reject) => {
      const onEntry = (value: Entry) => {
        cleanup();
        resolve(value);
      };
      const onEnd = () => {
        cleanup();
        resolve(undefined);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        zip.off("entry", onEntry);
        zip.off("end", onEnd);
        zip.off("error", onError);
      };
      zip.once("entry", onEntry);
      zip.once("end", onEnd);
      zip.once("error", onError);
      zip.readEntry();
    });
    if (!entry) return;
    yield entry;
  }
}
export async function backupFileChecksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
