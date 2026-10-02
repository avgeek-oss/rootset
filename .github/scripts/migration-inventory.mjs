import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function candidateMigrationInventory(root, sourceManifest) {
  const directory = resolve(root, "packages/database/migrations");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(names.length > 0, "Candidate migration inventory is empty");
  const entries = await Promise.all(
    names.map(async (name) => {
      assert.match(name, /^\d{3}_[a-z0-9_]+\.sql$/);
      const path = resolve(directory, name);
      assert.ok(
        (await lstat(path)).isFile(),
        "Migration must be a regular file",
      );
      return {
        name,
        digest: createHash("sha256")
          .update(await readFile(path, "utf8"))
          .digest("hex"),
      };
    }),
  );
  if (sourceManifest) {
    const recorded = sourceManifest.files
      .filter(
        (entry) =>
          entry.path.startsWith("packages/database/migrations/") &&
          entry.path.endsWith(".sql"),
      )
      .map((entry) => ({
        name: entry.path.slice("packages/database/migrations/".length),
        digest: entry.sha256,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    assert.deepEqual(
      entries,
      recorded,
      "Candidate migrations differ from the bound source manifest",
    );
  }
  return {
    entries,
    count: entries.length,
    last: entries.at(-1).name,
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}

export function assertMigrationLedger(actual, expected) {
  assert.deepEqual(
    actual,
    expected.entries,
    "Installed migration ledger differs from the candidate SQL filenames and byte digests",
  );
}
