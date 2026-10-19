import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  requirePinnedInstallation,
  requireVersionConsistency,
} from "./check.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const version = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).version;
const appVersions = Object.fromEntries(
  await Promise.all(
    ["api", "worker", "web"].map(async (app) => [
      app,
      JSON.parse(
        await readFile(
          path.join(root, `apps/rootset-${app}/package.json`),
          "utf8",
        ),
      ).version,
    ]),
  ),
);
requireVersionConsistency(version, appVersions);
const composePath = process.argv[2];
const compose = composePath
  ? JSON.parse(await readFile(composePath, "utf8"))
  : (await import("yaml")).parse(
      await readFile(path.join(root, "compose.images.yaml"), "utf8"),
    );
requirePinnedInstallation(
  compose,
  await readFile(path.join(root, "rootset.env.example"), "utf8"),
  version,
);
if (process.env.RELEASE_TAG)
  assert.equal(process.env.RELEASE_TAG, `v${version}`);
console.log(
  `Validated release ${version}: API, worker, web and Compose image versions match.`,
);
