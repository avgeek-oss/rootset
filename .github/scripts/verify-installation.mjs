import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

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
function sql(query, role = "rootset_owner") {
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
  const mailPort = await unusedPort();
  const baseURL = `http://127.0.0.1:${webPort}`;
  content = content
    .replace(/^ROOTSET_BASE_URL=.*$/m, `ROOTSET_BASE_URL=${baseURL}`)
    .replace(/^ROOTSET_ENCRYPTION_KEY=.*$/m, "ROOTSET_ENCRYPTION_KEY=");
  content += `\nROOTSET_ENCRYPTION_KEYS=${JSON.stringify({ primary: config.ROOTSET_ENCRYPTION_KEY })}\n`;
  content += `ROOTSET_WEB_PORT=${webPort}\nROOTSET_MAIL_UI_PORT=${mailPort}\n`;
  content += `ROOTSET_RUNTIME_IMAGE=${process.env.ROOTSET_SMOKE_RUNTIME_IMAGE ?? "rootset-runtime:ci"}\n`;
  content += `ROOTSET_WEB_IMAGE=${process.env.ROOTSET_SMOKE_WEB_IMAGE ?? "rootset-web:ci"}\n`;
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
  const roles = sql(
    "SELECT json_agg(json_build_object('name',rolname,'superuser',rolsuper,'bypassRls',rolbypassrls)) FROM pg_roles WHERE rolname IN ('rootset_app','rootset_ddl','rootset_identity')",
  );
  assert.equal(roles.length, 3);
  assert.ok(roles.every((role) => !role.superuser && !role.bypassRls));
  report.checks.runtimeRolesRestricted = true;
  for (const role of ["rootset_app", "rootset_ddl", "rootset_identity"])
    assert.throws(() => sql("SET ROLE rootset_owner; SELECT true", role));
  const reporter = sql(
    "SET ROLE rootset_capacity_reporter; SELECT json_build_object('paths',(SELECT count(*) FROM rootset_control.capacity_storage_paths()),'checkpoint',rootset_control.capacity_report_checkpoint() IS NOT NULL)",
  );
  assert.ok(reporter.paths >= 2 && reporter.checkpoint);
  assert.throws(() =>
    sql(
      "SET ROLE rootset_capacity_reporter; SELECT count(*) FROM rootset_control.users",
    ),
  );
  assert.throws(() =>
    sql("SET ROLE rootset_capacity_reporter; SELECT true", "rootset_app"),
  );
  compose(
    "exec",
    "-T",
    "--user",
    "postgres",
    "postgres",
    "sh",
    "/usr/local/bin/rootset-postgres-health",
  );
  report.checks.narrowDatabaseHostReporter = true;
  for (const service of ["api", "worker"]) {
    compose(
      "exec",
      "-T",
      service,
      "node",
      "-e",
      "if(process.getuid()!==10001||process.env.ROOTSET_MIGRATION_DATABASE_URL||process.env.ROOTSET_OWNER_DB_PASSWORD)process.exit(1)",
    );
  }
  report.checks.ownerCredentialAbsent = true;
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
  const asset = html.match(/src="([^"\s]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.match(
    (await fetch(new URL(asset, baseURL))).headers.get("content-type"),
    /javascript/,
  );
  const fresh = await (await fetch(`${baseURL}/v1/setup`)).json();
  assert.deepEqual(fresh, { claimed: false, verified: false });
  const email = `installation-${Date.now()}@example.test`;
  const claim = await fetch(`${baseURL}/v1/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({
      bootstrapSecret: config.ROOTSET_BOOTSTRAP_SECRET,
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
        assert.equal(url.origin, baseURL);
        return url;
      }
    }
    return null;
  }, "bootstrap verification email");
  const verified = await fetch(verificationURL, { redirect: "manual" });
  assert.equal(verified.status, 302);
  assert.deepEqual(await (await fetch(`${baseURL}/v1/setup`)).json(), {
    claimed: true,
    verified: true,
  });
  report.stage = "operator_binding";
  compose(
    "run",
    "--rm",
    "--no-deps",
    "api",
    "node",
    "dist/operator.mjs",
    "bind",
    provision.userId,
    "--reason",
    "isolated installation verification",
  );
  const before = sql(
    "SELECT json_build_object('migrations',(SELECT count(*) FROM rootset_control.migrations),'users',(SELECT count(*) FROM rootset_control.users),'memberships',(SELECT count(*) FROM rootset_control.memberships WHERE state='active'),'operatorBindings',(SELECT count(*) FROM rootset_control.operator_bindings),'operatorAudit',(SELECT count(*) FROM rootset_control.account_audit WHERE operation='bindOperator'))",
  );
  assert.ok(before.migrations > 0);
  assert.equal(before.users, 1);
  assert.equal(before.memberships, 1);
  assert.equal(before.operatorBindings, 1);
  assert.equal(before.operatorAudit, 1);
  report.checks.bootstrapVerifiedAndAudited = true;
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
      const response = await fetch(`${baseURL}/v1/setup`);
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
    "SELECT json_build_object('migrations',(SELECT count(*) FROM rootset_control.migrations),'users',(SELECT count(*) FROM rootset_control.users),'memberships',(SELECT count(*) FROM rootset_control.memberships WHERE state='active'),'operatorBindings',(SELECT count(*) FROM rootset_control.operator_bindings),'operatorAudit',(SELECT count(*) FROM rootset_control.account_audit WHERE operation='bindOperator'))",
  );
  assert.deepEqual(after, before);
  report.checks.restartPreservesControlState = true;
  report.status = "passed";
  report.stage = "complete";
} catch (error) {
  report.status = "failed";
  report.errorKind = error?.constructor?.name;
  if (typeof error?.status === "number") report.childExitStatus = error.status;
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
