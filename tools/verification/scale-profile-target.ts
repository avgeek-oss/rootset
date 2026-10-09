import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Pool, createPool, migrate } from "@rootset/database";
import { TableStorage } from "../../packages/table-storage/src/index.js";
import { loadConfig } from "../../packages/core/src/config.js";
import { loadScaleFixture, fixtureActor } from "./scale-fixture.js";
import { fixtureSecret, root } from "./environment.js";
import { sourceProvenance } from "./source-provenance.js";

const run = promisify(execFile);
export async function openScaleTarget(
  manifest: string,
  port: number,
  container: string,
) {
  assert.ok(
    Number.isInteger(port) &&
      port >= 55000 &&
      port < 56000 &&
      port !== Number(new URL(fixtureSecret("ROOTSET_TEST_DATABASE_URL")).port),
  );
  assert.match(container, /^rootset-delivery-physical-recovery-[a-z0-9-]+$/);
  const inspected = JSON.parse(
    (
      await run("docker", [
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        container,
      ])
    ).stdout,
  ) as Record<string, { HostIp: string; HostPort: string }[]>;
  assert.ok(
    inspected["5432/tcp"]?.some(
      (binding) =>
        binding.HostIp === "127.0.0.1" && binding.HostPort === String(port),
    ),
    "Target is not the explicit loopback recovery container.",
  );
  const url = (name: string) => {
    const value = new URL(fixtureSecret(name));
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(value.hostname));
    value.hostname = "127.0.0.1";
    value.port = String(port);
    value.pathname = "/rootset";
    return value.toString();
  };
  const pools = {
    owner: new Pool({
      connectionString: url("ROOTSET_TEST_DATABASE_URL"),
      max: 4,
      options: "-c timezone=UTC -c statement_timeout=0",
    }),
    api: createPool(url("ROOTSET_TEST_DATABASE_URL"), 4),
    worker: createPool(url("ROOTSET_TEST_DATABASE_URL"), 2),
    ddl: createPool(url("ROOTSET_TEST_DATABASE_URL"), 4),
    identity: createPool(url("ROOTSET_TEST_DATABASE_URL"), 2),
  };
  const fixture = await loadScaleFixture(manifest),
    actor = fixtureActor(fixture);
  const config = loadConfig();
  const storage = new TableStorage({
    pool: pools.api,
    ddlPool: pools.ddl,
    cursorSecret: config.cursorSecret,
  });
  return {
    fixture,
    actor,
    config,
    pools,
    storage,
    container,
    port,
    directory: dirname(resolve(manifest)),
    close: () => Promise.all(Object.values(pools).map((pool) => pool.end())),
  };
}

