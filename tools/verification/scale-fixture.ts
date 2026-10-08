import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { statfsSync } from "node:fs";
import {
  ActorSchema,
  FieldNameSchema,
  newId,
  rowBytes,
  type Actor,
  type FieldType,
  type JsonValue,
} from "@rootset/contracts";
import type { PoolClient } from "@rootset/database";
import {
  TableStorage,
  type FieldInput,
  type TableRecord,
} from "../../packages/table-storage/src/index.js";
import { fieldColumn } from "../../packages/table-storage/src/query.js";
import {
  assertPreparedDatabase,
  closePools,
  fixtureSecret,
  root,
  testPools,
} from "./environment.js";

function fieldSuffix(index: number): string {
  let suffix = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    suffix = String.fromCharCode(65 + ((value - 1) % 26)) + suffix;
  return suffix;
}

const fields: FieldInput[] = [
  "text",
  "integer",
  "float",
  "boolean",
  "date",
  "time",
  "date-time",
  "json",
].flatMap((type) =>
  Array.from({ length: 3 }, (_, index) => ({
    type: type as FieldType,
    name: `${type.replace("-", "_").toUpperCase()}_${fieldSuffix(index)}`,
    ...(type === "text" ? { charLimit: 64 } : {}),
  })),
);
const quote = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;
const path = (table: TableRecord): string =>
  `${quote(table.schemaName)}.${quote(table.physicalName)}`;
const fixtureId = (index: number): string =>
  index.toString(16).toUpperCase().padStart(26, "0");

export interface ScaleFixture {
  kind: "scale-fixture";
  baseline: "0001_baseline.sql";
  sourceCommit: string;
  seededAt: string;
  complete: boolean;
  orgId: string;
  userId: string;
  databaseId: string;
  tableId: string;
  wideTableId: string;
  fields: TableRecord["fields"];
  actor: Actor;
  rows: number;
  historyEvents: number;
  canonicalBytes: {
    min: number;
    max: number;
    mean: number;
    sampleCount: number;
  };
  tableChecksums: {
    algorithm: string;
    chunks: { from: number; to: number; sha256: string }[];
    sha256: string;
  };
  historyChecksum: {
    algorithm: string;
    chunks: { from: string; to: string; sha256: string }[];
    sha256: string;
  };
  environment: Record<string, unknown>;
  relations: Record<string, unknown>[];
  admission?: Record<string, unknown>;
}

function expression(type: FieldType, index: number): string {
  switch (type) {
    case "text":
      return `'C'||lpad((n%10000)::text,4,'0')`;
    case "integer":
      return index === 0 ? "n" : `(n%${index === 1 ? 1000 : 100})`;
    case "float":
      return `((n%1000)::float8/${index === 0 ? 10 : index === 1 ? 100 : 1000})`;
    case "boolean":
      return `(n%${index + 2}=0)`;
    case "date":
      return `(date '2024-01-01'+(n%365)::int)`;
    case "time":
      return `(time '00:00:00'+(n%86400)*interval '1 second')`;
    case "date-time":
      return `(timestamptz '2024-01-01T00:00:00Z'+(n%86400)*interval '1 second')`;
    case "json":
      return `jsonb_build_object('g',n%4)`;
  }
}

export function hardware(): Record<string, unknown> {
  const disk = statfsSync(root);
  const containers: Record<string, unknown>[] = [];
  let dockerEngine: Record<string, unknown>;
  try {
    const engine = JSON.parse(
      execFileSync("docker", ["info", "--format", "{{json .}}"], {
        encoding: "utf8",
      }),
    ) as Record<string, unknown>;
    dockerEngine = {
      logicalCpuCount: engine.NCPU,
      memoryBytes: engine.MemTotal,
      operatingSystem: engine.OperatingSystem,
      architecture: engine.Architecture,
      storageDriver: engine.Driver,
    };
    const names = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((name) => name.includes("rootset"));
    for (const name of names) {
      const inspection = JSON.parse(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{json .HostConfig}}", name],
          { encoding: "utf8" },
        ),
      ) as Record<string, unknown>;
      containers.push({
        name,
        memoryBytes: inspection.Memory,
        nanoCpus: inspection.NanoCpus,
        cpuQuota: inspection.CpuQuota,
        cpuPeriod: inspection.CpuPeriod,
      });
    }
  } catch {
    dockerEngine = { status: "unavailable" };
    containers.push({
      limitation:
        "Docker resource limits could not be read; profile acceptance remains unverified.",
    });
  }
  return {
    operatingSystem: platform(),
    release: release(),
    cpuModel: cpus()[0]?.model,
    logicalCpuCount: cpus().length,
    hostMemoryBytes: totalmem(),
    availableFilesystemBytes: Number(disk.bavail) * Number(disk.bsize),
    dockerEngine,
    containers,
    acceptanceProfileVerified: false,
  };
}

