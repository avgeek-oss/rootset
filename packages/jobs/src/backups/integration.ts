import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as openZip } from "yauzl";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { withOrg } from "@rootset/database";
import {
  newId,
  RootsetError,
  RestorePreviewSchema,
  DatabaseRestoreResultSchema,
  BackupPolicyResultSchema,
  type Actor,
  type BackupScheduleResult,
  type DatabaseBackup,
  type FieldDefinition,
  type Row,
  type UniqueRuleCondition,
} from "@rootset/contracts";
import {
  TableStorage,
  restoredId,
  type TableRecord,
} from "@rootset/table-storage";
import { fieldColumn } from "../../../table-storage/src/query.js";
import { EmailOutbox, enqueueBackupAlert } from "../../../email/src/index.js";
import { MetadataPaging } from "../../../core/src/paging.js";
import { isolatedDatabase } from "../../../../tools/verification/isolated-database.js";
import { JobsService } from "../index.js";
import type { JobsConfig, JobRecord } from "../types.js";
import { decryptBackupPackage, inspectBackupArchive } from "./format.js";

const fixture = await isolatedDatabase();
const { owner, app, ddl } = fixture;
const orgId = newId();
const actor: Actor = {
  kind: "session",
  id: newId(),
  orgId,
  role: "admin",
  scopes: [],
};
const emailOutbox = new EmailOutbox(app, {
  encryptionKey: randomBytes(32).toString("base64"),
  baseURL: "https://rootset.test",
  smtp: {
    host: process.env.ROOTSET_SMTP_HOST ?? "127.0.0.1",
    port: Number(process.env.ROOTSET_SMTP_PORT ?? 11025),
    secure: process.env.ROOTSET_SMTP_SECURE === "true",
    from: "Rootset <backups@rootset.test>",
  },
});
const key = randomBytes(32);
const prefix = `rootset-backup-integration/${newId()}`;
const storage = new TableStorage({
  pool: app,
  ddlPool: ddl,
  cursorSecret: randomBytes(32).toString("hex"),
});
let authorized = true;
let hook: JobsConfig["failpoint"];
const config: JobsConfig = {
  notifyBackupAdministrators: (client, alert) =>
    enqueueBackupAlert(client, emailOutbox, alert, "https://rootset.test"),
  backupNotificationsAvailable: true,
  idempotencySecret: randomBytes(32).toString("hex"),
  metadataPaging: new MetadataPaging(randomBytes(32).toString("hex")),
  rootsetVersion: "0.1.7",
  artifacts: {
    endpoint: process.env.ROOTSET_S3_ENDPOINT,
    region: "us-east-1",
    bucket: process.env.ROOTSET_S3_BUCKET!,
    accessKeyId: process.env.ROOTSET_S3_ACCESS_KEY!,
    secretAccessKey: process.env.ROOTSET_S3_SECRET_KEY!,
    encryptionKey: randomBytes(32),
  },
  backups: {
    endpoint: process.env.ROOTSET_S3_ENDPOINT!,
    region: "us-east-1",
    accessKeyId: process.env.ROOTSET_S3_ACCESS_KEY!,
    secretAccessKey: process.env.ROOTSET_S3_SECRET_KEY!,
    encryptionKey: key,
  },
  failpoint: async (point, id) => hook?.(point, id),
};
const options = {
  pool: app,
  ddlPool: ddl,
  storage,
  config,
  authorise: async (value: Actor) => {
    if (!authorized)
      throw new RootsetError("ACCESS_DENIED", "Backup authority revoked", 403);
    return value;
  },
};
const jobs = new JobsService(options);
const disabled = new JobsService({
  ...options,
  config: { ...config, backups: undefined },
});
const objects = new S3Client({
  endpoint: config.backups!.endpoint,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.backups!.accessKeyId,
    secretAccessKey: config.backups!.secretAccessKey,
  },
});
const temporary = await mkdtemp(join(tmpdir(), "rootset-backup-rehearsal-"));
const workerId = newId();
let databaseId: string;
let parent: TableRecord;
let child: TableRecord;
let parentRow: Row;
let childRow: Row;
let parentRuleId: string;
const bucket = config.artifacts.bucket;
const execute = (
  operation: string,
  input: Record<string, unknown> = {},
  idempotencyKey = newId(),
  a = actor,
) =>
  jobs.backups.execute(
    operation,
    a,
    { orgId, databaseId, ...input },
    { idempotencyKey },
  );
