import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  requirePinnedInstallation,
  requireVerifiedChecks,
  requireVersionConsistency,
} from "./check.mjs";
import { inspectPublicImage, readReleaseImages } from "./images.mjs";
import { isNewestRelease } from "./latest.mjs";
import { verifyPulledImage } from "./verify-installation.mjs";

const version = "0.1.0";
const commit = "a".repeat(40);
const passedChecks = () => [
  {
    check_runs: ["verify"].map((name, id) => ({
      id: id + 1,
      name,
      head_sha: commit,
      started_at: "2026-10-19T00:00:00Z",
      app: { slug: "github-actions" },
      status: "completed",
      conclusion: "success",
    })),
  },
];

test("publication requires a successful verify check for the exact commit", () => {
  assert.doesNotThrow(() => requireVerifiedChecks(passedChecks(), commit));
  for (const name of ["verify"]) {
    for (const change of [
      (input, index) => input.splice(index, 1),
      (input, index) => (input[index].status = "queued"),
      (input, index) => (input[index].status = "in_progress"),
      (input, index) => (input[index].conclusion = "failure"),
      (input, index) => (input[index].conclusion = "skipped"),
      (input, index) => (input[index].conclusion = "cancelled"),
      (input, index) => (input[index].app.slug = "another-app"),
      (input, index) => (input[index].head_sha = "b".repeat(40)),
    ]) {
      const input = passedChecks();
      change(
        input[0].check_runs,
        input[0].check_runs.findIndex((check) => check.name === name),
      );
      assert.throws(() => requireVerifiedChecks(input, commit));
    }
  }
  for (const input of [{}, [{}], []])
    assert.throws(() => requireVerifiedChecks(input, commit));
  assert.throws(() => requireVerifiedChecks(passedChecks(), "main"));
});

test("publication reads all pages and rejects newer failed or unfinished reruns", () => {
  for (const name of ["verify"]) {
    const input = passedChecks();
    const original = input[0].check_runs.find((check) => check.name === name);
    const newer = { ...original, id: 20, started_at: "2026-10-19T00:00:01Z" };
    input.push({ check_runs: [newer] });
    original.conclusion = "failure";
    assert.doesNotThrow(() => requireVerifiedChecks(input, commit));
    original.conclusion = "success";
    newer.conclusion = "failure";
    assert.throws(() => requireVerifiedChecks(input, commit), /latest/);
    newer.conclusion = "success";
    newer.status = "in_progress";
    assert.throws(() => requireVerifiedChecks(input, commit), /running/);
    newer.status = "completed";
    newer.started_at = original.started_at;
    newer.conclusion = "failure";
    input.reverse();
    assert.throws(() => requireVerifiedChecks(input, commit), /latest/);
  }
});