export async function tableChecksums(
  client: PoolClient,
  table: TableRecord,
  rows: number,
): Promise<ScaleFixture["tableChecksums"]> {
  const chunks: { from: number; to: number; sha256: string }[] = [];
  const boundaries = await client.query<{ row_id: string }>(
    `SELECT row_id FROM (SELECT row_id,row_number() OVER (ORDER BY row_id) ordinal FROM ${path(table)}) ranked WHERE (ordinal-1)%100000=0 ORDER BY row_id`,
  );
  for (const [index, boundary] of boundaries.rows.entries()) {
    const result = await client.query<{ checksum: string }>(
      `SELECT encode(digest(string_agg(encode(digest(to_jsonb(r)::text,'sha256'),'hex'),'' ORDER BY row_id),'sha256'),'hex') AS checksum FROM ${path(table)} r WHERE row_id >= $1 AND ($2::text IS NULL OR row_id < $2)`,
      [boundary.row_id, boundaries.rows[index + 1]?.row_id ?? null],
    );
    chunks.push({
      from: index * 100000 + 1,
      to: Math.min(rows, (index + 1) * 100000),
      sha256: result.rows[0]!.checksum,
    });
    if ((index + 1) % 10 === 0)
      process.stdout.write(
        JSON.stringify({
          stage: "table-checksums",
          completedChunks: index + 1,
          totalChunks: boundaries.rows.length,
        }) + "\n",
      );
  }
  return {
    algorithm:
      "sha256 of concatenated ordered per-row native PostgreSQL JSON sha256 in actual row-ID keyset chunks of 100000 rows, then ordered chunk sha256; timestamps and system metadata included",
    chunks,
    sha256: createHash("sha256")
      .update(chunks.map((chunk) => chunk.sha256).join(""))
      .digest("hex"),
  };
}

export async function historyChecksums(
  client: PoolClient,
  tableId: string,
): Promise<ScaleFixture["historyChecksum"]> {
  const metadata = await client.query<{ org_id: string }>(
    "SELECT org_id FROM rootset_control.tables WHERE id=$1",
    [tableId],
  );
  const orgId = metadata.rows[0]!.org_id;
  const rows = await client.query<{ row_id: string }>(
    "SELECT DISTINCT row_id FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2 ORDER BY row_id",
    [orgId, tableId],
  );
  const chunks: { from: string; to: string; sha256: string }[] = [];
  // Existing org/table/row lookup index bounds each aggregate to one row's history.
  // The performance fixture has 1,000 rows with 10,000 edits each, avoiding a global 10M-event sort.
  await client.query("SET work_mem='64MB'");
  for (const [index, row] of rows.rows.entries()) {
    const result = await client.query<{ sha256: string }>(
      "SELECT encode(digest(string_agg(encode(digest(to_jsonb(h)::text,'sha256'),'hex'),'' ORDER BY id),'sha256'),'hex') AS sha256 FROM rootset_control.cell_changes h WHERE org_id=$1 AND table_id=$2 AND row_id=$3",
      [orgId, tableId, row.row_id],
    );
    chunks.push({
      from: row.row_id,
      to: row.row_id,
      sha256: result.rows[0]!.sha256,
    });
    if ((index + 1) % 100 === 0)
      process.stdout.write(
        JSON.stringify({
          stage: "history-checksums",
          completedRows: index + 1,
          totalRows: rows.rows.length,
        }) + "\n",
      );
  }
  return {
    algorithm:
      "sha256 of per-event native PostgreSQL JSON sha256 ordered by event id within each row, then ordered row-id group sha256; from/to identify each row ID",
    chunks,
    sha256: createHash("sha256")
      .update(chunks.map((chunk) => chunk.sha256).join(""))
      .digest("hex"),
  };
}

