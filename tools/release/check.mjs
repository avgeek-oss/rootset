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

export function requirePinnedInstallation(compose, environment, version) {
  assert.doesNotMatch(environment, /^\s*(?:export\s+)?ROOTSET_VERSION\s*=/m);
  for (const [name, service] of Object.entries(compose.services))
    assert(!service.build, `${name} must pull a published image`);
  for (const [service, image] of Object.entries({
    api: "api",
    worker: "worker",
    web: "web",
    migrate: "api",
  }))
    assert.equal(
      compose.services[service]?.image,
      `ghcr.io/avgeek-oss/rootset-${image}:${version}`,
      `${service} must be pinned to release ${version}`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [checks, compose, environment, version] = process.argv.slice(2);
  requireVerifiedChecks(JSON.parse(await readFile(checks, "utf8")));
  if (compose)
    requirePinnedInstallation(
      JSON.parse(await readFile(compose, "utf8")),
      await readFile(environment, "utf8"),
      version,
    );
}
