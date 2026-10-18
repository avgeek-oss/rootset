import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jobActivityDetails,
  resourceActivityDetails,
} from "./activity-details";

const name = { id: "name", name: "NAME", type: "text" };
const count = { id: "count", name: "COUNT", type: "integer" };

test("reordered fields retain names and both orders without physical storage metadata", () => {
  assert.deepEqual(
    resourceActivityDetails(
      "fields.reorder",
      {
        fields: [name, count],
        physicalName: "hidden-storage",
      },
      { fields: [count, name] },
    ),
    {
      fieldOrder: {
        before: ["NAME", "COUNT"],
        after: ["COUNT", "NAME"],
      },
    },
  );
});

test("field changes show only affected fields and attribute names, without defaults or allowed values", () => {
  const changed = {
    ...name,
    required: true,
    default: "hidden-default",
    allowedValues: ["hidden-choice"],
  };
  const details = resourceActivityDetails(
    "field.update",
    { fields: [name, count] },
    { fields: [changed, count] },
  );
  assert.deepEqual(details.fields, [
    {
      before: name,
      after: { ...name, required: true },
      changedAttributes: ["required", "default", "allowedValues"],
    },
  ]);
  assert.ok(!JSON.stringify(details).includes("hidden-"));
  assert.deepEqual(
    resourceActivityDetails(
      "field.update",
      { fields: [name] },
      { fields: [{ ...name, charLimit: 80 }] },
    ).fields,
    [
      {
        before: name,
        after: { ...name, charLimit: 80 },
        changedAttributes: ["charLimit"],
      },
    ],
  );
  assert.deepEqual(
    resourceActivityDetails("field.convert", count, { ...count, type: "text" })
      .fields,
    [
      {
        before: count,
        after: { ...count, type: "text" },
        changedAttributes: ["type"],
      },
    ],
  );
  assert.deepEqual(
    resourceActivityDetails(
      "field.delete",
      { fields: [name, count] },
      { fields: [name] },
    ).fields,
    [
      {
        before: count,
        after: null,
        changedAttributes: ["name", "type"],
      },
    ],
  );
});

test("unique rules and table relations include affected fields, with an honest fallback for old events", () => {
  const relation = {
    id: "relation",
    fieldIds: ["count"],
    referencedTableId: "parent",
    referencedTableName: "Parents",
    referencedFieldNames: ["ID"],
    secret: "hidden",
  };
  assert.deepEqual(
    resourceActivityDetails(
      "foreign-key.create",
      { fields: [count], relations: [] },
      { fields: [count], relations: [relation] },
    ),
    {
      relations: [
        {
          id: "relation",
          fields: [{ id: "count", name: "COUNT" }],
          referencedTableId: "parent",
          referencedTableName: "Parents",
          referencedFields: ["ID"],
        },
      ],
    },
  );
  assert.deepEqual(
    resourceActivityDetails(
      "rule.delete",
      {
        fields: [name],
        rules: [
          {
            id: "rule",
            name: "Names",
            fieldIds: ["name"],
            where: { value: "hidden-predicate" },
            physicalName: "hidden-index",
          },
        ],
      },
      { fields: [name], rules: [] },
    ),
    {
      rules: [
        {
          id: "rule",
          name: "Names",
          fields: [{ id: "name", name: "NAME" }],
          conditional: true,
        },
      ],
    },
  );
  assert.match(
    String(resourceActivityDetails("rule.create", {}, {}).note),
    /not recorded/,
  );
});

test("resource, schedule, retention, restore and prune contexts only expose public metadata", () => {
  const prefix = "a".repeat(600);
  const longDescription = resourceActivityDetails(
    "database.update",
    { description: `${prefix}before` },
    { description: `${prefix}after` },
  );
  assert.deepEqual(Object.keys(longDescription.changes!), ["description"]);
  assert.ok(JSON.stringify(longDescription).length < 1200);
  assert.deepEqual(
    resourceActivityDetails(
      "database.update",
      { name: "Old", description: "Keep" },
      { name: "New", description: "Keep", secret: "hidden" },
    ),
    { changes: { name: { before: "Old", after: "New" } } },
  );
  assert.deepEqual(
    resourceActivityDetails(
      "database.backup_schedule.delete",
      {
        cron: "0 2 * * *",
        timezone: "UTC",
        backendId: "hidden",
        credentials: "hidden",
      },
      null,
    ),
    { before: { cron: "0 2 * * *", timezone: "UTC" }, after: null },
  );
  assert.deepEqual(
    resourceActivityDetails(
      "database.backup_policy.update",
      { retentionCount: null },
      { retentionCount: 7 },
    ),
    { changes: { retentionCount: { before: null, after: 7 } } },
  );
  assert.deepEqual(
    resourceActivityDetails(
      "database.backup.prune",
      { storageState: "available" },
      { storageState: "pruned" },
    ),
    { changes: { storageState: { before: "available", after: "pruned" } } },
  );
  assert.deepEqual(
    resourceActivityDetails("database.restore", null, {
      sourceBackupId: "backup",
      rowCount: 12,
      tableCount: 2,
      secret: "hidden",
    }),
    { sourceBackupId: "backup", rowCount: 12, tableCount: 2 },
  );
  assert.deepEqual(
    resourceActivityDetails("table.create", null, {
      name: "Table",
      rowCount: 0,
      fields: [name],
      physicalName: "hidden",
    }),
    { name: "Table", rowCount: 0, fields: [name] },
  );
});

test("job details describe immutable requests and the event attempt, excluding content, filters and error payloads", () => {
  const details = jobActivityDetails(
    {
      fileName: "import.csv",
      format: "csv",
      content: "hidden-record",
      mapping: [{ source: "NAME", fieldId: "name" }],
      query: {
        select: ["name"],
        where: { value: "hidden-filter" },
        orderBy: [{ field: "name", direction: "asc" }],
      },
      changes: { required: true, default: "hidden-default" },
      error: { message: "hidden-provider" },
      credentials: "hidden-secret",
    },
    "job",
    "queued",
    2,
  );
  assert.deepEqual(details, {
    jobId: "job",
    status: "requested",
    attempt: 2,
    request: {
      fileName: "import.csv",
      format: "csv",
      mapping: [{ source: "NAME", fieldId: "name" }],
      filtered: true,
      sorted: true,
      fields: ["name"],
      changedAttributes: ["required", "default"],
    },
  });
  assert.ok(!JSON.stringify(details).includes("hidden-"));
  const bounded = jobActivityDetails(
    {
      fields: Array.from({ length: 1000 }, () => ({
        ...name,
        name: "x".repeat(10000),
      })),
    },
    "job",
    "failed",
    3,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 150000);
});
