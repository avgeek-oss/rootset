import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  writeBackupPackage,
  decryptBackupPackage,
  inspectBackupArchive,
  backupFileChecksum,
  type BackupManifest,
} from "./format.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
const manifest = (): BackupManifest => ({
  format: "rootset.database-backup",
  formatVersion: 1,
  rootsetVersion: "0.1.7",
  databaseId: "source-db",
  orgId: "source-org",
  snapshotAt: "2026-10-15T00:00:00.000Z",
  scheduledAt: "2026-10-15T00:00:00.000Z",
  tables: [],
  files: [],
});
const content = (value: string) =>
  (async function* () {
    yield value;
  })();
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rootset-backup-format-"));
  temporary.push(directory);
  return {
    directory,
    path: join(directory, "backup.rootset-backup"),
    key: randomBytes(32),
    archive: join(directory, "backup.zip"),
  };
}
describe("self-contained backup format", () => {
  it("authenticates and verifies a ZIP64 archive without the original database or artifact records", async () => {
    const f = await fixture();
    const info = manifest();
    const result = await writeBackupPackage({
      path: f.path,
      key: f.key,
      manifest: info,
      check: async () => {},
      entries: [
        {
          name: "rows.ndjson",
          content: content(
            '{"text":"00123","empty":"","null":null,"nested":{"n":3}}\n',
          ),
        },
      ],
    });
    expect(result.checksum).toBe(await backupFileChecksum(f.path));
    expect((await readFile(f.path)).includes(Buffer.from("00123"))).toBe(false);
    await decryptBackupPackage(f.path, f.archive, f.key);
    const recovered = await inspectBackupArchive(f.archive);
    expect(recovered).toEqual(info);
    expect(recovered.files[0]!.bytes).toBeGreaterThan(0);
  });
  it("rejects the wrong key, altered headers, corrupted ciphertext and truncation", async () => {
    const f = await fixture();
    await writeBackupPackage({
      path: f.path,
      key: f.key,
      manifest: manifest(),
      check: async () => {},
      entries: [
        { name: "data.json", content: content('{"value":"sensitive"}') },
      ],
    });
    await expect(
      decryptBackupPackage(f.path, f.archive, randomBytes(32)),
    ).rejects.toThrow();
    const original = await readFile(f.path);
    for (const [name, bytes] of [
      ["truncated", original.subarray(0, 30)],
      ["ciphertext", Buffer.from(original)],
      ["header", Buffer.from(original)],
    ] as const) {
      if (name === "ciphertext")
        bytes[bytes.length - 30] = bytes[bytes.length - 30]! ^ 1;
      if (name === "header") bytes[0] = 0;
      const path = join(f.directory, name);
      await writeFile(path, bytes);
      await expect(
        decryptBackupPackage(path, join(f.directory, `${name}.zip`), f.key),
      ).rejects.toThrow();
    }
  });
  it("enforces spool limits and propagates source/authority failures", async () => {
    const f = await fixture();
    await expect(
      writeBackupPackage({
        path: f.path,
        key: f.key,
        manifest: manifest(),
        entries: [],
        check: async () => {},
        maxBytes: 5,
      }),
    ).rejects.toThrow(/size limit/);
    await expect(
      writeBackupPackage({
        path: join(f.directory, "cancelled"),
        key: f.key,
        manifest: manifest(),
        entries: [{ name: "rows.ndjson", content: content("data") }],
        check: async () => {
          throw new Error("authority revoked");
        },
      }),
    ).rejects.toThrow(/authority revoked/);
  });
});
