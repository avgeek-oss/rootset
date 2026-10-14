import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requirePinnedInstallation, requireVerifiedChecks } from "./check.mjs";
import { inspectPublicImage, readReleaseImages } from "./images.mjs";
import { verifyPulledImage } from "./verify-installation.mjs";

const version = "0.1.0";
const commit = "a".repeat(40);
const passedChecks = () => ({
  check_runs: ["verify", "docs"].map((name) => ({
    name,
    app: { slug: "github-actions" },
    status: "completed",
    conclusion: "success",
  })),
});

test("publication requires both current successful GitHub Actions checks", () => {
  assert.doesNotThrow(() => requireVerifiedChecks(passedChecks()));
  for (const change of [
    (input) => input.check_runs.pop(),
    (input) => (input.check_runs[0].status = "in_progress"),
    (input) => (input.check_runs[0].conclusion = "failure"),
    (input) => (input.check_runs[1].conclusion = "skipped"),
    (input) => (input.check_runs[1].app.slug = "another-app"),
    (input) => input.check_runs.push(input.check_runs[0]),
  ]) {
    const input = passedChecks();
    change(input);
    assert.throws(() => requireVerifiedChecks(input));
  }
  assert.throws(() => requireVerifiedChecks({}));
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
