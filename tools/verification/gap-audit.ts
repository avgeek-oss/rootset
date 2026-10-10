import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evidencePlan } from "./gate-audit.js";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(
  process.argv[2] ?? join(root, "verification", `v1-gaps-${Date.now()}`),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const plan = await evidencePlan();
const report = {
  ...plan,
  kind: "v1-pending-checks",
  checksWithoutTestPointers: plan.checks
    .filter((check) => !check.testSources.length)
    .map((check) => check.id),
};
const path = join(directory, "pending-checks.json");
await writeFile(path, JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
process.stdout.write(
  JSON.stringify({ report: path, acceptance: false }) + "\n",
);