async function schedule() {
  return (await execute("getBackupSchedule")) as BackupScheduleResult;
}
async function save() {
  const current = await schedule();
  const accepted = (await execute("saveBackupSchedule", {
    bucket,
    prefix,
    cron: "* * * * *",
    timezone: "UTC",
    expectedVersion: current.version,
  })) as { jobId: string };
  const result = await terminal(accepted.jobId);
  assert.equal(result.state, "succeeded", JSON.stringify(result.error));
  return schedule();
}
async function removeSchedule() {
  const current = await schedule();
  return (await execute("deleteBackupSchedule", {
    expectedVersion: current.version,
  })) as BackupScheduleResult;
}
async function terminal(id: string) {
  for (let index = 0; index < 6; index++) {
    await jobs.runOnce(orgId);
    const row = (
      await owner.query<JobRecord>(
        "SELECT * FROM rootset_control.jobs WHERE id=$1",
        [id],
      )
    ).rows[0]!;
    if (!["queued", "running"].includes(row.state)) return row;
    await owner.query(
      "UPDATE rootset_control.jobs SET next_attempt_at=now() WHERE id=$1",
      [id],
    );
  }
  throw new Error("Backup job did not terminate");
}
async function queueBackup() {
  return (await execute("runDatabaseBackup")) as { jobId: string };
}
async function archivedFiles(path: string) {
  const files = new Map<string, Buffer>();
  let bytes = 0;
  await new Promise<void>((resolve, reject) =>
    openZip(path, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip!.on("error", reject);
      zip!.on("end", resolve);
      zip!.on("entry", (entry) => {
        zip!.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks: Buffer[] = [];
          stream!.on("error", reject);
          stream!.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 8 * 1024 ** 2) {
              stream!.destroy(new Error("Rehearsal archive too large"));
              return;
            }
            chunks.push(chunk);
          });
          stream!.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip!.readEntry();
          });
        });
      });
      zip!.readEntry();
    }),
  );
  return files;
}
before(async () => {
  await owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Backup verification')",
    [orgId],
  );
  databaseId = (
    await storage.createDatabase(actor, {
      name: "Backup source",
      description: "Full logical database snapshot",
    })
  ).id;
  parent = await storage.createTable(actor, databaseId, {
    name: "Parents",
    fields: [
      {
        name: "RECORD_ID",
        type: "integer",
        required: true,
        autoIncrement: true,
      },
      {
        name: "CODE",
        type: "text",
        required: true,
        allowedValues: ["ALPHA", "BETA"],
      },
    ],
  });
  parentRuleId = (
    await storage.createUniqueRule(actor, parent.id, {
      fieldIds: [parent.fields[0]!.id],
      expectedSchemaVersion: parent.schemaVersion,
    })
  ).id;
  parent = await storage.getTable(actor, parent.id);
  await storage.createUniqueRule(actor, parent.id, {
    fieldIds: [parent.fields[1]!.id],
    where: { field: parent.fields[1]!.id, op: "eq", value: "ALPHA" },
    expectedSchemaVersion: parent.schemaVersion,
  });
  parent = await storage.getTable(actor, parent.id);
  parentRow = await storage.createRow(actor, parent.id, { CODE: "ALPHA" });
  const high = await storage.createRow(actor, parent.id, {
    RECORD_ID: 9000,
    CODE: "BETA",
  });
  await storage.deleteRow(actor, parent.id, high.id, {
    expectedVersion: high.version,
  });
  child = await storage.createTable(actor, databaseId, {
    name: "Children",
    fields: [
      { name: "REF", type: "integer" },
      { name: "LABEL", type: "text" },
      { name: "NOTES", type: "text", charLimit: 2000 },
      { name: "EMPTY", type: "text", default: "" },
      { name: "NIL", type: "text" },
      { name: "ACTIVE", type: "boolean" },
      { name: "VALUE", type: "float" },
      { name: "DAY", type: "date" },
      { name: "TIME", type: "time" },
      { name: "STAMP", type: "date-time" },
      { name: "JSON", type: "json" },
    ],
  });
  await storage.createForeignKey(actor, child.id, {
    fieldIds: [child.fields[0]!.id],
    referencedTableId: parent.id,
    referencedRuleId: parentRuleId,
    expectedSchemaVersion: child.schemaVersion,
    expectedReferencedSchemaVersion: parent.schemaVersion,
  });
  child = await storage.getTable(actor, child.id);
  childRow = await storage.createRow(actor, child.id, {
    REF: 1,
    LABEL: "00123",
    NOTES: "A long description with a newline\nand Unicode ✈",
    ACTIVE: true,
    VALUE: 0.25,
    DAY: "2026-10-15",
    TIME: "12:34:56.123Z",
    STAMP: "2026-10-15T12:34:56.123Z",
    JSON: { nested: { value: null }, empty: "", list: [1, true] },
  });
  childRow = await storage.updateRow(
    actor,
    child.id,
    childRow.id,
    { NOTES: "Before backup\nSecond line" },
    { expectedVersion: childRow.version },
  );
  await withOrg(app, orgId, async (client) => {
    await client.query(
      "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_name_snapshot,actor,body) VALUES($1,$2,$3,$4,'Backup author',$5,'**Retained** comment')",
      [newId(), orgId, child.id, childRow.id, actor],
    );
    await client.query(
      "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_name_snapshot,actor,body,deleted_at) VALUES($1,$2,$3,$4,'Backup author',$5,'',now())",
      [newId(), orgId, child.id, childRow.id, actor],
    );
  });
  await withOrg(app, orgId, (client) =>
    client.query(
      "INSERT INTO rootset_control.saved_views(id,org_id,table_id,owner_name_snapshot,name,visibility,definition,schema_version) VALUES($1,$2,$3,'Backup author','Shared backup view','shared',$4,$5)",
      [
        newId(),
        orgId,
        child.id,
        {
          frozenColumns: 0,
          columnOrder: child.fields.map((field) => field.id),
          hiddenColumns: [child.fields[1]!.id],
          columnWidths: {},
          query: { where: { field: child.fields[0]!.id, op: "eq", value: 1 } },
        },
        child.schemaVersion,
      ],
    ),
  );
  await owner.query(
    "INSERT INTO rootset_control.worker_heartbeats(id,state,backup_backend_id) VALUES($1,'ready',$2)",
    [workerId, jobs.backups.backendId],
  );
});
after(async () => {
  try {
    let token: string | undefined;
    do {
      const result = await objects.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        }),
      );
      for (const item of result.Contents ?? [])
        await objects.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }),
        );
      token = result.NextContinuationToken;
    } while (token);
  } finally {
    jobs.backups.close();
    jobs.restores.close();
    disabled.backups.close();
    disabled.restores.close();
    objects.destroy();
    await rm(temporary, { recursive: true, force: true });
    await fixture.close();
  }
});

test("saving verifies the destination atomically, normalizes prefixes, and requires current Admin authority and versions", async () => {
  assert.equal((await schedule()).schedule, null);
  await assert.rejects(
    execute("getBackupSchedule", {}, newId(), { ...actor, role: "member" }),
    /role/,
  );
  const missing = (await execute("saveBackupSchedule", {
    bucket: `missing-${newId().toLowerCase()}`,
    prefix,
    cron: "0 2 * * *",
    timezone: "UTC",
    expectedVersion: 0,
  })) as { jobId: string };
  assert.equal(
    (await schedule()).schedule,
    null,
    "a queued verification must not create a schedule",
  );
  assert.equal((await terminal(missing.jobId)).state, "failed");
  assert.equal((await schedule()).schedule, null);
  assert.equal((await schedule()).version, 0);
  const saved = await save();
  assert.equal(saved.schedule!.version, 1);
  assert.ok(saved.schedule!.testedAt);
  await assert.rejects(
    execute("saveBackupSchedule", {
      bucket,
      prefix,
      cron: "* * * * *",
      timezone: "UTC",
      expectedVersion: 0,
    }),
    /changed/,
  );
  const replayKey = newId();
  const value = {
    bucket,
    prefix: `/${prefix}/`,
    cron: "0 2 * * *",
    timezone: "Asia/Kolkata",
    expectedVersion: 1,
  };
  const queued = (await execute("saveBackupSchedule", value, replayKey)) as {
    jobId: string;
  };
  assert.deepEqual(
    queued,
    await execute("saveBackupSchedule", value, replayKey),
  );
  assert.equal(
    (await schedule()).version,
    1,
    "existing schedule is retained while verification is queued",
  );
  await assert.rejects(
    execute("saveBackupSchedule", { ...value, prefix: "different" }, replayKey),
    /different|match/,
  );
  assert.equal((await terminal(queued.jobId)).state, "succeeded");
  assert.equal((await schedule()).schedule!.prefix, prefix);
  const beforeFailure = await schedule();
  const failedUpdate = (await execute("saveBackupSchedule", {
    ...value,
    bucket: `missing-${newId().toLowerCase()}`,
    expectedVersion: beforeFailure.version,
  })) as { jobId: string };
  assert.equal((await terminal(failedUpdate.jobId)).state, "failed");
  assert.deepEqual(
    (await schedule()).schedule,
    beforeFailure.schedule,
    "failed verification must preserve the existing schedule",
  );
});

test("deleting during verification prevents a pending save from recreating the schedule and preserves backups", async () => {
  const current = await schedule();
  const pending = (await execute("saveBackupSchedule", {
    bucket,
    prefix,
    cron: "0 2 * * *",
    timezone: "UTC",
    expectedVersion: current.version,
  })) as { jobId: string };
  hook = async (point) => {
    if (point === "backup.afterDestinationVerified") await removeSchedule();
  };
  const outcome = await terminal(pending.jobId);
  hook = undefined;
  assert.equal(outcome.state, "cancelled");
  const removed = await schedule();
  assert.equal(removed.schedule, null);
  assert.equal(removed.version, current.version + 1);
  assert.equal(removed.pendingSaveJobId, null);
  assert.ok(
    (
      await owner.query(
        "SELECT 1 FROM rootset_control.database_backups WHERE database_id=$1",
        [databaseId],
      )
    ).rowCount,
  );
  await assert.rejects(
    execute("saveBackupSchedule", {
      bucket,
      prefix,
      cron: "0 2 * * *",
      timezone: "UTC",
      expectedVersion: current.version,
    }),
    /changed/,
  );
  const recreated = await save();
  assert.equal(recreated.version, removed.version + 1);
});

