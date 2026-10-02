import { readFile } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { auditEvidenceManifest } from "./verification/evidence-manifest.js";
import { gateReviewOracles } from "./verification/gate-review-oracles.js";

const checklist = await readFile(
  new URL(
    "../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md",
    import.meta.url,
  ),
  "utf8",
);
const requirements = [
  ...checklist.matchAll(/^- \[[ xX]\] `([A-Z]+-\d{2})` (.+)$/gm),
].map((match) => {
  const id = match[1]!;
  const positiveReviewOracle = gateReviewOracles.get(id);
  if (!positiveReviewOracle) throw new Error(`Missing review oracle for ${id}`);
  return { id, requirement: match[2]!, positiveReviewOracle };
});
const path = process.argv[2];
if (!path) throw new Error("Pass a candidate evidence manifest path");
const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
const run = promisify(execFile);
const result = await auditEvidenceManifest(manifest, {
  candidateCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceClean:
    execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim().length === 0,
  requirements,
  readArtifact: readFile,
  inspectImage: async (digest) => {
    const { stdout } = await run("docker", ["image", "inspect", digest], {
      timeout: 10000,
    });
    const inspected = JSON.parse(stdout) as {
      Id: string;
      RepoDigests?: string[];
      Config?: { Labels?: Record<string, string> };
    }[];
    const image = inspected.find(
      (image) => image.Id === digest || image.RepoDigests?.includes(digest),
    );
    return {
      available: !!image,
      sourceCommit:
        image?.Config?.Labels?.["org.opencontainers.image.revision"],
    };
  },
});
console.log(JSON.stringify(result, null, 2));
if (!result.acceptanceReady) process.exitCode = 1;
