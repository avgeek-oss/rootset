import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditEvidenceManifest } from "./verification/evidence-manifest.js";
import { requirements } from "./verification/gate-audit.js";

const manifestPath = process.argv[2];
if (!manifestPath)
  throw new Error(
    "Pass the current V1 result report JSON path and candidate/version.",
  );
const manifest = JSON.parse(
  await readFile(resolve(manifestPath), "utf8"),
) as unknown;
const candidateVersion = process.argv[3];
if (!candidateVersion)
  throw new Error("Pass the exact candidate/version as the second argument.");
const result = await auditEvidenceManifest(manifest, {
  candidateVersion,
  requirements: await requirements(),
  readArtifact: (path) => readFile(resolve(path)),
});
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (!result.reportComplete) process.exitCode = 1;