test("consistent full packages reconstruct rows, rules, counters, comments and history in a new database", async () => {
  await save();
  let changed = false;
  hook = async (point) => {
    if (point !== "backup.afterTable" || changed) return;
    changed = true;
    parentRow = await storage.updateRow(
      actor,
      parent.id,
      parentRow.id,
      { CODE: "BETA" },
      { expectedVersion: parentRow.version },
    );
    childRow = await storage.updateRow(
      actor,
      child.id,
      childRow.id,
      { LABEL: "after snapshot" },
      { expectedVersion: childRow.version },
    );
  };
  const { jobId } = await queueBackup();
  assert.equal(
    await disabled.runOnce(orgId),
    false,
    "an unconfigured worker must leave backup work queued",
  );
  const outcome = await terminal(jobId);
  hook = undefined;
  assert.equal(outcome.state, "succeeded", JSON.stringify(outcome.error));
  assert.equal(changed, true);
  const result = outcome.result as {
    objectKey: string;
    tableCount: number;
    rowCount: number;
  };
  assert.equal(result.tableCount, 2);
  assert.equal(result.rowCount, 2);
  const object = await objects.send(
    new GetObjectCommand({ Bucket: bucket, Key: result.objectKey }),
  );
  const encrypted = join(temporary, "snapshot.rootset-backup");
  await writeFile(encrypted, await object.Body!.transformToByteArray());
  const archive = join(temporary, "snapshot.zip");
  await decryptBackupPackage(encrypted, archive, key);
  const manifest = await inspectBackupArchive(archive);
  assert.equal(manifest.databaseId, databaseId);
  const files = await archivedFiles(archive);
  assert.equal(
    (await readFile(encrypted)).includes(Buffer.from("Retained")),
    false,
  );
  const json = <T>(name: string): T => JSON.parse(files.get(name)!.toString());
  const lines = <T>(name: string): T[] =>
    files
      .get(name)!
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const restored = await storage.createDatabase(actor, {
    name: "Reconstructed backup",
  });
  const tableMap = new Map<string, TableRecord>();
  const fieldMap = new Map<string, string>();
  const ruleMap = new Map<string, string>();
  for (const entry of manifest.tables) {
    const schema = json<{
      name: string;
      description: string;
      fields: FieldDefinition[];
    }>(`tables/${entry.id}/schema.json`);
    const definitions = schema.fields.map(({ id, ...field }) => ({
      id,
      field,
    }));
    const table = await storage.createTable(actor, restored.id, {
      name: schema.name,
      description: schema.description,
      fields: definitions.map((definition) => definition.field),
    });
    tableMap.set(entry.id, table);
    definitions.forEach((definition, index) =>
      fieldMap.set(definition.id, table.fields[index]!.id),
    );
    const rows = lines<Row>(`tables/${entry.id}/rows.ndjson`);
    await withOrg(app, orgId, async (client) => {
      const physical = `"${table.schemaName}"."${table.physicalName}"`;
      await client.query(`ALTER TABLE ${physical} DISABLE TRIGGER USER`);
      for (const row of rows) {
        const columns = [
          "row_id",
          "org_id",
          "row_version",
          "created_at",
          "updated_at",
          ...table.fields.map(fieldColumn),
        ]
          .map((name) => `"${name}"`)
          .join(",");
        const values = [
          row.id,
          orgId,
          row.version,
          row.createdAt,
          row.updatedAt,
          ...schema.fields.map((field) =>
            field.type === "json" && row.values[field.id] !== null
              ? JSON.stringify(row.values[field.id])
              : row.values[field.id],
          ),
        ];
        await client.query(
          `INSERT INTO ${physical}(${columns}) VALUES(${values.map((_, index) => `$${index + 1}`).join(",")})`,
          values,
        );
      }
      for (const row of rows) {
        const timestamps = (
          await client.query(
            `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM ${physical} WHERE row_id=$1`,
            [row.id],
          )
        ).rows[0];
        assert.equal(timestamps.created_at, row.createdAt);
        assert.equal(timestamps.updated_at, row.updatedAt);
      }
      await client.query(`ALTER TABLE ${physical} ENABLE TRIGGER USER`);
      await client.query(
        "UPDATE rootset_control.tables SET row_count=$2 WHERE id=$1",
        [table.id, rows.length],
      );
      for (const counter of json<{ field_id: string; next_value: string }[]>(
        `tables/${entry.id}/counters.json`,
      ))
        await client.query(
          "UPDATE rootset_control.integer_counters SET next_value=$2 WHERE field_id=$1",
          [fieldMap.get(counter.field_id), counter.next_value],
        );
    });
    for (const row of rows) {
      const actual = await storage.getRow(actor, table.id, row.id);
      assert.equal(actual.version, row.version);
      assert.equal(Date.parse(actual.createdAt), Date.parse(row.createdAt));
      assert.equal(Date.parse(actual.updatedAt), Date.parse(row.updatedAt));
      assert.deepEqual(
        { ...actual.values },
        Object.fromEntries(
          schema.fields.map((field) => [field.name, row.values[field.id]]),
        ),
      );
    }
  }
  const remapCondition = (
    condition: UniqueRuleCondition,
  ): UniqueRuleCondition => ({
    ...condition,
    field: fieldMap.get(condition.field)!,
  });
  for (const entry of manifest.tables)
    for (const rule of json<
      {
        id: string;
        name: string;
        field_ids: string[];
        condition: UniqueRuleCondition | null;
      }[]
    >(`tables/${entry.id}/unique-rules.json`)) {
      const table = await storage.getTable(actor, tableMap.get(entry.id)!.id);
      const created = await storage.createUniqueRule(actor, table.id, {
        name: rule.name,
        fieldIds: rule.field_ids.map((id) => fieldMap.get(id)!),
        ...(rule.condition ? { where: remapCondition(rule.condition) } : {}),
        expectedSchemaVersion: table.schemaVersion,
      });
      ruleMap.set(rule.id, created.id);
    }
  for (const entry of manifest.tables)
    for (const link of json<
      {
        field_ids: string[];
        referenced_table_id: string;
        referenced_rule_id: string;
      }[]
    >(`tables/${entry.id}/foreign-keys.json`)) {
      const table = await storage.getTable(actor, tableMap.get(entry.id)!.id);
      const target = await storage.getTable(
        actor,
        tableMap.get(link.referenced_table_id)!.id,
      );
      await storage.createForeignKey(actor, table.id, {
        fieldIds: link.field_ids.map((id) => fieldMap.get(id)!),
        referencedTableId: target.id,
        referencedRuleId: ruleMap.get(link.referenced_rule_id)!,
        expectedSchemaVersion: table.schemaVersion,
        expectedReferencedSchemaVersion: target.schemaVersion,
      });
    }
  const comments = lines<Record<string, unknown>>("history/comments.ndjson");
  assert.equal(comments.length, 2);
  assert.equal(comments.filter((comment) => comment.deleted_at).length, 1);
  const mutations = lines<Record<string, unknown>>("history/mutations.ndjson");
  const mutationMap = new Map(
    mutations.map((mutation) => [String(mutation.id), newId()]),
  );
  const changes = lines<Record<string, unknown>>("history/cell-changes.ndjson");
  const resources = lines<Record<string, unknown>>(
    "history/resource-history.ndjson",
  );
  await withOrg(app, orgId, async (client) => {
    for (const comment of comments)
      await client.query(
        "INSERT INTO rootset_control.row_comments(id,org_id,table_id,row_id,author_name_snapshot,actor,body,created_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          newId(),
          orgId,
          tableMap.get(String(comment.table_id))!.id,
          comment.row_id,
          comment.author_name_snapshot,
          comment.actor,
          comment.body,
          comment.created_at,
          comment.deleted_at,
        ],
      );
    for (const mutation of mutations)
      await client.query(
        "INSERT INTO rootset_control.mutations(id,org_id,table_id,input_hash,actor,context,schema_version,committed_at) VALUES($1,$2,$3,'recovery-rehearsal',$4,$5,$6,$7)",
        [
          mutationMap.get(String(mutation.id)),
          orgId,
          tableMap.get(String(mutation.table_id))!.id,
          mutation.actor,
          mutation.context,
          mutation.schema_version,
          mutation.committed_at,
        ],
      );
    for (const change of changes) {
      const definition = change.field_definition as Record<string, unknown>;
      await client.query(
        "INSERT INTO rootset_control.cell_changes(org_id,database_id,table_id,row_id,field_id,mutation_id,old_value,new_value,field_definition,old_version,new_version,operation,actor,context,changed_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)",
        [
          orgId,
          restored.id,
          tableMap.get(String(change.table_id))!.id,
          change.row_id,
          fieldMap.get(String(change.field_id)),
          mutationMap.get(String(change.mutation_id)),
          JSON.stringify(change.old_value),
          JSON.stringify(change.new_value),
          { ...definition, id: fieldMap.get(String(definition.id)) },
          change.old_version,
          change.new_version,
          change.operation,
          change.actor,
          change.context,
          change.changed_at,
        ],
      );
    }
    await client.query(
      "DELETE FROM rootset_control.resource_history WHERE database_id=$1",
      [restored.id],
    );
    for (const event of resources)
      await client.query(
        "INSERT INTO rootset_control.resource_history(org_id,database_id,table_id,resource_id,operation,before_value,after_value,actor,context,changed_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)",
        [
          orgId,
          restored.id,
          event.table_id ? tableMap.get(String(event.table_id))!.id : null,
          event.resource_id,
          event.operation,
          JSON.stringify(event.before_value),
          JSON.stringify(event.after_value),
          event.actor,
          event.context,
          event.changed_at,
        ],
      );
    const actual = await client.query(
      "SELECT count(*)::int AS count FROM rootset_control.cell_changes WHERE database_id=$1",
      [restored.id],
    );
    assert.equal(actual.rows[0].count, changes.length);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM rootset_control.resource_history WHERE database_id=$1",
          [restored.id],
        )
      ).rows[0].count,
      resources.length,
    );
    const restoredComments = (
      await client.query(
        "SELECT body,author_name_snapshot,deleted_at IS NOT NULL AS deleted FROM rootset_control.row_comments WHERE table_id=$1 ORDER BY body",
        [tableMap.get(child.id)!.id],
      )
    ).rows;
    assert.deepEqual(
      restoredComments,
      comments
        .map((comment) => ({
          body: comment.body,
          author_name_snapshot: comment.author_name_snapshot,
          deleted: comment.deleted_at !== null,
        }))
        .sort((a, b) => String(a.body).localeCompare(String(b.body))),
    );
  });
  const restoredParent = tableMap.get(parent.id)!;
  const restoredChild = tableMap.get(child.id)!;
  assert.equal(
    (await storage.getRow(actor, restoredParent.id, parentRow.id)).values.CODE,
    "ALPHA",
  );
  assert.equal(
    (await storage.getRow(actor, restoredChild.id, childRow.id)).values.LABEL,
    "00123",
  );
  assert.equal(
    (await storage.createRow(actor, restoredParent.id, { CODE: "BETA" })).values
      .RECORD_ID,
    9001,
  );
  await assert.rejects(
    storage.createRow(actor, restoredChild.id, { REF: 999 }),
    /reference|foreign/i,
  );
  await assert.rejects(
    storage.createRow(actor, restoredParent.id, { RECORD_ID: 1, CODE: "BETA" }),
    /unique/i,
  );
  assert.equal(
    (await storage.listForeignKeys(actor, restoredChild.id)).length,
    1,
  );
  assert.equal(
    (await storage.listUniqueRules(actor, restoredParent.id)).length,
    2,
  );
  assert.equal(
    (
      await withOrg(app, orgId, (client) =>
        client.query(
          "SELECT 1 FROM rootset_control.backup_schedules WHERE database_id=$1",
          [restored.id],
        ),
      )
    ).rowCount,
    0,
  );
});

