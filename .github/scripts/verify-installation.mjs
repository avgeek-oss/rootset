import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  classifyChildFailure,
  dockerHostSummary,
  failureContainerSummaries,
} from "./installation-diagnostics.mjs";
import {
  assertMigrationLedger,
  candidateMigrationInventory,
} from "./migration-inventory.mjs";

const root = process.cwd();
const project = `rootset-install-${Date.now()}`;
const directory = resolve(root, "verification", "ci", project);
await mkdir(directory, { recursive: true, mode: 0o700 });
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("ROOTSET_")),
);
const report = { startedAt: new Date().toISOString(), project, checks: {} };
const reportPath = resolve(root, "verification", "ci", "installation.json");
const envPath = resolve(directory, ".env");
const composeArguments = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  envPath,
  "--profile",
  "local",
];
let started = false;

function compose(...args) {
  return execFileSync("docker", [...composeArguments, ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000,
  }).trim();
}
async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function poll(check, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function sql(query, role = "rootset") {
  return JSON.parse(
    compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "--no-psqlrc",
      "--quiet",
      "--username",
      role,
      "--dbname",
      "rootset",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      query,
    ),
  );
}

try {
  report.stage = "docker_host";
  report.dockerHost = dockerHostSummary(
    JSON.parse(
      execFileSync("docker", ["info", "--format", "{{json .}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ),
  );
  report.postgresCPUProfile = {
    shippedDefaultCPUs: 4,
    configuredCPUs: 4,
    ciHostOverride: false,
  };
  report.stage = "candidate_migration_inventory";
  report.migrationInventory = await candidateMigrationInventory(root);
  report.stage = "protected_configuration";
  execFileSync(process.execPath, [resolve(root, "tools", "setup-env.ts")], {
    cwd: directory,
    env: environment,
    stdio: "pipe",
  });
  let content = await readFile(envPath, "utf8");
  const config = Object.fromEntries(
    content
      .split("\n")
      .filter((line) => /^ROOTSET_[A-Z0-9_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  const webPort = await unusedPort();
  let apiPort = await unusedPort();
  while (apiPort === webPort) apiPort = await unusedPort();
  const mailPort = await unusedPort();
  const baseURL = `http://127.0.0.1:${webPort}`;
  const apiURL = `http://127.0.0.1:${apiPort}`;
  content = content
    .replace(/^ROOTSET_WEB_URL=.*$/m, `ROOTSET_WEB_URL=${baseURL}`)
    .replace(/^ROOTSET_API_URL=.*$/m, `ROOTSET_API_URL=${apiURL}`);
  content += `ROOTSET_WEB_PORT=${webPort}\nROOTSET_API_PORT=${apiPort}\nROOTSET_MAIL_UI_PORT=${mailPort}\n`;
  content += `ROOTSET_RUNTIME_IMAGE=${process.env.ROOTSET_SMOKE_RUNTIME_IMAGE ?? "rootset-runtime:ci"}\n`;
  content += `ROOTSET_WEB_IMAGE=${process.env.ROOTSET_SMOKE_WEB_IMAGE ?? "rootset-web:ci"}\n`;
  if (process.env.ROOTSET_SMOKE_CI_HOST_CPU === "1") {
    assert.equal(process.env.CI, "true");
    const configuredCPUs = Math.min(4, report.dockerHost.availableCPUs);
    content += `ROOTSET_POSTGRES_CPUS=${configuredCPUs}\n`;
    report.postgresCPUProfile.configuredCPUs = configuredCPUs;
    report.postgresCPUProfile.ciHostOverride = true;
  }
  await writeFile(envPath, content, { mode: 0o600 });
  started = true;
  report.stage = "compose_start";
  compose("up", "--no-build", "--detach", "--wait", "--wait-timeout", "180");

  const ids = compose("ps", "--all", "--quiet").split("\n");
  const containers = JSON.parse(
    execFileSync("docker", ["inspect", ...ids], { encoding: "utf8" }),
  );
  report.containers = containers.map((container) => ({
    service: container.Config.Labels["com.docker.compose.service"],
    imageId: container.Image,
    sourceRevision:
      container.Config.Labels["org.opencontainers.image.revision"] ?? null,
    user: container.Config.User,
    readOnly: container.HostConfig.ReadonlyRootfs,
    memoryBytes: container.HostConfig.Memory,
    memorySwapBytes: container.HostConfig.MemorySwap,
    cpuQuota: container.HostConfig.NanoCpus / 1e9,
    healthy: container.State.Health?.Status,
    exitCode: container.State.ExitCode,
  }));
  for (const container of report.containers) {
    assert.ok(container.user && !["0", "root", "0:0"].includes(container.user));
    if (["migrate", "objects-init"].includes(container.service))
      assert.equal(container.exitCode, 0);
    if (["api", "worker", "web"].includes(container.service)) {
      assert.equal(container.readOnly, true);
      assert.equal(container.healthy, "healthy");
    }
    if (
      process.env.ROOTSET_SMOKE_SOURCE_REVISION &&
      ["migrate", "objects-init", "api", "worker", "web"].includes(
        container.service,
      )
    )
      assert.equal(
        container.sourceRevision,
        process.env.ROOTSET_SMOKE_SOURCE_REVISION,
      );
  }
  report.checks.nonrootAndReadonly = true;
  report.stage = "installed_migration_inventory";
  const installedMigrations = () =>
    sql(
      "SELECT coalesce(json_agg(json_build_object('name',name,'digest',digest) ORDER BY name),'[]'::json) FROM rootset_control.migrations",
    );
  assertMigrationLedger(installedMigrations(), report.migrationInventory);
  report.checks.exactCandidateMigrationLedger = true;
  const expectedMemory = {
    postgres: 4 * 1024 ** 3,
    api: 1024 ** 3,
    worker: 2 * 1024 ** 3,
    web: 1024 ** 3,
  };
  for (const [service, bytes] of Object.entries(expectedMemory)) {
    const container = report.containers.find(
      (container) => container.service === service,
    );
    assert.equal(container.memoryBytes, bytes);
    assert.equal(container.memorySwapBytes, bytes);
  }
  assert.equal(
    report.containers.find((container) => container.service === "postgres")
      .cpuQuota,
    report.postgresCPUProfile.configuredCPUs,
  );
  report.checks.eightGiBRuntimeLimits = true;
  report.nodeHeaps = {};
  for (const service of ["api", "worker", "web"]) {
    const heap = JSON.parse(
      compose(
        "exec",
        "-T",
        service,
        "node",
        "-e",
        "console.log(JSON.stringify({node:process.version,options:process.env.NODE_OPTIONS,heapLimitBytes:require('node:v8').getHeapStatistics().heap_size_limit,maxHttpHeaderBytes:require('node:http').maxHeaderSize}))",
      ),
    );
    assert.ok(heap.heapLimitBytes < expectedMemory[service]);
    assert.equal(
      heap.options,
      service === "worker"
        ? "--max-old-space-size=1536"
        : "--max-old-space-size=768 --max-http-header-size=196608",
    );
    if (service !== "worker") assert.equal(heap.maxHttpHeaderBytes, 196608);
    report.nodeHeaps[service] = heap;
  }
  report.checks.nodeHeapLeavesCgroupHeadroom = true;
  report.stage = "runtime_authority";
  const role = sql(
    "SELECT json_build_object('superuser',rolsuper,'bypassRls',rolbypassrls) FROM pg_roles WHERE rolname=current_user",
  );
  assert.equal(role.superuser, false);
  assert.equal(role.bypassRls, false);
  report.checks.runtimeRoleRestricted = true;
  assert.equal(
    sql(
      "SELECT rolpassword IS NULL FROM pg_authid WHERE rolname='postgres'",
      "postgres",
    ),
    true,
  );
  report.checks.bundledAdminPasswordDisabled = true;
  for (const service of ["api", "worker"]) {
    compose(
      "exec",
      "-T",
      service,
      "node",
      "-e",
      "if(process.getuid()!==10001||!process.env.ROOTSET_DATABASE_URL||!process.env.ROOTSET_SECRET)process.exit(1)",
    );
  }
  report.stage = "ciphertext_spool";
  for (const service of ["api", "worker"]) {
    compose(
      "exec",
      "-T",
      service,
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.env.ROOTSET_ARTIFACT_TEMP_DIR;if(p!=='/var/lib/rootset/artifact-spool')process.exit(1);const s=fs.statSync(p),d=fs.statfsSync(p,{bigint:true});if(s.uid!==10001||(s.mode&0o777)!==0o700||d.bavail*d.bsize<2n*1024n**3n)process.exit(1);const f=p+'/installation-probe';fs.writeFileSync(f,'ciphertext-capacity-probe',{flag:'wx',mode:0o600});if((fs.statSync(f).mode&0o777)!==0o600)process.exit(1);fs.unlinkSync(f)",
    );
  }
  report.checks.nonrootDiskSpoolAndReserve = true;
  compose("exec", "-T", "worker", "node", "dist/worker-health.mjs");
  assert.throws(() =>
    compose(
      "exec",
      "-T",
      "worker",
      "env",
      "ROOTSET_WORKER_ID_FILE=/tmp/nonexistent-worker",
      "node",
      "dist/worker-health.mjs",
    ),
  );
  report.checks.workerRequiresOwnIdentity = true;

  report.stage = "bootstrap_verification";
  const response = await fetch(`${baseURL}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Rootset/);
  assert.ok(
    html.includes(`window.__ROOTSET_API_ORIGIN=${JSON.stringify(apiURL)}`),
  );
  const asset = html.match(/src="([^"\s]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.match(
    (await fetch(new URL(asset, baseURL))).headers.get("content-type"),
    /javascript/,
  );
  const freshResponse = await fetch(`${apiURL}/v1/setup`, {
    headers: { origin: baseURL },
  });
  assert.equal(
    freshResponse.headers.get("access-control-allow-origin"),
    baseURL,
  );
  const fresh = await freshResponse.json();
  assert.deepEqual(fresh, { claimed: false, verified: false });
  const email = `installation-${Date.now()}@example.test`;
  const claim = await fetch(`${apiURL}/v1/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({
      bootstrapSecret: config.ROOTSET_SECRET,
      name: "Installation Reviewer",
      email,
      password: randomBytes(32).toString("base64url"),
      organisationName: "Installation Fixture",
    }),
  });
  assert.equal(claim.status, 201);
  const provision = await claim.json();
  assert.match(provision.userId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const verificationURL = await poll(async () => {
    const list = await (
      await fetch(`http://127.0.0.1:${mailPort}/api/v1/messages`)
    ).json();
    for (const message of list.messages ?? []) {
      const detail = await (
        await fetch(`http://127.0.0.1:${mailPort}/api/v1/message/${message.ID}`)
      ).json();
      const text = `${detail.Text ?? ""} ${detail.HTML ?? ""}`;
      const value = text.match(
        /https?:\/\/[^\s"<>]+\/v1\/auth\/verify-email[^\s"<>]*/,
      )?.[0];
      if (value) {
        const url = new URL(value.replaceAll("&amp;", "&"));
        assert.equal(url.origin, apiURL);
        return url;
      }
    }
    return null;
  }, "bootstrap verification email");
  const verified = await fetch(verificationURL, { redirect: "manual" });
  assert.equal(verified.status, 302);
  assert.deepEqual(await (await fetch(`${apiURL}/v1/setup`)).json(), {
    claimed: true,
    verified: true,
  });
  const before = sql(
    "SELECT json_build_object('migrations',(SELECT count(*) FROM rootset_control.migrations),'users',(SELECT count(*) FROM rootset_control.users),'memberships',(SELECT count(*) FROM rootset_control.memberships),'admins',(SELECT count(*) FROM rootset_control.memberships WHERE role='admin'))",
  );
  assert.equal(before.migrations, report.migrationInventory.count);
  assert.equal(before.users, 1);
  assert.equal(before.memberships, 1);
  assert.equal(before.admins, 1);
  report.checks.bootstrapVerifiedWithAdmin = true;
  report.stage = "preserved_restart";
  compose("restart", "api", "worker", "web");
  await poll(async () => {
    const live = JSON.parse(
      execFileSync("docker", ["inspect", ...ids], { encoding: "utf8" }),
    );
    return live
      .filter((container) =>
        ["api", "worker", "web"].includes(
          container.Config.Labels["com.docker.compose.service"],
        ),
      )
      .every((container) => container.State.Health?.Status === "healthy");
  }, "runtime health after restart");
  const resumedSetup = await poll(async () => {
    try {
      const response = await fetch(`${apiURL}/v1/setup`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }, "setup read after service restart");
  assert.deepEqual(resumedSetup, {
    claimed: true,
    verified: true,
  });
  const after = sql(
    "SELECT json_build_object('migrations',(SELECT count(*) FROM rootset_control.migrations),'users',(SELECT count(*) FROM rootset_control.users),'memberships',(SELECT count(*) FROM rootset_control.memberships),'admins',(SELECT count(*) FROM rootset_control.memberships WHERE role='admin'))",
  );
  assert.deepEqual(after, before);
  assertMigrationLedger(installedMigrations(), report.migrationInventory);
  report.checks.restartPreservesExactMigrationLedger = true;
  report.checks.restartPreservesControlState = true;
  report.status = "passed";
  report.stage = "complete";
} catch (error) {
  report.status = "failed";
  report.errorKind = error?.constructor?.name;
  if (typeof error?.status === "number") report.childExitStatus = error.status;
  report.childFailure = classifyChildFailure(error);
  if (started) {
    try {
      const ids = compose("ps", "--all", "--quiet").split("\n").filter(Boolean);
      if (ids.length)
        report.failureContainers = failureContainerSummaries(
          JSON.parse(
            execFileSync("docker", ["inspect", ...ids], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            }),
          ),
          project,
        );
    } catch {
      report.failureStateUnavailable = true;
    }
  }
  report.error =
    error instanceof assert.AssertionError
      ? `Assertion failed: ${error.code}`
      : "Installation verification failed; inspect the isolated fixture locally.";
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  if (started && process.env.ROOTSET_SMOKE_KEEP !== "1") {
    try {
      compose("down", "--volumes", "--remove-orphans");
      report.fixtureRemoved = true;
    } catch {
      report.fixtureRemoved = false;
      process.exitCode = 1;
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks,
      report: reportPath,
    }),
  );
}
