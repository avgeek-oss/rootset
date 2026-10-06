import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
/** Ordinary candidate metadata; this is not a source admission or acceptance check. */
export async function sourceProvenance(): Promise<{
  sourceCommit: string;
  dirty: boolean;
}> {
  return {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim().length > 0,
  };
}
