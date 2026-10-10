import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  generateClientSource,
  generateCoverageInventory,
  generateMcpTools,
  generateOpenApi,
  operations,
} from "@rootset/contracts";

const destination = new URL(
  "../packages/contracts/generated/",
  import.meta.url,
);
const configuration =
  (await resolveConfig(
    fileURLToPath(new URL("../package.json", import.meta.url)),
  )) ?? {};
const documents: Record<string, string> = {};
for (const [name, value] of Object.entries({
  "openapi.json": generateOpenApi(),
  "internal-openapi.json": generateOpenApi({ internal: true }),
  "mcp-tools.json": generateMcpTools(),
  "operation-inventory.json": generateCoverageInventory(),
}))
  documents[name] = await format(JSON.stringify(value), {
    ...configuration,
    parser: "json",
  });
documents["client.ts"] = await format(generateClientSource(), {
  ...configuration,
  parser: "typescript",
});
const sha256 = Object.fromEntries(
  Object.entries(documents)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => [
      name,
      createHash("sha256").update(content).digest("hex"),
    ]),
);
const contractDigest = createHash("sha256")
  .update(JSON.stringify(sha256))
  .digest("hex");
documents["manifest.json"] = await format(
  JSON.stringify({
    formatVersion: 1,
    openapiVersion: "3.1.2",
    operationCount: operations.length,
    contractDigest,
    sha256,
  }),
  { ...configuration, parser: "json" },
);
if (process.argv.includes("--check")) {
  const mismatches: string[] = [];
  for (const [name, expected] of Object.entries(documents)) {
    const existing = await readFile(new URL(name, destination), "utf8").catch(
      () => null,
    );
    if (existing !== expected) mismatches.push(name);
  }
  if (mismatches.length)
    throw new Error(
      `Generated contracts differ: ${mismatches.join(", ")}. Run pnpm contracts:generate.`,
    );
  console.log(
    `Validated ${operations.length} operations; contract digest ${contractDigest}.`,
  );
} else {
  await mkdir(destination, { recursive: true });
  for (const [name, content] of Object.entries(documents))
    await writeFile(new URL(name, destination), content);
  console.log(
    `Generated ${operations.length} operations; contract digest ${contractDigest}.`,
  );
}
