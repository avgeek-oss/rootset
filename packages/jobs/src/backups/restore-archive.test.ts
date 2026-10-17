import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FieldDefinition, JsonValue } from "@rootset/contracts";
import {
  writeBackupPackage,
  decryptBackupPackage,
  type BackupManifest,
} from "./format.js";
import { openRestoreArchive } from "./restore-archive.js";
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
const databaseId = "01J00000000000000000000001",
  orgId = "01J00000000000000000000002",
  tableId = "01J00000000000000000000003",
  rowId = "01J00000000000000000000004";
const ruleId = "01J00000000000000000000030",
  keyId = "01J00000000000000000000031";
const stamp = "2026-10-17T09:41:49.123456Z";
const digest = "a".repeat(64),
  migration = "0001_baseline.sql";
const fields: FieldDefinition[] = [
  {
    id: "01J00000000000000000000010",
    name: "CODE",
    type: "text",
    required: true,
    charLimit: 100,
  },
  {
    id: "01J00000000000000000000011",
    name: "LINK",
    type: "text",
    charLimit: 100,
  },
  { id: "01J00000000000000000000012", name: "COUNT", type: "integer" },
  { id: "01J00000000000000000000013", name: "ENABLED", type: "boolean" },
  {
    id: "01J00000000000000000000014",
    name: "NOTE",
    type: "text",
    charLimit: 100,
  },
  {
    id: "01J00000000000000000000015",
    name: "FLOAT",
    type: "float",
    default: 1e100,
  },
  { id: "01J00000000000000000000016", name: "PAYLOAD", type: "json" },
  {
    id: "01J00000000000000000000017",
    name: "RECORD_ID",
    type: "integer",
    required: true,
    autoIncrement: true,
    min: 1,
    max: 100,
  },
];
const values: JsonValue[] = [
  "001",
  "001",
  0,
  false,
  "",
  1e100,
  { zero: 0, missing: null, list: [false, ""] },
  1,
];
async function fixture(
  change?: (files: Map<string, string>, manifest: BackupManifest) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "rootset-restore-archive-"));
  temporary.push(directory);
  const key = randomBytes(32),
    archive = join(directory, "verified.zip"),
    encrypted = join(directory, "source.rootset-backup");
  const manifest: BackupManifest = {
    format: "rootset.database-backup",
    formatVersion: 1,
    rootsetVersion: "0.1.9",
    databaseId,
    orgId,
    snapshotAt: stamp,
    scheduledAt: stamp,
    tables: [{ id: tableId, name: "Source", schemaVersion: 3, rowCount: 1 }],
    files: [],
  };
  const files = new Map<string, string>();
  const json = (name: string, value: unknown) =>
    files.set(name, JSON.stringify(value));
  json("database.json", {
    id: databaseId,
    org_id: orgId,
    name: "Database",
    description: "",
    state: "active",
    created_at: stamp,
    updated_at: stamp,
  });
  json("catalog.json", [
    {
      id: tableId,
      name: "Source",
      description: "",
      state: "active",
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    },
  ]);
  json("migrations.json", [{ name: migration, digest }]);
  json("schedule.json", []);
  const base = `tables/${tableId}`;
  json(`${base}/schema.json`, {
    id: tableId,
    name: "Source",
    description: "",
    schemaVersion: 3,
    createdAt: stamp,
    updatedAt: stamp,
    fields,
  });
  json(
    `${base}/fields.json`,
    fields.map((definition, position) => ({
      id: definition.id,
      name: definition.name,
      definition,
      position,
      state: "active",
      created_at: stamp,
      deleted_at: null,
    })),
  );
  json(`${base}/unique-rules.json`, [
    {
      id: ruleId,
      name: "Code",
      field_ids: [fields[0]!.id],
      condition: null,
      strategy: "native",
      state: "active",
    },
  ]);
  json(`${base}/foreign-keys.json`, [
    {
      id: keyId,
      field_ids: [fields[1]!.id],
      referenced_table_id: tableId,
      referenced_field_ids: [fields[0]!.id],
      referenced_rule_id: ruleId,
      state: "active",
    },
  ]);
  json(`${base}/counters.json`, [{ field_id: fields[7]!.id, next_value: "2" }]);
  files.set(
    `${base}/rows.ndjson`,
    JSON.stringify({
      id: rowId,
      version: "7",
      createdAt: stamp,
      updatedAt: stamp,
      values: Object.fromEntries(
        fields.map((field, i) => [field.id, values[i]]),
      ),
    }) + "\n",
  );
  for (const name of [
    "comments",
    "mutations",
    "cell-changes",
    "resource-history",
  ])
    files.set(`history/${name}.ndjson`, "");
  files.set(
    "history/comments.ndjson",
    JSON.stringify({
      id: "01J00000000000000000000040",
      org_id: orgId,
      table_id: tableId,
      row_id: rowId,
      author_user_id: null,
      author_name_snapshot: "Prior author",
      actor: { kind: "session", id: "01J00000000000000000000041" },
      body: "Retained comment",
      created_at: stamp,
      deleted_at: null,
    }) + "\n",
  );
  change?.(files, manifest);
  await writeBackupPackage({
    path: encrypted,
    key,
    manifest,
    check: async () => {},
    minimumFreeBytes: 0,
    entries: [...files].map(([name, content]) => ({
      name,
      content: (async function* () {
        yield content;
      })(),
    })),
  });
  await decryptBackupPackage(encrypted, archive, key);
  return {
    path: archive,
    orgId,
    databaseId,
    maximumBytes: 32 * 1024 ** 2,
    migrations: new Map([[migration, digest]]),
    check: async () => {},
  };
}
describe("verified restore archive", () => {
  it("validates schemas and self references while streaming typed values and exact record metadata", async () => {
    const archive = await openRestoreArchive(await fixture());
    try {
      expect(archive.source.tables).toHaveLength(1);
      expect(archive.source.tables[0]!.foreignKeys[0]!.referencedTableId).toBe(
        tableId,
      );
      const rows = [];
      for await (const batch of archive.source.rows(tableId))
        rows.push(...batch);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.version).toBe("7");
      expect(rows[0]!.createdAt).toBe(stamp);
      expect(rows[0]!.values).toEqual(
        Object.fromEntries(fields.map((field, i) => [field.id, values[i]])),
      );
      const comments = [];
      for await (const batch of archive.source.history("comments"))
        comments.push(...batch);
      expect(comments[0]!.value.body).toBe("Retained comment");
      expect(comments[0]!.value.created_at).toBe(stamp);
    } finally {
      archive.close();
    }
  });
  it("preserves historical high-water marks when generation was disabled or the field was converted", async () => {
    const archive = await openRestoreArchive(
      await fixture((files) =>
        files.set(
          `tables/${tableId}/counters.json`,
          JSON.stringify([
            { field_id: fields[7]!.id, next_value: "2" },
            { field_id: fields[2]!.id, next_value: "23" },
            { field_id: fields[4]!.id, next_value: "27" },
          ]),
        ),
      ),
    );
    try {
      expect(
        archive.source.tables[0]!.counters.map((counter) => counter.nextValue),
      ).toEqual(["2", "23", "27"]);
    } finally {
      archive.close();
    }
  });
  it("rejects incompatible migrations, inconsistent schemas and broken constraint metadata", async () => {
    const mutateJson = (
      files: Map<string, string>,
      path: string,
      change: (value: Record<string, unknown>) => void,
    ) => {
      const value: unknown = JSON.parse(files.get(path)!);
      change(
        (Array.isArray(value) ? value[0] : value) as Record<string, unknown>,
      );
      files.set(path, JSON.stringify(value));
    };
    const changes: [string, (files: Map<string, string>) => void][] = [
      [
        "migration",
        (files) =>
          mutateJson(files, "migrations.json", (value) => {
            value.digest = "b".repeat(64);
          }),
      ],
      [
        "schema",
        (files) =>
          mutateJson(files, `tables/${tableId}/schema.json`, (value) => {
            value.name = "Wrong";
          }),
      ],
      [
        "fields",
        (files) =>
          mutateJson(files, `tables/${tableId}/fields.json`, (value) => {
            (value.definition as Record<string, unknown>).name = "Wrong";
          }),
      ],
      [
        "counter",
        (files) => files.set(`tables/${tableId}/counters.json`, "[]"),
      ],
      [
        "target",
        (files) =>
          mutateJson(files, `tables/${tableId}/foreign-keys.json`, (value) => {
            value.referenced_table_id = rowId;
          }),
      ],
      ["file", (files) => files.set("unexpected.json", "{}")],
    ];
    for (const [name, change] of changes)
      await expect(
        openRestoreArchive(await fixture(change)),
        name,
      ).rejects.toThrow();
  });
  it("rejects unsafe integer lexemes and missing record values without losing valid large floats", async () => {
    for (const change of [
      (text: string) =>
        text.replace(
          `"${fields[2]!.id}":0`,
          `"${fields[2]!.id}":9007199254740993`,
        ),
      (text: string) => text.replace(`,"${fields[7]!.id}":1`, ""),
    ]) {
      const archive = await openRestoreArchive(
        await fixture((files) => {
          const name = `tables/${tableId}/rows.ndjson`;
          files.set(name, change(files.get(name)!));
        }),
      );
      try {
        await expect(
          (async () => {
            for await (const batch of archive.source.rows(tableId)) void batch;
          })(),
        ).rejects.toThrow();
      } finally {
        archive.close();
      }
    }
  });
});
