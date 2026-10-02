import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const checklist = await readFile(
  new URL(
    "../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md",
    import.meta.url,
  ),
  "utf8",
);
const ids = [...checklist.matchAll(/^- \[[ xX]\] `([A-Z]+-\d{2})`/gm)].map(
  (match) => match[1]!,
);
const path = process.argv[2];
if (!path) throw new Error("Pass a candidate evidence manifest path");
interface GateEvidence {
  status: "passed" | "failed" | "pending";
  testCases: string[];
  artifacts: { path: string; sha256: string }[];
  reviewer: string;
  candidateCommit: string;
}
interface Manifest {
  candidateCommit: string;
  imageDigests: Record<string, string>;
  gates: Record<string, GateEvidence>;
}
const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
const failures: string[] = [];
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (manifest.candidateCommit !== head)
  failures.push("Candidate source does not match HEAD");
if (!Object.keys(manifest.imageDigests ?? {}).length)
  failures.push("Immutable image digests are missing");
for (const id of ids) {
  const evidence = manifest.gates[id];
  if (
    !evidence ||
    evidence.status !== "passed" ||
    evidence.candidateCommit !== manifest.candidateCommit ||
    !evidence.reviewer ||
    !evidence.testCases.length ||
    !evidence.artifacts.length
  ) {
    failures.push(`${id}: reviewed passing evidence missing`);
    continue;
  }
  for (const artifact of evidence.artifacts) {
    try {
      const bytes = await readFile(artifact.path);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
        failures.push(`${id}: artifact checksum mismatch ${artifact.path}`);
    } catch {
      failures.push(`${id}: artifact unavailable ${artifact.path}`);
    }
  }
}
const failedGates = new Set(
  failures.flatMap((f) => {
    const match = /^(\w+-\d\d):/.exec(f);
    return match ? [match[1]] : [];
  }),
);
console.log(
  JSON.stringify(
    {
      requiredGates: ids.length,
      verified: ids.length - failedGates.size,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