test("the publication CLI checks paginated results and the supplied source commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rootset-checks-"));
  const file = join(directory, "checks.json");
  try {
    const checks = passedChecks()[0].check_runs;
    await writeFile(
      file,
      JSON.stringify([
        { check_runs: checks.slice(0, 1) },
        { check_runs: checks.slice(1) },
      ]),
    );
    const run = (sha) =>
      execFileSync(
        process.execPath,
        ["tools/release/check.mjs", "--commit", sha, "--checks", file],
        { stdio: "pipe" },
      );
    assert.doesNotThrow(() => run(commit));
    assert.throws(() => run("b".repeat(40)));
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("all application package versions must match a stable root version", () => {
  const apps = () => ({ api: version, worker: version, web: version });
  assert.doesNotThrow(() => requireVersionConsistency(version, apps()));
  for (const app of ["api", "worker", "web"]) {
    const input = apps();
    input[app] = "0.0.1";
    assert.throws(
      () => requireVersionConsistency(version, input),
      /package version/,
    );
    delete input[app];
    assert.throws(
      () => requireVersionConsistency(version, input),
      /package version/,
    );
  }
  for (const invalid of ["v0.1.0", "0.1.0-rc.1", "01.1.0", "0.1"])
    assert.throws(() => requireVersionConsistency(invalid, apps()));
});

test("version validation accepts rendered Compose JSON and rejects a mismatched release tag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rootset-version-"));
  const file = join(directory, "compose.json");
  try {
    await writeFile(
      file,
      JSON.stringify(parse(await readFile("compose.images.yaml", "utf8"))),
    );
    const currentVersion = JSON.parse(
      await readFile("package.json", "utf8"),
    ).version;
    const run = (tag) =>
      execFileSync(process.execPath, ["tools/release/validate.mjs", file], {
        env: { ...process.env, RELEASE_TAG: tag },
        stdio: "pipe",
      });
    assert.doesNotThrow(() => run(`v${currentVersion}`));
    assert.throws(() => run("v999.0.0"));
    const compose = parse(await readFile("compose.images.yaml", "utf8"));
    compose.services.worker.image = "ghcr.io/avgeek-oss/rootset-worker:0.0.1";
    await writeFile(file, JSON.stringify(compose));
    assert.throws(() => run(`v${currentVersion}`));
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("release builds cannot promote image digests before scanning every platform", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release-images.yml", "utf8"),
  );
  const build = workflow.jobs.build;
  assert.deepEqual(build.needs, ["prepare"]);
  assert.deepEqual(build.strategy.matrix.architecture, ["amd64", "arm64"]);
  const pushes = build.steps.filter((step) =>
    step.uses?.startsWith("docker/build-push-action@"),
  );
  assert.deepEqual(
    pushes.map((step) => step.id),
    ["build_api", "build_worker", "build_web"],
  );
  const recordIndex = build.steps.findIndex(
    (step) => step.name === "Record immutable platform digests",
  );
  assert(recordIndex > 0);
  for (const [service, target] of [
    ["api", "runtime"],
    ["worker", "worker"],
    ["web", "web"],
  ]) {
    const buildIndex = build.steps.findIndex(
      (step) => step.id === `build_${service}`,
    );
    const push = build.steps[buildIndex];
    assert.equal(push.with.target, target);
    assert.equal(push.with.platforms, "linux/${{ matrix.architecture }}");
    assert(
      push.with.outputs.startsWith(
        `type=image,name=ghcr.io/avgeek-oss/rootset-${service},push-by-digest=true,`,
      ),
    );
    const scanIndex = build.steps.findIndex(
      (step) =>
        step.uses?.startsWith("aquasecurity/trivy-action@") &&
        step.with?.["image-ref"] ===
          `ghcr.io/avgeek-oss/rootset-${service}@\${{ steps.build_${service}.outputs.digest }}`,
    );
    assert(scanIndex > buildIndex, `${service} is scanned after it is built`);
    assert(scanIndex < recordIndex, `${service} is scanned before promotion`);
    const scan = build.steps[scanIndex];
    assert.equal(scan.env.TRIVY_PLATFORM, "linux/${{ matrix.architecture }}");
    assert.equal(scan.with.scanners, "vuln");
    assert.equal(scan.with.severity, "HIGH,CRITICAL");
    assert.equal(scan.with["exit-code"], "1");
    assert(!scan["continue-on-error"]);
  }
  assert.equal(workflow.jobs.prepare.permissions.checks, "viewer");
  const gate = workflow.jobs.prepare.steps.find(
    (step) => step.name === "Require the latest exact-commit CI results",
  );
  assert.match(gate.run, /--paginate --slurp/);
  assert.match(gate.run, /--commit "\$RELEASE_COMMIT"/);
  const ci = parse(await readFile(".github/workflows/ci.yml", "utf8"));
  const sourceScan = ci.jobs.security.steps.find((step) =>
    step.uses?.startsWith("aquasecurity/trivy-action@"),
  );
  assert.equal(sourceScan.with["scan-type"], "fs");
  assert.equal(sourceScan.with.scanners, "vuln,secret");
  assert.equal(sourceScan.with.severity, "HIGH,CRITICAL");
  assert.equal(sourceScan.with["exit-code"], "1");
  assert(!sourceScan["continue-on-error"]);
});

