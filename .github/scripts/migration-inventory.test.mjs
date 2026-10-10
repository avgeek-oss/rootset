import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertMigrationLedger,
  candidateMigrationInventory,
} from "./migration-inventory.mjs";

const digest = (source) => createHash("sha256").update(source).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rootset-migration-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "packages/database/migrations");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "0001_baseline.sql"), "SELECT 1;\n");
  await writeFile(join(directory, "README.md"), "Not a SQL migration\n");
  return { root, directory };
}

test("inventory hashes exact SQL bytes and derives the candidate boundary", async (t) => {
  const { root, directory } = await fixture(t);
  const before = await candidateMigrationInventory(root);
  assert.deepEqual(before.entries, [
    { name: "0001_baseline.sql", digest: digest("SELECT 1;\n") },
  ]);
  assert.equal(before.count, 1);
  assert.equal(before.last, "0001_baseline.sql");
  await writeFile(join(directory, "0002_extra.sql"), "SELECT 2;\n");
  await assert.rejects(candidateMigrationInventory(root));
  await rm(join(directory, "0002_extra.sql"));
  await writeFile(join(directory, "0001_baseline.sql"), "SELECT 1;\r\n");
  const changed = await candidateMigrationInventory(root);
  assert.notEqual(changed.entries[0].digest, before.entries[0].digest);
});

test("ledger rejects missing, extra, wrong-hash and duplicate entries", async (t) => {
  const { root } = await fixture(t);
  const expected = await candidateMigrationInventory(root);
  assertMigrationLedger(structuredClone(expected.entries), expected);
  const invalid = [
    expected.entries.slice(0, -1),
    [...expected.entries, { name: "999_extra.sql", digest: digest("extra") }],
    expected.entries.map((entry, index) =>
      index === 0 ? { ...entry, digest: digest("changed") } : entry,
    ),
    [...expected.entries, expected.entries[0]],
  ];
  for (const ledger of invalid)
    assert.throws(() => assertMigrationLedger(ledger, expected));
});

test("bound source manifest rejects missing, extra and edited candidate files", async (t) => {
  const { root, directory } = await fixture(t);
  const expected = await candidateMigrationInventory(root);
  const manifest = {
    files: expected.entries.map(({ name, digest }) => ({
      path: "packages/database/migrations/" + name,
      sha256: digest,
    })),
  };
  assert.deepEqual(await candidateMigrationInventory(root, manifest), expected);
  await assert.rejects(
    candidateMigrationInventory(root, { files: manifest.files.slice(0, -1) }),
  );
  await assert.rejects(
    candidateMigrationInventory(root, {
      files: [
        ...manifest.files,
        {
          path: "packages/database/migrations/999_extra.sql",
          sha256: "f".repeat(64),
        },
      ],
    }),
  );
  await writeFile(join(directory, "0001_baseline.sql"), "SELECT 2;\n");
  await assert.rejects(candidateMigrationInventory(root, manifest));
});

test("empty inventories and symlink SQL files are rejected", async (t) => {
  const { root, directory } = await fixture(t);
  await rm(join(directory, "0001_baseline.sql"));
  await assert.rejects(candidateMigrationInventory(root));
  await symlink(
    join(directory, "README.md"),
    join(directory, "0001_baseline.sql"),
  );
  await assert.rejects(candidateMigrationInventory(root));
});
