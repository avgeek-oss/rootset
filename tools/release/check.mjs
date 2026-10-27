import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function requireVerifiedChecks(pages, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/, "Supply the exact release commit");
  assert(Array.isArray(pages), "Missing check-run pages");
  for (const page of pages)
    assert(Array.isArray(page.check_runs), "Missing commit checks");
  const checks = pages.flatMap((page) => page.check_runs);
  for (const name of ["verify"]) {
    const matches = checks.filter(
      (check) =>
        check.name === name &&
        check.head_sha === commit &&
        check.app?.slug === "github-actions",
    );
    assert(matches.length, `Missing ${name} check for ${commit}`);
    assert(
      matches.every((check) => check.status === "completed"),
      `${name} is still queued or running on this commit`,
    );
    matches.sort((left, right) => {
      const a = left.started_at ?? left.created_at ?? left.completed_at ?? "";
      const b =
        right.started_at ?? right.created_at ?? right.completed_at ?? "";
      return a.localeCompare(b) || left.id - right.id;
    });
    assert.equal(
      matches.at(-1).conclusion,
      "success",
      `The latest ${name} check did not pass`,
    );
  }
}

export function requireVersionConsistency(version, appVersions) {
  assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  for (const app of ["api", "worker", "web"])
    assert.equal(appVersions[app], version, `${app} package version`);
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
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2)
    args.set(process.argv[index], process.argv[index + 1]);
  const checks = args.get("--checks");
  assert(checks, "Supply --checks and --commit");
  requireVerifiedChecks(
    JSON.parse(await readFile(checks, "utf8")),
    args.get("--commit"),
  );
}