let restoreBackupId: string, restorePreviewId: string;
const restoreRequest = (
  operation: string,
  input: Record<string, unknown>,
  key = newId(),
  value = actor,
) =>
  jobs.execute(
    operation,
    value,
    { orgId, ...input },
    { idempotencyKey: key },
  ) as Promise<{ jobId: string }>;
async function restoreAbsent(jobId: string) {
  const job = (
    await owner.query<JobRecord>(
      "SELECT * FROM rootset_control.jobs WHERE id=$1",
      [jobId],
    )
  ).rows[0]!;
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM rootset_control.databases WHERE id=$1",
        [job.input.destinationDatabaseId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1",
        [`rsd_${String(job.input.destinationDatabaseId).toLowerCase()}`],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM rootset_control.restore_results WHERE job_id=$1",
        [jobId],
      )
    ).rows[0].n,
    0,
  );
}
test("managed restore previews verify encrypted packages without writes and restore into a new database with working constraints", async () => {
  await owner.query(
    "UPDATE rootset_control.worker_heartbeats SET heartbeat_at=now() WHERE id=$1",
    [workerId],
  );
  await save();
  restoreBackupId = (await queueBackup()).jobId;
  assert.equal((await terminal(restoreBackupId)).state, "succeeded");
  const before = (
    await owner.query(
      "SELECT count(*)::int AS n FROM rootset_control.databases",
    )
  ).rows[0].n;
  const preview = await restoreRequest("previewDatabaseRestore", {
    backupId: restoreBackupId,
  });
  restorePreviewId = preview.jobId;
  assert.equal(await disabled.runOnce(orgId), false);
  const checked = await terminal(preview.jobId);
  assert.equal(checked.state, "succeeded", JSON.stringify(checked.error));
  const summary = RestorePreviewSchema.parse(checked.result);
  assert.equal(summary.tables.length, 2);
  assert.equal(summary.rowCount, 2);
  assert.equal(summary.commentCount, 2);
  assert.equal(summary.viewCount, 1);
  assert.ok(summary.historyEvents > 0);
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM rootset_control.databases",
      )
    ).rows[0].n,
    before,
  );
  const key = newId(),
    input = {
      backupId: restoreBackupId,
      previewId: preview.jobId,
      name: "Recovered via worker",
    };
  const accepted = await restoreRequest("restoreDatabaseBackup", input, key);
  assert.deepEqual(
    await restoreRequest("restoreDatabaseBackup", input, key),
    accepted,
  );
  const done = await terminal(accepted.jobId);
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  const result = DatabaseRestoreResultSchema.parse(done.result);
  assert.notEqual(result.databaseId, databaseId);
  assert.equal(result.rowCount, 2);
  assert.equal(result.viewCount, 1);
  const saved = (
    await owner.query(
      "SELECT definition FROM rootset_control.saved_views WHERE table_id=$1",
      [restoredId(result.databaseId, "table", child.id)],
    )
  ).rows[0]!;
  assert.deepEqual(saved.definition.query.where, {
    field: restoredId(result.databaseId, "field", child.fields[0]!.id),
    op: "eq",
    value: 1,
  });
  const parentId = restoredId(result.databaseId, "table", parent.id),
    childId = restoredId(result.databaseId, "table", child.id);
  const parentCopy = await storage.getRow(actor, parentId, parentRow.id),
    childCopy = await storage.getRow(actor, childId, childRow.id);
  assert.deepEqual(
    parentCopy.values,
    (await storage.getRow(actor, parent.id, parentRow.id)).values,
  );
  assert.deepEqual(
    childCopy.values,
    (await storage.getRow(actor, child.id, childRow.id)).values,
  );
  assert.equal(childCopy.version, childRow.version);
  const next = await storage.createRow(actor, parentId, { CODE: "ALPHA" });
  assert.equal(next.values.RECORD_ID, 9001);
  await assert.rejects(storage.createRow(actor, childId, { REF: 999999 }), {
    code: "FOREIGN_KEY_CONFLICT",
  });
  await assert.rejects(
    restoreRequest("restoreDatabaseBackup", input, newId(), {
      ...actor,
      role: "viewer",
    }),
    { status: 403 },
  );
  const listed = await jobs.execute("listJobs", actor, {
    orgId,
    databaseId,
    kind: "database_restore",
    limit: 100,
  });
  assert.ok(
    (listed as { data: { id: string }[] }).data.some(
      (row) => row.id === accepted.jobId,
    ),
  );
  const descending = {
    orgId,
    databaseId,
    kind: "database_restore",
    limit: 1,
    order: "desc",
  };
  const first = (await jobs.execute("listJobs", actor, descending)) as {
    data: { id: string }[];
    nextCursor: string;
  };
  assert.equal(first.data[0]!.id, accepted.jobId);
  const second = (await jobs.execute("listJobs", actor, {
    ...descending,
    cursor: first.nextCursor,
  })) as { data: { id: string }[] };
  assert.equal(second.data[0]!.id, preview.jobId);
  await assert.rejects(
    jobs.execute("listJobs", actor, {
      ...descending,
      order: "asc",
      cursor: first.nextCursor,
    }),
    { code: "CURSOR_INVALID" },
  );
});
test("restore cancellation, revoked authority, stale previews and tampered storage never expose a partial database", async () => {
  for (const mode of ["cancel", "authority"] as const) {
    const request = await restoreRequest("restoreDatabaseBackup", {
      backupId: restoreBackupId,
      previewId: restorePreviewId,
      name: `Failed ${mode}`,
    });
    let reached = false;
    hook = async (point, id) => {
      if (!reached && point === "restore.restoring_rows") {
        reached = true;
        if (mode === "cancel") await jobs.queue.cancel(actor, id);
        else authorized = false;
      }
    };
    try {
      const result = await terminal(request.jobId);
      assert.equal(reached, true);
      assert.equal(
        result.state,
        mode === "cancel" ? "cancelled" : "failed",
        JSON.stringify(result.error),
      );
      await restoreAbsent(request.jobId);
    } finally {
      hook = undefined;
      authorized = true;
    }
  }
  const preview = (
    await owner.query<JobRecord>(
      "SELECT * FROM rootset_control.jobs WHERE id=$1",
      [restorePreviewId],
    )
  ).rows[0]!;
  await owner.query(
    "UPDATE rootset_control.jobs SET result=jsonb_set(result,'{expiresAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE id=$1",
    [restorePreviewId],
  );
  await assert.rejects(
    restoreRequest("restoreDatabaseBackup", {
      backupId: restoreBackupId,
      previewId: restorePreviewId,
      name: "Expired",
    }),
    /expired/,
  );
  await owner.query("UPDATE rootset_control.jobs SET result=$2 WHERE id=$1", [
    restorePreviewId,
    preview.result,
  ]);
  const source = (
    await owner.query<{ object_key: string }>(
      "SELECT object_key FROM rootset_control.database_backups WHERE id=$1",
      [restoreBackupId],
    )
  ).rows[0]!;
  const original = await objects.send(
    new GetObjectCommand({ Bucket: bucket, Key: source.object_key }),
  );
  const bytes = await original.Body!.transformToByteArray();
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
  await objects.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: source.object_key,
      Body: damaged,
    }),
  );
  try {
    const request = await restoreRequest("restoreDatabaseBackup", {
      backupId: restoreBackupId,
      previewId: restorePreviewId,
      name: "Damaged package",
    });
    const result = await terminal(request.jobId);
    assert.equal(result.state, "failed");
    assert.match(JSON.stringify(result.error), /checksum/);
    await restoreAbsent(request.jobId);
  } finally {
    await objects.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: source.object_key,
        Body: bytes,
      }),
    );
  }
});
test("a committed restore reconciles after worker loss without duplicating data even after requester revocation", async () => {
  const request = await restoreRequest("restoreDatabaseBackup", {
    backupId: restoreBackupId,
    previewId: restorePreviewId,
    name: "Crash recovery",
  });
  let publications = 0;
  hook = async (point) => {
    if (point === "restore.afterPublish") {
      publications++;
      throw Error("Worker died after commit");
    }
  };
  try {
    await jobs.runOnce(orgId);
    assert.equal(publications, 1);
    authorized = false;
    const done = await terminal(request.jobId);
    assert.equal(done.state, "succeeded", JSON.stringify(done.error));
    assert.equal(publications, 1);
    const result = DatabaseRestoreResultSchema.parse(done.result);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM rootset_control.databases WHERE id=$1",
          [result.databaseId],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      jobs.execute("getJob", actor, { orgId, id: done.id }),
      { code: "ACCESS_DENIED" },
    );
  } finally {
    hook = undefined;
    authorized = true;
  }
});

