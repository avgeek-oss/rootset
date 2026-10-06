import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const token = process.env.NODE_AUTH_TOKEN;
if (!token)
  throw new Error("NODE_AUTH_TOKEN is required to install GitHub Packages.");
const destination = resolve(
  process.argv[2] ?? "verification/ci/package-registry.npmrc",
);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await writeFile(
  destination,
  `@avgeek-oss:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${token}\n`,
  { mode: 0o600 },
);
