import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function requireVerifiedChecks(input) {
  const checks = input.check_runs;
  assert(Array.isArray(checks), "Missing commit checks");
  for (const name of ["verify", "docs"]) {
    const matches = checks.filter(
      (check) => check.name === name && check.app?.slug === "github-actions",
    );
    assert.equal(matches.length, 1, `Expected one current ${name} check`);
    assert.equal(matches[0].status, "completed", `${name} is not complete`);
    assert.equal(matches[0].conclusion, "success", `${name} did not pass`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  requireVerifiedChecks(JSON.parse(await readFile(process.argv[2], "utf8")));