test("restore recovers an expired staging lease and can use a backup whose source database is archived", async () => {
  const request = await restoreRequest("restoreDatabaseBackup", {
    backupId: restoreBackupId,
    previewId: restorePreviewId,
    name: "Recovered staging lease",
  });
  let expired = false;
  hook = async (point, id) => {
    if (!expired && point === "restore.creating_tables") {
      expired = true;
      await owner.query(
        "UPDATE rootset_control.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
    }
  };
  try {
    await jobs.runOnce(orgId);
    assert.equal(expired, true);
    await restoreAbsent(request.jobId);
  } finally {
    hook = undefined;
  }
  const recovered = await terminal(request.jobId);
  assert.equal(recovered.state, "succeeded", JSON.stringify(recovered.error));
  assert.equal(recovered.attempt, 2);
  await owner.query(
    "UPDATE rootset_control.databases SET state='deleted' WHERE id=$1",
    [databaseId],
  );
  try {
    const preview = await restoreRequest("previewDatabaseRestore", {
      backupId: restoreBackupId,
    });
    assert.equal((await terminal(preview.jobId)).state, "succeeded");
    const archived = await restoreRequest("restoreDatabaseBackup", {
      backupId: restoreBackupId,
      previewId: preview.jobId,
      name: "Archived source recovery",
    });
    const result = await terminal(archived.jobId);
    assert.equal(result.state, "succeeded", JSON.stringify(result.error));
    assert.equal(
      DatabaseRestoreResultSchema.parse(result.result).sourceDatabaseId,
      databaseId,
    );
  } finally {
    await owner.query(
      "UPDATE rootset_control.databases SET state='active' WHERE id=$1",
      [databaseId],
    );
  }
});

let retentionDatabase: string;
const retainedIds: string[] = [];
async function published(id: string) {
  return (
    await owner.query<{
      id: string;
      object_key: string;
      storage_state: string;
      prune_lease_until: Date | null;
    }>(
      "SELECT id,object_key,storage_state,prune_lease_until FROM rootset_control.database_backups WHERE id=$1",
      [id],
    )
  ).rows[0]!;
}
async function policy(database = retentionDatabase) {
  return BackupPolicyResultSchema.parse(
    await execute("getDatabaseBackupPolicy", { databaseId: database }),
  );
}
async function savePolicy(retentionCount: number | null, grace = 60) {
  const current = await policy();
  return BackupPolicyResultSchema.parse(
    await execute("saveDatabaseBackupPolicy", {
      databaseId: retentionDatabase,
      expectedVersion: current.policy.version,
      retentionCount,
      overdueGraceMinutes: grace,
    }),
  );
}
test("retention keeps all by default, preserves the latest snapshot, pins restore packages and enforces versioned Admin policy", async () => {
  await owner.query(
    "UPDATE rootset_control.worker_heartbeats SET heartbeat_at=now(),backup_alert_delivery=true WHERE id=$1",
    [workerId],
  );
  retentionDatabase = (
    await storage.createDatabase(actor, { name: "Retention verification" })
  ).id;
  const table = await storage.createTable(actor, retentionDatabase, {
    name: "Records",
    fields: [{ name: "NAME", type: "text" }],
  });
  await storage.createRow(actor, table.id, { NAME: "Retained source" });
  const saved = (await execute("saveBackupSchedule", {
    databaseId: retentionDatabase,
    expectedVersion: 0,
    bucket,
    prefix: `${prefix}/retention`,
    cron: "0 0 1 1 *",
    timezone: "UTC",
  })) as { jobId: string };
  assert.equal((await terminal(saved.jobId)).state, "succeeded");
  for (let i = 0; i < 3; i++) {
    const accepted = (await execute("runDatabaseBackup", {
      databaseId: retentionDatabase,
    })) as { jobId: string };
    assert.equal((await terminal(accepted.jobId)).state, "succeeded");
    retainedIds.push(accepted.jobId);
  }
  const initial = await policy();
  assert.equal(initial.policy.retentionCount, null);
  assert.equal(initial.emailDeliveryAvailable, true);
  assert.equal(initial.lastSuccessful?.backupId, retainedIds[2]);
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    false,
  );
  const preview = await restoreRequest("previewDatabaseRestore", {
    backupId: retainedIds[0],
  });
  assert.equal((await terminal(preview.jobId)).state, "succeeded");
  const current = await policy(),
    key = newId();
  const input = {
    databaseId: retentionDatabase,
    expectedVersion: current.policy.version,
    retentionCount: 1,
    overdueGraceMinutes: 60,
  };
  const changed = await execute("saveDatabaseBackupPolicy", input, key);
  assert.deepEqual(
    await execute("saveDatabaseBackupPolicy", input, key),
    changed,
  );
  await assert.rejects(execute("saveDatabaseBackupPolicy", input), {
    code: "ROW_VERSION_CONFLICT",
  });
  await assert.rejects(
    execute(
      "saveDatabaseBackupPolicy",
      { ...input, expectedVersion: current.policy.version + 1 },
      newId(),
      { ...actor, role: "viewer" },
    ),
    { status: 403 },
  );
  const outcomes = await Promise.all([
    jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  assert.equal((await published(retainedIds[0]!)).storage_state, "available");
  const removed = await published(retainedIds[1]!);
  assert.equal(removed.storage_state, "pruned");
  await assert.rejects(
    objects.send(
      new HeadObjectCommand({ Bucket: bucket, Key: removed.object_key }),
    ),
    (error) =>
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404,
  );
  assert.equal((await published(retainedIds[2]!)).storage_state, "available");
  const page = (await execute("listDatabaseBackups", {
    databaseId: retentionDatabase,
  })) as { data: DatabaseBackup[] };
  assert.equal(
    page.data.find((item) => item.id === removed.id)?.storageState,
    "pruned",
  );
  await assert.rejects(
    restoreRequest("previewDatabaseRestore", { backupId: removed.id }),
    { code: "RESOURCE_NOT_FOUND" },
  );
  await owner.query(
    "UPDATE rootset_control.jobs SET result=jsonb_set(result,'{expiresAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE id=$1",
    [preview.jobId],
  );
  const queued = await restoreRequest("previewDatabaseRestore", {
    backupId: retainedIds[0],
  });
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    false,
    "a queued restore preview pins its package",
  );
  await jobs.queue.cancel(actor, queued.jobId);
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    true,
  );
  assert.equal((await published(retainedIds[0]!)).storage_state, "pruned");
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    false,
  );
  assert.equal((await published(retainedIds[2]!)).storage_state, "available");
});
test("retention retries exact-key deletion after a lost response without touching the latest snapshot or other backends", async () => {
  await savePolicy(null);
  const next = (await execute("runDatabaseBackup", {
    databaseId: retentionDatabase,
  })) as { jobId: string };
  assert.equal((await terminal(next.jobId)).state, "succeeded");
  const candidate = retainedIds[2]!;
  await savePolicy(1);
  await owner.query(
    "UPDATE rootset_control.database_backups SET backend_id='different-backend' WHERE id=$1",
    [candidate],
  );
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    false,
  );
  await owner.query(
    "UPDATE rootset_control.database_backups SET backend_id=$2 WHERE id=$1",
    [candidate, jobs.backups.backendId],
  );
  let deleted = false;
  hook = async (point) => {
    if (point === "backupRetention.afterDelete") {
      deleted = true;
      throw Error("Lost delete response");
    }
  };
  try {
    assert.equal(
      await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
      true,
    );
    assert.equal(deleted, true);
  } finally {
    hook = undefined;
  }
  const waiting = await published(candidate);
  assert.equal(waiting.storage_state, "deleting");
  assert.ok((await policy()).retentionError);
  await assert.rejects(
    restoreRequest("previewDatabaseRestore", { backupId: candidate }),
    { code: "RESOURCE_NOT_FOUND" },
  );
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    false,
    "failed deletes back off",
  );
  await owner.query(
    "UPDATE rootset_control.database_backups SET next_prune_at=now(),prune_lease_token=$2,prune_lease_until=now()+interval '2 minutes' WHERE id=$1",
    [candidate, newId()],
  );
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    false,
    "a surviving prune lease excludes a second worker",
  );
  await owner.query(
    "UPDATE rootset_control.database_backups SET prune_lease_until=now()-interval '1 second' WHERE id=$1",
    [candidate],
  );
  assert.equal(
    await jobs.backups.lifecycle.pruneOne(orgId, retentionDatabase),
    true,
  );
  assert.equal((await published(candidate)).storage_state, "pruned");
  assert.equal((await published(next.jobId)).storage_state, "available");
  assert.equal((await policy()).lastSuccessful?.backupId, next.jobId);
  retainedIds.push(next.jobId);
});
test("backup failure and overdue alerts deduplicate encrypted administrator mail, suppress revoked recipients and resolve after recovery", async () => {
  const admins = [newId(), newId()],
    member = newId(),
    unverified = newId();
  for (const [index, id] of [...admins, member, unverified].entries()) {
    await owner.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,$4)",
      [
        id,
        `Backup recipient ${index}`,
        `backup-${id.toLowerCase()}@rootset.test`,
        id !== unverified,
      ],
    );
    await owner.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
      [newId(), orgId, id, id === member ? "member" : "admin"],
    );
  }
  await savePolicy(null, 5);
  const failure = (await execute("runDatabaseBackup", {
    databaseId: retentionDatabase,
  })) as { jobId: string };
  hook = async (point) => {
    if (point === "backup.afterSnapshot")
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Deliberate backup failure",
        422,
      );
  };
  try {
    assert.equal((await terminal(failure.jobId)).state, "failed");
  } finally {
    hook = undefined;
  }
  const original = (
    await owner.query<{ completed_at: Date }>(
      "SELECT completed_at FROM rootset_control.jobs WHERE id=$1",
      [failure.jobId],
    )
  ).rows[0]!.completed_at;
  await owner.query(
    "UPDATE rootset_control.jobs SET completed_at=now()-interval '1 day' WHERE id=$1",
    [failure.jobId],
  );
  await jobs.backups.lifecycle.checkAlerts(orgId, retentionDatabase);
  assert.equal(
    (await policy()).alerts.length,
    0,
    "upgrades do not notify about historical failures",
  );
  await owner.query(
    "UPDATE rootset_control.jobs SET completed_at=$2 WHERE id=$1",
    [failure.jobId, original],
  );
  await Promise.all([
    jobs.backups.lifecycle.checkAlerts(orgId, retentionDatabase),
    jobs.backups.lifecycle.checkAlerts(orgId, retentionDatabase),
  ]);
  const result = await policy();
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]!.kind, "failed");
  const mail = (
    await owner.query(
      "SELECT * FROM rootset_control.email_outbox WHERE template='backup-failed'",
    )
  ).rows;
  assert.equal(mail.length, 2);
  assert.ok(
    mail.every((row) => !row.payload_encrypted.includes(retentionDatabase)),
  );
  await owner.query(
    "UPDATE rootset_control.memberships SET role='member' WHERE user_id=$1 AND org_id=$2",
    [admins[1], orgId],
  );
  for (let i = 0; i < 3; i++) await emailOutbox.deliverNext();
  const deliveries = (
    await owner.query(
      "SELECT state,last_error,payload_encrypted FROM rootset_control.email_outbox WHERE template='backup-failed' ORDER BY state",
    )
  ).rows;
  assert.deepEqual(
    deliveries.map((row) => row.state),
    ["failed", "sent"],
  );
  assert.ok(deliveries.every((row) => row.payload_encrypted === ""));
  assert.match(deliveries[0]!.last_error, /no longer requires delivery/);
  await jobs.backups.lifecycle.checkAlerts(orgId, retentionDatabase);
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM rootset_control.email_outbox WHERE template='backup-failed'",
      )
    ).rows[0].n,
    2,
  );
  const future = new Date(Date.now() + 7 * 60_000);
  await owner.query(
    "UPDATE rootset_control.backup_schedules SET cron='* * * * *',updated_at=now() WHERE database_id=$1",
    [retentionDatabase],
  );
  await jobs.backups.lifecycle.checkAlerts(orgId, retentionDatabase, future);
  await jobs.backups.lifecycle.checkAlerts(
    orgId,
    retentionDatabase,
    new Date(future.getTime() + 60_000),
  );
  assert.equal(
    (await policy()).alerts.filter((alert) => alert.kind === "overdue").length,
    1,
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM rootset_control.email_outbox WHERE template='backup-overdue'",
      )
    ).rows[0].n,
    1,
  );
  const last = retainedIds.at(-1)!;
  const success = (
    await owner.query(
      "SELECT snapshot_at,completed_at FROM rootset_control.database_backups WHERE id=$1",
      [last],
    )
  ).rows[0]!;
  await owner.query(
    "UPDATE rootset_control.database_backups SET snapshot_at=$2,completed_at=$2 WHERE id=$1",
    [last, new Date(future.getTime() + 60_000)],
  );
  await jobs.backups.lifecycle.checkAlerts(
    orgId,
    retentionDatabase,
    new Date(future.getTime() + 120_000),
  );
  assert.equal((await policy()).alerts.length, 0);
  await emailOutbox.deliverNext();
  assert.equal(
    (
      await owner.query(
        "SELECT state FROM rootset_control.email_outbox WHERE template='backup-overdue'",
      )
    ).rows[0].state,
    "failed",
    "resolved alerts are not delivered",
  );
  await owner.query(
    "UPDATE rootset_control.database_backups SET snapshot_at=$2,completed_at=$3 WHERE id=$1",
    [last, success.snapshot_at, success.completed_at],
  );
  const current = (await execute("getBackupSchedule", {
    databaseId: retentionDatabase,
  })) as BackupScheduleResult;
  await execute("deleteBackupSchedule", {
    databaseId: retentionDatabase,
    expectedVersion: current.version,
  });
});

