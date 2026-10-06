import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
const candidate = {
  version:
    process.env.ROOTSET_CANDIDATE_VERSION ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  workingTreeChanged:
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0,
};

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
  const directory = join(
    root,
    "verification",
    process.env.ROOTSET_VERIFICATION_RUN ??
      `working-${startedAt.replaceAll(/[:.]/g, "-")}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = `${process.pid}-${process.env.ROOTSET_VERIFICATION_SUITE ?? "integration"}.json`;
  await writeFile(
    join(directory, file),
    JSON.stringify(
      {
        kind: "test-results",
        candidate,
        acceptance: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        cases: results,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
});
