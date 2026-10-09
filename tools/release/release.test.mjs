import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { requireVerifiedChecks } from "./check.mjs";
import { inspectPublicImage } from "./images.mjs";

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