test("manual concurrency and durable replay do not create duplicate backups", async () => {
  const idempotencyKey = newId();
  const first = (await execute("runDatabaseBackup", {}, idempotencyKey)) as {
    jobId: string;
  };
  assert.deepEqual(
    await execute("runDatabaseBackup", {}, idempotencyKey),
    first,
  );
  await assert.rejects(queueBackup(), /already queued or running/);
  assert.equal((await terminal(first.jobId)).state, "succeeded");
});

test("scheduler coalesces outage ranges, prevents overlapping runs, and survives multiple schedulers", async () => {
  await save();
  const now = new Date();
  now.setUTCSeconds(0, 0);
  await owner.query(
    "UPDATE rootset_control.backup_schedules SET next_run_at=$2 WHERE database_id=$1",
    [databaseId, new Date(now.getTime() - 10 * 60000)],
  );
  await Promise.all([
    jobs.backups.scheduleDue(orgId, now),
    jobs.backups.scheduleDue(orgId, now),
  ]);
  const queued = (
    await owner.query<JobRecord>(
      "SELECT j.* FROM rootset_control.jobs j JOIN rootset_control.database_backups b ON b.job_id=j.id WHERE b.database_id=$1 AND j.state='queued' AND b.trigger='schedule'",
      [databaseId],
    )
  ).rows;
  assert.equal(queued.length, 1);
  const skipped = (
    await owner.query(
      "SELECT * FROM rootset_control.database_backups WHERE database_id=$1 AND kind='skipped'",
      [databaseId],
    )
  ).rows;
  assert.ok(skipped.length >= 1);
  assert.equal(
    skipped[0].skipped_until.toISOString(),
    new Date(now.getTime() - 60000).toISOString(),
  );
  await owner.query(
    "UPDATE rootset_control.backup_schedules SET next_run_at=$2 WHERE database_id=$1",
    [databaseId, new Date(now.getTime() - 60000)],
  );
  await jobs.backups.scheduleDue(orgId, now);
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS count FROM rootset_control.jobs WHERE kind='database_backup' AND state='queued'",
      )
    ).rows[0].count,
    1,
  );
  assert.equal((await terminal(queued[0]!.id)).state, "succeeded");
  const paged = (await execute("listDatabaseBackups", { limit: 2 })) as {
    data: DatabaseBackup[];
    nextCursor: string;
  };
  const next = (await execute("listDatabaseBackups", {
    limit: 2,
    cursor: paged.nextCursor,
  })) as { data: DatabaseBackup[] };
  assert.equal(paged.data.length, 2);
  assert.ok(paged.nextCursor);
  assert.ok(next.data.every((entry) => entry.id < paged.data.at(-1)!.id));
});

