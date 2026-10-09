import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export async function inspectPublicImage(
  repository,
  version,
  commit,
  fetcher = fetch,
) {
  const prefix = "avgeek-oss/" + repository;
  const auth = await fetcher(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${prefix}:pull`,
  );
  assert(
    auth.ok,
    `${repository}: anonymous pull token failed; make the package public before publishing the release`,
  );
  const { token } = await auth.json();
  assert.equal(typeof token, "string");
  async function request(suffix) {
    const response = await fetcher(`https://ghcr.io/v2/${prefix}/${suffix}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
      },
    });
    assert(response.ok, `${repository}: ${suffix} returned ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const digest = "sha256:" + createHash("sha256").update(body).digest("hex");
    const declared = response.headers.get("docker-content-digest");
    if (declared) assert.equal(declared, digest);
    return { digest, value: JSON.parse(body.toString()) };
  }
  const index = await request("manifests/" + version);
  assert(
    Array.isArray(index.value.manifests),
    "Expected multi-platform manifest",
  );
  for (const architecture of ["amd64", "arm64"]) {
    const matches = index.value.manifests.filter(
      (item) =>
        item.platform?.os === "linux" &&
        item.platform.architecture === architecture,
    );
    assert.equal(
      matches.length,
      1,
      `Missing or duplicate linux/${architecture}`,
    );
    const manifest = await request("manifests/" + matches[0].digest);
    assert.equal(manifest.digest, matches[0].digest);
    const config = await request("blobs/" + manifest.value.config.digest);
    assert.equal(config.digest, manifest.value.config.digest);
    assert.equal(config.value.os, "linux");
    assert.equal(config.value.architecture, architecture);
    assert.equal(
      config.value.config.Labels["org.opencontainers.image.revision"],
      commit,
    );
    assert.equal(
      config.value.config.Labels["org.opencontainers.image.version"],
      version,
    );
  }
  return `ghcr.io/${prefix}@${index.digest}`;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [version, commit, output] = process.argv.slice(2);
  assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.match(commit, /^[0-9a-f]{40}$/);
  const images = {};
  for (const service of ["api", "web"])
    images[service] = await inspectPublicImage(
      "rootset-" + service,
      version,
      commit,
    );
  await writeFile(
    output,
    JSON.stringify(
      { version, commit, platforms: ["linux/amd64", "linux/arm64"], images },
      null,
      2,
    ) + "\n",
  );
}
