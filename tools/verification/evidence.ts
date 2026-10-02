import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, after } from "node:test";
import { root } from "./environment.js";

interface CaseDefinition {
  id: string;
  gates: string[];
  scope: string;
}
interface CaseResult extends CaseDefinition {
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  failure?: string;
}
const results: CaseResult[] = [];
const startedAt = new Date().toISOString();
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;

async function sourceDigest(): Promise<string> {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path).update("\0");
    digest.update(await readFile(join(root, path))).update("\0");
  }
  return digest.digest("hex");
}
const beforeDigest = sourceDigest();

/** This records a test result, never a completed gate or reviewer approval. */
export function verificationCase(
  definition: CaseDefinition,
  work: () => Promise<void> | void,
): void {
  test(`${definition.id}: ${definition.scope}`, async () => {
    const began = new Date();
    let failure: string | undefined;
    try {
      await work();
    } catch (error) {
      // Do not persist arbitrary request bodies, auth headers or service messages.
      failure = error instanceof Error ? error.name : "UnknownError";
      throw error;
    } finally {
      const ended = new Date();
      results.push({
        ...definition,
        status: failure ? "failed" : "passed",
        startedAt: began.toISOString(),
        finishedAt: ended.toISOString(),
        durationMs: ended.getTime() - began.getTime(),
        ...(failure ? { failure } : {}),
      });
    }
  });
}

after(async () => {
  const initial = await beforeDigest;
  const final = await sourceDigest();
  const directory = join(
    root,
    "verification",
    process.env.ROOTSET_VERIFICATION_RUN ??
      `working-${startedAt.replaceAll(/[:.]/g, "-")}`,
  );
  await mkdir(directory, { recursive: true });
  const file = `${process.pid}-${process.env.ROOTSET_VERIFICATION_SUITE ?? "integration"}.json`;
  await writeFile(
    join(directory, file),
    JSON.stringify(
      {
        kind: "test-results",
        sourceCommit,
        dirty,
        sourceTreeDigestAtStart: initial,
        sourceTreeDigestAtEnd: final,
        coherentCandidate: initial === final && !dirty,
        startedAt,
        finishedAt: new Date().toISOString(),
        reviewers: [],
        gateSignOffs: [],
        cases: results,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
});