export async function prepareScaleTarget(
  manifest: string,
  port: number,
  container: string,
) {
  const target = await openScaleTarget(manifest, port, container);
  const report: Record<string, unknown> = {
    kind: "isolated-scale-profile-preparation",
    startedAt: new Date().toISOString(),
    targetContainer: container,
    targetPort: port,
    sourceProvenance: await sourceProvenance(),
    profile:
      "Approved server cgroup budget: PostgreSQL4GiB/API1GiB/worker2GiB/web1GiB; unchanged performance thresholds.",
    scope:
      "Target-only QA adaptation of retained physical copy. The source remains unchanged. This setup is not credential-issuance or disaster-recovery sign-off.",
    acceptance: false,
  };
  try {
    report.migrationsApplied = await migrate(target.pools.owner);
    const table = await target.storage.getTable(
      target.actor,
      target.fixture.tableId,
    );
    assert.equal(table.rowCount, 5000000);
    assert.equal(table.fields.length, 24);
    report.targetFixture = {
      tableId: table.id,
      schemaVersion: table.schemaVersion,
      liveRowCounter: table.rowCount,
    };
    const quarantined = await target.pools.owner.query(
      "UPDATE rootset_control.jobs SET state='cancelled',stage='qa_quarantined',lease_token=NULL,lease_until=NULL,completed_at=now(),updated_at=now() WHERE state IN ('queued','running') RETURNING id",
    );
    report.copiedWorkQuarantine = {
      jobs: quarantined.rowCount,
      reason:
        "Do not replay copied user jobs or scheduled maintenance during benchmark setup.",
    };
    const keyPath = join(
      root,
      "apps/rootset-web/test-results/browser/scale-key-private.json",
    );
    assert.equal(
      (await stat(keyPath)).mode & 0o077,
      0,
      "Benchmark key must remain private.",
    );
    const key = JSON.parse(await readFile(keyPath, "utf8")) as {
      apiKey: string;
      orgId: string;
      tableId: string;
      databaseId: string;
    };
    assert.equal(key.orgId, target.fixture.orgId);
    assert.equal(key.tableId, target.fixture.tableId);
    const keyId = /^rst_([0-7][0-9A-HJKMNP-TV-Z]{25})_[A-Za-z0-9_-]{43}$/.exec(
      key.apiKey,
    )?.[1];
    assert.ok(keyId, "Expected actual Rootset issued key shape.");
    const source = createPool(fixtureSecret("ROOTSET_TEST_DATABASE_URL"), 1);
    try {
      const record = (
        await source.query(
          "SELECT * FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
          [keyId, target.fixture.orgId],
        )
      ).rows[0];
      assert.ok(
        record,
        "Actual issued benchmark key is revoked, expired or absent.",
      );
      const subject = (
        await target.pools.owner.query(
          "SELECT m.role,u.email_verified FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.org_id=$2",
          [record.user_id, target.fixture.orgId],
        )
      ).rows[0];
      assert.ok(
        subject && subject.email_verified && subject.role === "admin",
        "Restored subject must retain its actual verified Admin membership.",
      );
      await target.pools.owner.query(
        "INSERT INTO rootset_control.api_keys SELECT (json_populate_record(NULL::rootset_control.api_keys,$1::json)).* ON CONFLICT(id) DO NOTHING",
        [JSON.stringify(record)],
      );
      const copied = (
        await target.pools.owner.query(
          "SELECT secret_hash,expires_at FROM rootset_control.api_keys WHERE id=$1",
          [keyId],
        )
      ).rows[0];
      assert.equal(copied.secret_hash, record.secret_hash);
      report.benchmarkCredential = {
        id: keyId,
        expiresAt: copied.expires_at,
        userId: record.user_id,
        inheritedRole: subject.role,
        source:
          "Actual rendered recent-auth key issuance; one credential record copied to original restored subject for QA performance, outside auth/recovery evidence.",
      };
    } finally {
      await source.end();
    }
    await target.pools.owner.query(
      "CREATE EXTENSION IF NOT EXISTS pg_buffercache",
    );
    report.bufferProbeFunctions = (
      await target.pools.owner.query(
        "SELECT p.oid::regprocedure::text AS signature,p.proargnames FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pg_buffercache_evict%' ORDER BY p.proname",
      )
    ).rows;
    report.pgVersion = (
      await target.pools.owner.query(
        "SELECT current_setting('server_version') AS version",
      )
    ).rows[0]!.version;
    report.finishedAt = new Date().toISOString();
    report.result = "prepared";
  } catch (error) {
    report.result = "failed";
    report.error = {
      name: error instanceof Error ? error.name : "Unknown",
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "ASSERTION_OR_PREREQUISITE",
    };
    throw error;
  } finally {
    await writeFile(
      join(target.directory, `target-preparation-${port}.json`),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await target.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const [manifest, port, container] = process.argv.slice(2);
  if (!manifest || !port || !container)
    throw new Error(
      "Pass explicit scale manifest, recovery port and recovery container.",
    );
  try {
    await prepareScaleTarget(manifest, Number(port), container);
  } catch (error) {
    console.error(
      JSON.stringify({
        result: "failed",
        name: error instanceof Error ? error.name : "Unknown",
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "ASSERTION_OR_PREREQUISITE",
      }),
    );
    process.exitCode = 1;
  }
  if (process.exitCode) process.exit();
  console.log(JSON.stringify({ result: "prepared", targetPort: Number(port) }));
}
