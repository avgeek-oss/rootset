import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createPool } from "@rootset/database";
import { TableStorage } from "../../packages/table-storage/src/index.js";
import { closePools, fixtureSecret, testPools } from "./environment.js";
import {
  fixtureActor,
  historyChecksums,
  loadScaleFixture,
  tableChecksums,
} from "./scale-fixture.js";
import { sourceProvenance } from "./source-provenance.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function comparePhysicalScaleRestore(
  filename: string,
  targetPort: number,
): Promise<void> {
  assert.ok(
    Number.isInteger(targetPort) && targetPort > 0 && targetPort <= 65535,
  );
  const fixture = await loadScaleFixture(filename),
    pools = testPools();
  const targetURL = new URL(pools.owner.options.connectionString!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(targetURL.hostname));
  assert.notEqual(targetURL.port, String(targetPort));
  const sourcePort = targetURL.port;
  targetURL.port = String(targetPort);
  const targetPool = createPool(targetURL.toString(), 2);
  const report: Record<string, unknown> = {
    kind: "physical-scale-restore-comparison",
    startedAt: new Date().toISOString(),
    sourcePort,
    targetPort,
    orgId: fixture.orgId,
    databaseId: fixture.databaseId,
    tableId: fixture.tableId,
    acceptance: false,
    provenance: await sourceProvenance(),
    scope:
      "Read-only consistent source and restored-target PostgreSQL snapshots; complete native rows including normal ULIDs and every retained cell-event field. This does not replace artifact/key/deployment recovery verification.",
  };
  const source = await pools.owner.connect(),
    target = await targetPool.connect();
  try {
    const storage = new TableStorage({
      pool: pools.app,
      ddlPool: pools.ddl,
      cursorSecret: fixtureSecret("ROOTSET_CURSOR_SECRET"),
    });
    const table = await storage.getTable(
      fixtureActor(fixture),
      fixture.tableId,
    );
    for (const client of [source, target]) {
      await client.query(
        "SET statement_timeout='0'; SET idle_in_transaction_session_timeout='0'; SET timezone='UTC'",
      );
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    }
    const snapshots = [];
    for (const [name, client] of [
      ["source", source],
      ["target", target],
    ] as const) {
      const version = await client.query<{ version: string }>(
        "SELECT current_setting('server_version') AS version",
      );
      assert.ok(version.rows[0]!.version.startsWith("18."));
      const metadata = (
        await client.query(
          "SELECT id,org_id,database_id,name,schema_version,row_count,state,physical_name FROM rootset_control.tables WHERE id=$1",
          [fixture.tableId],
        )
      ).rows[0];
      const fields = (
        await client.query(
          "SELECT * FROM rootset_control.fields WHERE table_id=$1 ORDER BY position,id",
          [fixture.tableId],
        )
      ).rows;
      const count = Number(
        (
          await client.query<{ count: string }>(
            `SELECT count(*)::text count FROM ${quote(table.schemaName)}.${quote(table.physicalName)}`,
          )
        ).rows[0]!.count,
      );
      const historyCount = Number(
        (
          await client.query<{ count: string }>(
            "SELECT count(*)::text count FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2",
            [fixture.orgId, fixture.tableId],
          )
        ).rows[0]!.count,
      );
      assert.equal(count, 5000000);
      assert.equal(historyCount, 10001048);
      const trigger = (
        await client.query(
          "SELECT g.tgenabled FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND g.tgname='rootset_enforce'",
          [table.schemaName, table.physicalName],
        )
      ).rows[0];
      assert.equal(trigger?.tgenabled, "O");
      process.stdout.write(
        JSON.stringify({
          stage: `${name}-snapshot`,
          rows: count,
          historyEvents: historyCount,
        }) + "\n",
      );
      const rows = await tableChecksums(client, table, count),
        history = await historyChecksums(client, table.id);
      snapshots.push({
        name,
        version: version.rows[0]!.version,
        metadata,
        fields,
        count,
        historyCount,
        rows,
        history,
        trigger,
      });
    }
    assert.equal(snapshots[0]!.rows.sha256, snapshots[1]!.rows.sha256);
    assert.equal(snapshots[0]!.history.sha256, snapshots[1]!.history.sha256);
    assert.deepEqual(snapshots[0]!.metadata, snapshots[1]!.metadata);
    assert.deepEqual(snapshots[0]!.fields, snapshots[1]!.fields);
    report.snapshots = snapshots;
    report.result = "passed";
    await source.query("COMMIT");
    await target.query("COMMIT");
  } catch (error) {
    report.result = "failed";
    report.failure = error instanceof Error ? error.name : "UnknownError";
    throw error;
  } finally {
    await source.query("ROLLBACK");
    await target.query("ROLLBACK");
    source.release();
    target.release();
    report.finishedAt = new Date().toISOString();
    report.finalProvenance = await sourceProvenance();
    await writeFile(
      join(dirname(resolve(filename)), "physical-restore-comparison.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await closePools(pools);
    await targetPool.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  assert.ok(
    process.argv[2],
    "Pass scale-fixture.json and restored target PostgreSQL port.",
  );
  await comparePhysicalScaleRestore(
    process.argv[2]!,
    Number(process.argv[3] ?? 55460),
  );
}