test("installation files pin every application service to the release without a version setting", () => {
  const compose = () => ({
    services: Object.fromEntries(
      ["api", "worker", "web", "migrate"].map((service) => [
        service,
        {
          image: `ghcr.io/avgeek-oss/rootset-${service === "migrate" ? "api" : service}:${version}`,
        },
      ]),
    ),
  });
  const environment = "ROOTSET_WEB_URL=http://localhost:4300\n";
  assert.doesNotThrow(() =>
    requirePinnedInstallation(compose(), environment, version),
  );
  for (const change of [
    (input) => delete input.services.migrate,
    (input) => (input.services.worker.image = input.services.api.image),
    (input) =>
      (input.services.web.image = "ghcr.io/avgeek-oss/rootset-web:latest"),
    (input) =>
      (input.services.api.image =
        "ghcr.io/avgeek-oss/rootset-api:${ROOTSET_VERSION}"),
    (input) =>
      (input.services.migrate.image = "ghcr.io/avgeek-oss/rootset-api:0.0.1"),
    (input) => (input.services.api.build = "."),
  ]) {
    const input = compose();
    change(input);
    assert.throws(() => requirePinnedInstallation(input, environment, version));
  }
  assert.throws(() =>
    requirePinnedInstallation(
      compose(),
      `${environment}ROOTSET_VERSION=${version}\n`,
      version,
    ),
  );
});

function registryFixture({
  architectures = ["amd64", "arm64"],
  revision = commit,
  imageVersion = version,
} = {}) {
  const objects = new Map();
  const digest = (body) =>
    "sha256:" + createHash("sha256").update(body).digest("hex");
  const put = (value, kind) => {
    const body = JSON.stringify(value);
    const id = digest(body);
    objects.set(`${kind}/${id}`, body);
    return id;
  };
  const manifests = architectures.map((architecture) => {
    const config = put(
      {
        os: "linux",
        architecture,
        config: {
          Labels: {
            "org.opencontainers.image.revision": revision,
            "org.opencontainers.image.version": imageVersion,
          },
        },
      },
      "blobs",
    );
    return {
      platform: { os: "linux", architecture },
      digest: put({ config: { digest: config } }, "manifests"),
    };
  });
  const index = JSON.stringify({ manifests });
  objects.set(`manifests/${version}`, index);
  return {
    digest: digest(index),
    fetcher: async (url) => {
      if (url.includes("/token?"))
        return Response.json({ token: "anonymous-fixture" });
      const body = objects.get(url.split("/rootset-api/")[1]);
      return new Response(body ?? "missing", {
        status: body ? 200 : 404,
        headers: body ? { "docker-content-digest": digest(body) } : {},
      });
    },
  };
}

test("public image verification produces an immutable digest for matching platforms and labels", async () => {
  const fixture = registryFixture();
  assert.equal(
    await inspectPublicImage("rootset-api", version, commit, fixture.fetcher),
    `ghcr.io/avgeek-oss/rootset-api@${fixture.digest}`,
  );
});

test("private packages and incomplete platform coverage block publication", async () => {
  await assert.rejects(
    inspectPublicImage(
      "rootset-api",
      version,
      commit,
      async () => new Response(null, { status: 403 }),
    ),
    /anonymous pull token failed/,
  );
  for (const architectures of [["amd64"], ["amd64", "arm64", "arm64"]]) {
    const fixture = registryFixture({ architectures });
    await assert.rejects(
      inspectPublicImage("rootset-api", version, commit, fixture.fetcher),
      /Missing or duplicate linux\/arm64/,
    );
  }
});

