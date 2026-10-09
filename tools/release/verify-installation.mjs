import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readReleaseImages } from "./images.mjs";

export function verifyPulledImage(image, architecture, version, commit) {
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, architecture);
  assert.equal(
    image.Config.Labels["org.opencontainers.image.version"],
    version,
  );
  assert.equal(
    image.Config.Labels["org.opencontainers.image.revision"],
    commit,
  );
  assert.equal(
    image.Config.Labels["org.opencontainers.image.source"],
    "https://github.com/avgeek-oss/rootset",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [path, version, commit, architecture] = process.argv.slice(2);
  assert.ok(["amd64", "arm64"].includes(architecture));
  assert.equal(process.platform, "linux", "Use a native Linux release runner");
  assert.equal(process.arch, architecture === "amd64" ? "x64" : "arm64");
  const manifest = await readReleaseImages(path, version, commit);
  for (const image of Object.values(manifest.images)) {
    execFileSync("docker", ["pull", image], { stdio: "inherit" });
    const inspected = JSON.parse(
      execFileSync(
        "docker",
        ["image", "inspect", image, "--format", "{{json .}}"],
        {
          encoding: "utf8",
        },
      ),
    );
    verifyPulledImage(inspected, architecture, version, commit);
  }
  execFileSync(process.execPath, [".github/scripts/verify-installation.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ROOTSET_SMOKE_SOURCE_REVISION: commit,
      ROOTSET_SMOKE_RUNTIME_IMAGE: manifest.images.api,
      ROOTSET_SMOKE_WEB_IMAGE: manifest.images.web,
      ROOTSET_SMOKE_CI_HOST_CPU: "1",
    },
  });
}
