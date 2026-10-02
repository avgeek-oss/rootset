import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./environment.js";

export async function sourceProvenance(): Promise<{
  sourceCommit: string;
  dirty: boolean;
  sourceTreeDigest: string;
}> {
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path).update("\0");
    digest.update(await readFile(join(root, path))).update("\0");
  }
  return { sourceCommit, dirty, sourceTreeDigest: digest.digest("hex") };
}