test("deleting schedules offline cancels old scheduled jobs; database removal and lost manual authority prevent publication", async () => {
  const now = new Date();
  now.setUTCSeconds(0, 0);
  now.setUTCMinutes(now.getUTCMinutes() + 1);
  await owner.query(
    "UPDATE rootset_control.backup_schedules SET next_run_at=$2 WHERE database_id=$1",
    [databaseId, now],
  );
  await jobs.backups.scheduleDue(orgId, now);
  const scheduled = (
    await owner.query<JobRecord>(
      "SELECT * FROM rootset_control.jobs WHERE kind='database_backup' AND state='queued' ORDER BY id DESC LIMIT 1",
    )
  ).rows[0]!;
  await owner.query(
    "UPDATE rootset_control.worker_heartbeats SET heartbeat_at=now()-interval '1 hour' WHERE id=$1",
    [workerId],
  );
  assert.equal((await removeSchedule()).schedule, null);
  await owner.query(
    "UPDATE rootset_control.worker_heartbeats SET heartbeat_at=now() WHERE id=$1",
    [workerId],
  );
  assert.equal((await terminal(scheduled.id)).state, "cancelled");
  await save();
  const manual = await queueBackup();
  authorized = false;
  assert.equal((await terminal(manual.jobId)).state, "failed");
  authorized = true;
  const changed = await queueBackup();
  hook = async (point) => {
    if (point === "backup.afterSnapshot") authorized = false;
  };
  assert.equal((await terminal(changed.jobId)).state, "failed");
  authorized = true;
  hook = undefined;
  assert.equal(
    (
      await owner.query(
        "SELECT published FROM rootset_control.database_backups WHERE id=$1",
        [changed.jobId],
      )
    ).rows[0].published,
    false,
  );
});

