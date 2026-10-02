import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrate } from "@rootset/database";
import { openScaleTarget } from "./scale-profile-target.js";
import { sourceProvenance } from "./source-provenance.js";

async function run() {
  const [manifest, port, container] = process.argv.slice(2);
  assert.ok(manifest && port && container);
  const target = await openScaleTarget(manifest, Number(port), container);
  const report: Record<string, unknown> = {
    kind: "isolated-scale-target-upgrade",
    startedAt: new Date().toISOString(),
    targetPort: Number(port),
    targetContainer: container,
    sourceBefore: await sourceProvenance(),
    scope:
      "Migration-only upgrade of the explicit dedicated performance copy. Original source55448 and retained recovery55460 are untouched. Persisted object/SMTP configuration and copied-work quarantine are preserved.",
    gateSignOffs: [],
  };
  try {
    report.applied = await migrate(target.pools.owner);
    const table = await target.storage.getTable(
      target.actor,
      target.fixture.tableId,
    );
    assert.equal(table.rowCount, 5000000);
    assert.equal(table.fields.length, 24);
    report.fixture = {
      tableId: table.id,
      liveRowCounter: table.rowCount,
      schemaVersion: table.schemaVersion,
    };
    report.reporter = (
      await target.pools.owner.query(
        "SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='rootset_capacity_reporter'",
      )
    ).rows[0];
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.error = {
      name: error instanceof Error ? error.name : "UnknownError",
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined,
    };
    process.exitCode = 1;
  } finally {
    report.sourceAfter = await sourceProvenance();
    report.finishedAt = new Date().toISOString();
    const file = join(
      target.directory,
      `target-upgrade-${port}-${Date.now()}.json`,
    );
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    process.stdout.write(
      JSON.stringify({
        result: report.result,
        applied: report.applied,
        report: file,
      }) + "\n",
    );
    await target.close();
  }
}
if (import.meta.url === new URL(process.argv[1]!, "file:").href) await run();