test("wrong source, version and content digests block publication", async () => {
  for (const options of [
    { revision: "b".repeat(40) },
    { imageVersion: "0.2.0" },
  ]) {
    const fixture = registryFixture(options);
    await assert.rejects(
      inspectPublicImage("rootset-api", version, commit, fixture.fetcher),
    );
  }
  const fixture = registryFixture();
  await assert.rejects(
    inspectPublicImage("rootset-api", version, commit, async (url, options) => {
      const response = await fixture.fetcher(url, options);
      if (url.includes("/manifests/"))
        response.headers.set(
          "docker-content-digest",
          "sha256:" + "0".repeat(64),
        );
      return response;
    }),
  );
});

test("installation requires reviewed immutable API, worker and web images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rootset-release-"));
  const path = join(directory, "images.json");
  const manifest = () => ({
    version,
    commit,
    platforms: ["linux/amd64", "linux/arm64"],
    images: {
      api: `ghcr.io/avgeek-oss/rootset-api@sha256:${"1".repeat(64)}`,
      worker: `ghcr.io/avgeek-oss/rootset-worker@sha256:${"3".repeat(64)}`,
      web: `ghcr.io/avgeek-oss/rootset-web@sha256:${"2".repeat(64)}`,
    },
  });
  try {
    await writeFile(path, JSON.stringify(manifest()));
    assert.deepEqual(
      await readReleaseImages(path, version, commit),
      manifest(),
    );
    for (const change of [
      (input) => (input.version = "0.2.0"),
      (input) => (input.commit = "b".repeat(40)),
      (input) => input.platforms.pop(),
      (input) => delete input.images.web,
      (input) => delete input.images.worker,
      (input) => (input.images.api = "ghcr.io/avgeek-oss/rootset-api:latest"),
      (input) => (input.images.web = input.images.api),
      (input) => (input.images.worker = input.images.api),
    ]) {
      const input = manifest();
      change(input);
      await writeFile(path, JSON.stringify(input));
      await assert.rejects(readReleaseImages(path, version, commit));
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("installation rejects a pulled image from another platform or source", () => {
  const image = () => ({
    Os: "linux",
    Architecture: "arm64",
    Config: {
      Labels: {
        "org.opencontainers.image.source":
          "https://github.com/avgeek-oss/rootset",
        "org.opencontainers.image.revision": commit,
        "org.opencontainers.image.version": version,
      },
    },
  });
  assert.doesNotThrow(() =>
    verifyPulledImage(image(), "arm64", version, commit),
  );
  for (const change of [
    (input) => (input.Architecture = "amd64"),
    (input) => (input.Os = "windows"),
    (input) =>
      (input.Config.Labels["org.opencontainers.image.version"] = "0.2.0"),
    (input) =>
      (input.Config.Labels["org.opencontainers.image.revision"] = "b".repeat(
        40,
      )),
    (input) =>
      (input.Config.Labels["org.opencontainers.image.source"] =
        "https://github.com/example/rootset"),
  ]) {
    const input = image();
    change(input);
    assert.throws(() => verifyPulledImage(input, "arm64", version, commit));
  }
});

test("a release is Latest only when no newer stable release is published", () => {
  assert.equal(isNewestRelease("v1.0.6", []), true);
  assert.equal(isNewestRelease("v1.0.6", ["v1.0.5", "v0.9.12"]), true);
  // Compares numerically, not as text.
  assert.equal(isNewestRelease("v1.0.10", ["v1.0.9"]), true);
  assert.equal(isNewestRelease("v1.0.5", ["v1.0.6"]), false);
  assert.equal(isNewestRelease("v1.2.0", ["v1.10.0"]), false);
  assert.equal(isNewestRelease("v1.9.9", ["v2.0.0"]), false);
  // The release itself and unrelated tags do not block it.
  assert.equal(isNewestRelease("v1.0.6", ["v1.0.6", "nightly"]), true);
  assert.throws(() => isNewestRelease("1.0.6", []), /not a stable release/);
  assert.throws(() => isNewestRelease("v1.0.6-rc.1", []), /not a stable/);
});
