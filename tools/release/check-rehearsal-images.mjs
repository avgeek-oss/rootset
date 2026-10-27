import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyPulledImage } from "./verify-installation.mjs";

// Images the release rehearsal builds and loads locally; nothing is pushed.
export const rehearsalImages = {
  api: "rootset-api:rehearsal",
  worker: "rootset-worker:rehearsal",
  web: "rootset-web:rehearsal",
};

// Apply the same platform, version, revision and source checks as a real
// release applies to its pulled images.
export function verifyRehearsalImages(inspect, architecture, version, commit) {
  assert.ok(["amd64", "arm64"].includes(architecture));
  assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.match(commit, /^[a-f0-9]{40}$/);
  for (const image of Object.values(rehearsalImages))
    verifyPulledImage(inspect(image), architecture, version, commit);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { RELEASE_ARCHITECTURE, RELEASE_VERSION, RELEASE_COMMIT } = process.env;
  verifyRehearsalImages(
    (image) =>
      JSON.parse(
        execFileSync(
          "docker",
          ["image", "inspect", image, "--format", "{{json .}}"],
          {
            encoding: "utf8",
          },
        ),
      ),
    RELEASE_ARCHITECTURE,
    RELEASE_VERSION,
    RELEASE_COMMIT,
  );
  console.log(
    `Rehearsal images carry the ${RELEASE_ARCHITECTURE} platform and release ${RELEASE_VERSION} labels for ${RELEASE_COMMIT}.`,
  );
}