export async function finalizeScaleFixture(filename: string): Promise<void> {
  const manifestPath = resolve(filename);
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as ScaleFixture;
  if (manifest.kind !== "scale-fixture")
    throw new Error("A scale fixture manifest is required.");
  assert.equal(
    manifest.baseline,
    "0001_baseline.sql",
    "Use a fresh V1 scale fixture; historical fixtures remain unchanged.",
  );
  if (manifest.complete)
    throw new Error(
      "This fixture is already complete; benchmark it rather than reseeding or rewriting checksums.",
    );
  const pools = testPools(),
    actor = fixtureActor(manifest);
  const storage = new TableStorage({
    pool: pools.app,
    ddlPool: pools.ddl,
    cursorSecret: fixtureSecret("ROOTSET_SECRET"),
  });
  const client = await pools.owner.connect();
  try {
    await client.query("SET statement_timeout='0'");
    const t = await storage.getTable(actor, manifest.tableId);
    const actual = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${path(t)}`,
    );
    assert.equal(Number(actual.rows[0]?.count), 5000000);
    assert.equal(t.rowCount, 5000000);
    assert.equal(t.fields.length, 24);
    const events = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rootset_control.cell_changes WHERE table_id=$1",
      [t.id],
    );
    assert.ok(Number(events.rows[0]?.count) >= 10000000);
    const trigger = await client.query(
      "SELECT g.tgenabled FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND g.tgname=$3",
      [t.schemaName, t.physicalName, "rootset_enforce"],
    );
    assert.equal(trigger.rows[0]?.tgenabled, "O");
    const sample = await storage.queryRows(actor, t.id, { limit: 1000 });
    const sizes = sample.data.map((row) => rowBytes(t.fields, row.values));
    manifest.canonicalBytes = {
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      mean: sizes.reduce((a, b) => a + b, 0) / sizes.length,
      sampleCount: sizes.length,
    };
    assert.ok(
      manifest.canonicalBytes.min >= 512 && manifest.canonicalBytes.max <= 1024,
    );
    process.stdout.write(
      JSON.stringify({
        stage: "resume-checksums",
        rows: 5000000,
        historyEvents: Number(events.rows[0]?.count),
        canonicalBytes: manifest.canonicalBytes,
      }) + "\n",
    );
    manifest.tableChecksums = await tableChecksums(client, t, 5000000);
    manifest.historyChecksum = await historyChecksums(client, t.id);
    manifest.rows = 5000000;
    manifest.historyEvents = Number(events.rows[0]?.count);
    const existing = (
      await storage.listTables(actor, manifest.databaseId)
    ).find((table) => table.name === "Two hundred fields near row byte limit");
    const wide =
      existing ??
      (await storage.createTable(actor, manifest.databaseId, {
        name: "Two hundred fields near row byte limit",
        fields: Array.from({ length: 200 }, (_, index) => ({
          name: `FIELD_${fieldSuffix(index)}`,
          type: "text" as const,
          charLimit: 65536,
        })),
        idempotencyKey: newId(),
      }));
    const values: Record<string, JsonValue> = Object.fromEntries(
      wide.fields.map((field) => [field.name, null]),
    );
    values[wide.fields[0]!.name] = "x".repeat(
      65536 - rowBytes(wide.fields, values) + 2,
    );
    assert.equal(rowBytes(wide.fields, values), 65536);
    for (let index = wide.rowCount; index < 20; index++)
      await storage.createRow(actor, wide.id, values, {
        idempotencyKey: newId(),
      });
    manifest.wideTableId = wide.id;
    const integer = t.fields.find((field) => field.name === "INTEGER_A")!;
    const indexes = await storage.listIndexes(actor, t.id);
    if (
      !indexes.some(
        (index) => index.fieldId === integer.id && index.state === "active",
      )
    )
      await storage.createIndex(actor, t.id, {
        fieldId: integer.id,
        kind: "btree",
        expectedSchemaVersion: t.schemaVersion,
        idempotencyKey: newId(),
      });
    manifest.relations = (
      await client.query(
        "SELECT relname,pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 OR (n.nspname=$2 AND c.relname IN ($3,$4)) ORDER BY relname",
        [
          t.schemaName,
          "rootset_control",
          "cell_changes",
          "cell_changes_default",
        ],
      )
    ).rows;
    manifest.complete = true;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    process.stdout.write(
      JSON.stringify({
        stage: "complete",
        manifest: manifestPath,
        rows: manifest.rows,
        historyEvents: manifest.historyEvents,
      }) + "\n",
    );
  } finally {
    client.release();
    await closePools(pools);
  }
}

export async function seedScaleFixture(destination: string): Promise<void> {
  const directory = resolve(destination);
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "scale-fixture.json");
  const pools = testPools();
  const storage = new TableStorage({
    pool: pools.app,
    ddlPool: pools.ddl,
    cursorSecret: fixtureSecret("ROOTSET_SECRET"),
  });
  const orgId = newId(),
    userId = newId();
  const actor: Actor = {
    kind: "session",
    id: `performance-fixture:${userId}`,
    userId,
    orgId,
    role: "admin",
    scopes: ["rows:read", "rows:write", "history:read", "schema:manage"],
    membershipVersion: 1,
  };
  let connection: PoolClient | undefined;
  let table: TableRecord | undefined;
  try {
    await assertPreparedDatabase(pools.owner);
    await pools.owner.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
      [
        userId,
        "Performance fixture identity",
        `${userId.toLowerCase()}@performance.example.test`,
      ],
    );
    await pools.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
      [orgId, "Five-million-row verification fixture"],
    );
    await pools.owner.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')",
      [newId(), orgId, userId],
    );
    const database = await storage.createDatabase(actor, {
      name: "Acceptance scale fixture",
    });
    table = await storage.createTable(actor, database.id, {
      name: "Five million typed rows",
      fields,
      idempotencyKey: newId(),
    });
    const manifest: ScaleFixture = {
      kind: "scale-fixture",
      baseline: "0001_baseline.sql",
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      seededAt: new Date().toISOString(),
      complete: false,
      orgId,
      userId,
      databaseId: database.id,
      tableId: table.id,
      wideTableId: "",
      fields: table.fields,
      actor,
      rows: 0,
      historyEvents: 0,
      canonicalBytes: { min: 0, max: 0, mean: 0, sampleCount: 0 },
      tableChecksums: { algorithm: "", chunks: [], sha256: "" },
      historyChecksum: { algorithm: "", chunks: [], sha256: "" },
      environment: hardware(),
      relations: [],
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    connection = await pools.owner.connect();
    await connection.query("SET statement_timeout='0'; SET timezone='UTC'");
    await connection.query(
      "UPDATE rootset_control.tables SET state='maintenance' WHERE id=$1",
      [table.id],
    );
    await connection.query(
      `ALTER TABLE ${path(table)} DISABLE TRIGGER rootset_enforce`,
    );
    const columns = table.fields
      .map((field) => quote(fieldColumn(field)))
      .join(",");
    const expressions = table.fields
      .map((field, index) => expression(field.type, index % 3))
      .join(",");
    const rows = 5_000_000;
    for (let start = 1; start <= rows; start += 100000) {
      const end = Math.min(rows, start + 99999);
      await connection.query(
        `INSERT INTO ${path(table)}(row_id,org_id,${columns}) SELECT upper(lpad(to_hex(n),26,'0')),$1,${expressions} FROM generate_series($2::bigint,$3::bigint) n`,
        [orgId, start, end],
      );
      process.stdout.write(
        JSON.stringify({ stage: "rows", committed: end, total: rows }) + "\n",
      );
    }
    const integer = table.fields.find((field) => field.name === "INTEGER_A")!;
    const historyEvents = 10_000_000;
    for (let start = 1; start <= historyEvents; start += 100000) {
      const end = Math.min(historyEvents, start + 99999);
      await connection.query(
        `INSERT INTO rootset_control.cell_changes(org_id,database_id,table_id,row_id,field_id,mutation_id,old_value,new_value,field_definition,old_version,new_version,operation,actor,context,changed_at)
        SELECT $1,$2,$3,upper(lpad(to_hex((n-1)%1000+1),26,'0')),$4,$5,to_jsonb((n-1)/1000),to_jsonb((n-1)/1000+1),$6::jsonb,(n-1)/1000+1,(n-1)/1000+2,'update',$7::jsonb,'{"source":"performance_seed","correctnessEvidence":false}'::jsonb,timestamptz '2026-01-01T00:00:00Z'+n*interval '1 millisecond'
        FROM generate_series($8::bigint,$9::bigint) n`,
        [
          orgId,
          database.id,
          table.id,
          integer.id,
          newId(),
          JSON.stringify(integer),
          JSON.stringify({
            kind: "session",
            id: actor.id,
            userId,
            role: actor.role,
          }),
          start,
          end,
        ],
      );
      process.stdout.write(
        JSON.stringify({
          stage: "history",
          committed: end,
          total: historyEvents,
        }) + "\n",
      );
    }
    await connection.query(
      `UPDATE ${path(table)} SET ${quote(fieldColumn(integer))}=10000,row_version=10001 WHERE row_id < $1`,
      [fixtureId(1001)],
    );
    await connection.query(
      `ALTER TABLE ${path(table)} ENABLE TRIGGER rootset_enforce`,
    );
    await connection.query(
      "UPDATE rootset_control.tables SET state='active',row_count=$2 WHERE id=$1",
      [table.id, rows],
    );
    await connection.query(`ANALYZE ${path(table)}`);
    const actual = await connection.query<{ rows: string }>(
      `SELECT count(*)::text AS rows FROM ${path(table)}`,
    );
    assert.equal(Number(actual.rows[0]?.rows), rows);
    const events = await connection.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rootset_control.cell_changes WHERE table_id=$1",
      [table.id],
    );
    assert.equal(Number(events.rows[0]?.count), historyEvents);
    const sample = await storage.queryRows(actor, table.id, { limit: 1000 });
    const sizes = sample.data.map((row) => rowBytes(table!.fields, row.values));
    manifest.canonicalBytes = {
      min: Math.min(...sizes),
      max: Math.max(...sizes),
      mean: sizes.reduce((a, b) => a + b, 0) / sizes.length,
      sampleCount: sizes.length,
    };
    assert.ok(
      manifest.canonicalBytes.min >= 512 && manifest.canonicalBytes.max <= 1024,
    );
    process.stdout.write(
      JSON.stringify({
        stage: "checksums",
        canonicalBytes: manifest.canonicalBytes,
      }) + "\n",
    );
    manifest.tableChecksums = await tableChecksums(connection, table, rows);
    manifest.historyChecksum = await historyChecksums(connection, table.id);
    manifest.rows = rows;
    manifest.historyEvents = historyEvents;
    const wide = await storage.createTable(actor, database.id, {
      name: "Two hundred fields near row byte limit",
      fields: Array.from({ length: 200 }, (_, index) => ({
        name: `FIELD_${fieldSuffix(index)}`,
        type: "text" as const,
        charLimit: 65536,
      })),
      idempotencyKey: newId(),
    });
    const values: Record<string, JsonValue> = Object.fromEntries(
      wide.fields.map((field) => [field.name, null]),
    );
    values[wide.fields[0]!.name] = "x".repeat(
      65536 - rowBytes(wide.fields, values) + 2,
    ); // replacing null (4 bytes) with quoted text (2 bytes)
    assert.equal(rowBytes(wide.fields, values), 65536);
    for (let index = 0; index < 20; index++)
      await storage.createRow(actor, wide.id, values, {
        idempotencyKey: newId(),
      });
    manifest.wideTableId = wide.id;
    const index = await storage.createIndex(actor, table.id, {
      fieldId: integer.id,
      kind: "btree",
      expectedSchemaVersion: 1,
      idempotencyKey: newId(),
    });
    assert.equal(index.state, "active");
    manifest.relations = (
      await connection.query(
        "SELECT relname,pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 OR (n.nspname=$2 AND c.relname IN ($3,$4)) ORDER BY relname",
        [
          table.schemaName,
          "rootset_control",
          "cell_changes",
          "cell_changes_default",
        ],
      )
    ).rows;
    manifest.complete = true;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    process.stdout.write(
      JSON.stringify({
        stage: "complete",
        manifest: manifestPath,
        tableId: table.id,
        rows,
        historyEvents,
      }) + "\n",
    );
  } finally {
    if (connection && table)
      await connection
        .query(`ALTER TABLE ${path(table)} ENABLE TRIGGER rootset_enforce`)
        .catch(() => undefined);
    connection?.release();
    await closePools(pools);
  }
}

export async function loadScaleFixture(
  filename: string,
): Promise<ScaleFixture> {
  const fixture = JSON.parse(
    await readFile(resolve(filename), "utf8"),
  ) as ScaleFixture;
  if (
    fixture.kind !== "scale-fixture" ||
    fixture.baseline !== "0001_baseline.sql" ||
    !fixture.complete ||
    fixture.rows !== 5000000 ||
    fixture.historyEvents < 10000000
  )
    throw new Error(
      "Complete actual five-million-row/ten-million-event fixture is required.",
    );
  ActorSchema.parse(fixture.actor);
  assert.equal(fixture.actor.kind, "session");
  assert.equal(fixture.actor.orgId, fixture.orgId);
  assert.equal(fixture.actor.userId, fixture.userId);
  for (const field of fixture.fields) FieldNameSchema.parse(field.name);
  assert.equal(
    new Set(fixture.fields.map((field) => field.name)).size,
    fixture.fields.length,
  );
  return fixture;
}

export function fixtureActor(fixture: ScaleFixture): Actor {
  return {
    ...fixture.actor,
    scopes: [...fixture.actor.scopes],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const destination = process.argv[2];
  if (!destination)
    throw new Error(
      "Pass verification/<run-id> directory. Performance seeding requires isolated local test services; it does not establish mutation correctness.",
    );
  if (process.argv[3] === "--finalize") await finalizeScaleFixture(destination);
  else await seedScaleFixture(destination);
}