test("lease loss after publication reconciles success without running the snapshot again", async () => {
  const { jobId } = await queueBackup();
  let published = false;
  hook = async (point) => {
    if (point === "backup.afterPublish") {
      published = true;
      await owner.query(
        "UPDATE rootset_control.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [jobId],
      );
      throw new Error("worker stopped after committed publication");
    }
  };
  await jobs.runOnce(orgId);
  hook = undefined;
  assert.equal(published, true);
  assert.equal((await terminal(jobId)).state, "succeeded");
});

test("an expired attempt cannot publish or overwrite its replacement's immutable package", async () => {
  const { jobId } = await queueBackup();
  hook = async (point) => {
    if (point === "backup.beforePublish")
      await owner.query(
        "UPDATE rootset_control.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        [jobId],
      );
  };
  await jobs.runOnce(orgId);
  hook = undefined;
  assert.equal(
    (
      await owner.query(
        "SELECT published FROM rootset_control.database_backups WHERE id=$1",
        [jobId],
      )
    ).rows[0].published,
    false,
  );
  const before = await objects.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/${databaseId}/`,
    }),
  );
  const oldKey = before.Contents!.find((entry) =>
    entry.Key?.includes(jobId),
  )!.Key!;
  const oldBody = await objects.send(
    new GetObjectCommand({ Bucket: bucket, Key: oldKey }),
  );
  const oldBytes = await oldBody.Body!.transformToByteArray();
  const outcome = await terminal(jobId);
  assert.equal(outcome.state, "succeeded");
  assert.notEqual((outcome.result as { objectKey: string }).objectKey, oldKey);
  const retained = await objects.send(
    new GetObjectCommand({ Bucket: bucket, Key: oldKey }),
  );
  assert.deepEqual(await retained.Body!.transformToByteArray(), oldBytes);
});

test("worker endpoint or encryption-key changes require a new destination test", async () => {
  const different = new JobsService({
    ...options,
    config: {
      ...config,
      backups: { ...config.backups!, encryptionKey: randomBytes(32) },
    },
  });
  try {
    await owner.query(
      "UPDATE rootset_control.worker_heartbeats SET backup_backend_id=$2 WHERE id=$1",
      [workerId, different.backups.backendId],
    );
    await assert.rejects(queueBackup(), /configuration|changed/);
  } finally {
    await owner.query(
      "UPDATE rootset_control.worker_heartbeats SET backup_backend_id=$2,heartbeat_at=now() WHERE id=$1",
      [workerId, jobs.backups.backendId],
    );
    different.backups.close();
  }
});

test("database deletion immediately before publication prevents a readable backup from being catalogued", async () => {
  const previous = databaseId;
  databaseId = (
    await storage.createDatabase(actor, { name: "Delete during backup" })
  ).id;
  try {
    const probe = (await execute("testBackupDestination", {
      bucket,
      prefix,
    })) as { jobId: string };
    assert.equal((await terminal(probe.jobId)).state, "succeeded");
    await save();
    const { jobId } = await queueBackup();
    hook = async (point) => {
      if (point === "backup.beforePublish")
        await storage.deleteDatabase(actor, databaseId, {
          idempotencyKey: newId(),
        });
    };
    const outcome = await terminal(jobId);
    hook = undefined;
    assert.equal(outcome.state, "cancelled");
    assert.equal(
      (
        await owner.query(
          "SELECT published FROM rootset_control.database_backups WHERE id=$1",
          [jobId],
        )
      ).rows[0].published,
      false,
    );
  } finally {
    databaseId = previous;
    hook = undefined;
  }
});

test("worker heartbeats and maintenance continue while both job slots are occupied", async () => {
  const controller = new AbortController();
  const monitorId = newId();
  let release!: () => void;
  let entered = 0;
  let delivered = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const monitor = new JobsService({
    ...options,
    config: {
      ...config,
      workerId: monitorId,
      pollMilliseconds: 10,
      outbox: {
        deliverNext: async () => {
          delivered++;
          return false;
        },
      },
    },
  });
  monitor.runOnce = async () => {
    entered++;
    await gate;
    return true;
  };
  const running = monitor.runWorker({ signal: controller.signal });
  try {
    const starting = Date.now();
    while (entered < 2) {
      assert.ok(Date.now() - starting < 5000, "both job slots should start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const heartbeat = (
      await owner.query<{ state: string; age: number }>(
        "SELECT state,extract(epoch FROM now()-heartbeat_at)::float AS age FROM rootset_control.worker_heartbeats WHERE id=$1",
        [monitorId],
      )
    ).rows[0]!;
    assert.equal(heartbeat.state, "ready");
    assert.ok(heartbeat.age < 2);
    assert.ok(delivered >= 2);
  } finally {
    controller.abort();
    release();
    await running;
    monitor.backups.close();
    await owner.query(
      "DELETE FROM rootset_control.worker_heartbeats WHERE id=$1",
      [monitorId],
    );
  }
});
