import assert from "node:assert/strict";
import { createPool, migrate, withOrg } from "@rootset/database";
import { newId, type Actor } from "@rootset/contracts";
import { TableStorage } from "./index.js";

if (process.env.NODE_ENV === "production")
  throw new Error(
    "The storage spike requires an isolated development database",
  );
for (const key of [
  "ROOTSET_TEST_DATABASE_URL",
  "ROOTSET_TEST_APP_DATABASE_URL",
  "ROOTSET_TEST_DDL_DATABASE_URL",
])
  if (!process.env[key])
    throw new Error(
      `Missing ${key}; run against an isolated installed PostgreSQL 18 database`,
    );
const source = new URL(process.env.ROOTSET_TEST_DATABASE_URL!);
if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname))
  throw new Error("The disposable storage spike requires loopback PostgreSQL");
const isolatedName = `rootset_spike_${newId().toLowerCase()}`;
const admin = createPool(source.toString(), 1);
await admin.query(`CREATE DATABASE "${isolatedName}" TEMPLATE template0`);
const target = (key: string): string => {
  const url = new URL(process.env[key]!);
  url.pathname = `/${isolatedName}`;
  return url.toString();
};
const owner = createPool(target("ROOTSET_TEST_DATABASE_URL"), 1);
const app = createPool(target("ROOTSET_TEST_APP_DATABASE_URL"), 4);
const ddl = createPool(target("ROOTSET_TEST_DDL_DATABASE_URL"), 2);
const storage = new TableStorage({
  pool: app,
  ddlPool: ddl,
  cursorSecret: "isolated-storage-spike-cursor-secret-at-least-32-bytes",
});
const orgId = newId();
const actor: Actor = {
  id: newId(),
  orgId,
  kind: "operator",
  operator: true,
  role: "owner",
  scopes: ["*"],
  targets: [],
  unrestricted: true,
};
try {
  await migrate(owner);
  await owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [orgId, "Isolated storage spike"],
  );
  const database = await storage.createDatabase(actor, { name: "Spike" });
  const table = await storage.createTable(actor, database.id, {
    name: "Native cells",
    fields: [
      { apiKey: "code", label: "Code", type: "text", charLimit: 200 },
      { apiKey: "count", label: "Count", type: "integer", min: -100, max: 100 },
      { apiKey: "rate", label: "Rate", type: "float" },
      { apiKey: "live", label: "Live", type: "boolean" },
      { apiKey: "day", label: "Day", type: "date" },
      { apiKey: "clock", label: "Clock UTC", type: "time" },
      { apiKey: "instant", label: "Instant", type: "date-time" },
      { apiKey: "payload", label: "Payload", type: "json" },
    ],
  });
  const row = await storage.createRow(
    actor,
    table.id,
    {
      code: "007",
      count: 3,
      rate: 0.125,
      live: false,
      day: "2024-02-29",
      clock: "10:20:30.1Z",
      instant: "2024-02-29T10:20:30Z",
      payload: { z: 2, a: [null, true] },
    },
    { idempotencyKey: "spike-row" },
  );
  assert.equal(row.values.clock, "10:20:30.100Z");
  assert.equal(row.values.instant, "2024-02-29T10:20:30.000Z");
  assert.equal(row.version, "1");
  const replay = await storage.createRow(
    actor,
    table.id,
    {
      code: "007",
      count: 3,
      rate: 0.125,
      live: false,
      day: "2024-02-29",
      clock: "10:20:30.1Z",
      instant: "2024-02-29T10:20:30Z",
      payload: { z: 2, a: [null, true] },
    },
    { idempotencyKey: "spike-row" },
  );
  assert.equal(replay.id, row.id);
  const changed = await storage.updateRow(
    actor,
    table.id,
    row.id,
    { count: 4 },
    { expectedVersion: "1" },
  );
  assert.equal(changed.version, "2");
  const same = await storage.updateRow(
    actor,
    table.id,
    row.id,
    { payload: { a: [null, true], z: 2 } },
    { expectedVersion: "2" },
  );
  assert.equal(same.version, "2");
  const history = await storage.cellHistory(
    actor,
    table.id,
    row.id,
    table.fields.find((f) => f.apiKey === "count")!.id,
  );
  assert.equal(history.data.length, 2);
  const narrow = await storage.createUniqueRule(actor, table.id, {
    fieldIds: [table.fields[0]!.id],
    expectedSchemaVersion: 1,
  });
  assert.equal(narrow.strategy, "native");
  await assert.rejects(storage.createRow(actor, table.id, { code: "007" }), {
    code: "UNIQUE_CONFLICT",
  });
  const native = await withOrg(ddl, orgId, async (c) =>
    (
      await c.query<{ data_type: string }>(
        "SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name LIKE $3",
        [table.schemaName, table.physicalName, "f_%"],
      )
    ).rows.map((v) => v.data_type),
  );
  assert.equal(native.length, 8);
  assert.ok(native.includes("jsonb"));
  assert.ok(native.includes("bigint"));
  assert.ok(native.includes("timestamp with time zone"));
  const queried = await storage.queryRows(actor, table.id, {
    select: ["code", "count"],
    where: { field: "count", op: "gte", value: 4 },
    limit: 1,
  });
  assert.equal(queried.data[0]?.id, row.id);
  const window = await storage.queryWindow(actor, table.id, {
    position: "last",
    query: { limit: 1 },
  });
  assert.equal(window.result.data[0]?.id, row.id);
  await storage.deleteRow(actor, table.id, row.id, { expectedVersion: "2" });
  assert.equal(
    (await storage.cellHistory(actor, table.id, row.id, table.fields[1]!.id))
      .data.length,
    3,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      postgresNativeTypes: native,
      checks: [
        "typed-UTC-roundtrip",
        "atomic-history",
        "no-op",
        "idempotency",
        "native-uniqueness",
        "query-projection",
        "window",
        "deleted-row-history",
        "non-owner-app-and-DDL-roles",
      ],
    }),
  );
  await storage.deleteDatabase(actor, database.id);
} finally {
  await Promise.all([owner.end(), app.end(), ddl.end()]);
  try {
    await admin.query(`DROP DATABASE "${isolatedName}"`);
  } finally {
    await admin.end();
  }
}
