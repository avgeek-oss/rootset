import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
const root = path.resolve(import.meta.dirname, "../..");
const specText = await readFile(
  path.join(root, "packages/contracts/generated/openapi.json"),
  "utf8",
);
const spec = JSON.parse(specText);
await mkdir(path.join(root, "docs/api-reference"), { recursive: true });
await writeFile(path.join(root, "docs/api-reference/openapi.json"), specText);
const groups = new Map();
const tools = [];
for (const [url, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
    const tag = op.tags?.[0] ?? "API";
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push("api-reference/" + op.operationId);
    const words = op.operationId
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
    const title = words[0].toUpperCase() + words.slice(1);
    const page = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(op.summary)}\nopenapi: ${JSON.stringify("/api-reference/openapi.json " + method.toUpperCase() + " " + url)}\n---\n`;
    await writeFile(
      path.join(root, "docs/api-reference", op.operationId + ".mdx"),
      await format(page, { parser: "mdx" }),
    );
    if (op["x-rootset-mcp-tool"])
      tools.push(
        `| \`${op["x-rootset-mcp-tool"]}\` | ${op.summary} | ${op["x-rootset-minimum-role"]} |`,
      );
  }
}
const configPath = path.join(root, "docs/site.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
config.navigation.dropdowns.find(
  (item) => item.dropdown === "API reference",
).groups = [...groups].map(([group, pages]) => ({
  group: group.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  pages,
}));
await writeFile(
  configPath,
  await format(JSON.stringify(config), { parser: "json" }),
);
const mcp = `---\ntitle: "MCP tools"\ndescription: "Current tools and minimum workspace roles generated from the public operation contract."\n---\n\nRootset exposes the same operations through REST and MCP. Minimum roles below describe product authority; your credential must also carry the operation scopes. Personal account operations require a personal identity.\n\n| Tool | Action | Minimum role |\n| --- | --- | --- |\n${tools.join("\n")}\n`;
await writeFile(
  path.join(root, "docs/mcp-tools.mdx"),
  await format(mcp, { parser: "mdx" }),
);
await mkdir(path.join(root, "docs/installation-files"), { recursive: true });
for (const file of ["compose.images.yaml", "rootset.env.example"])
  await writeFile(
    path.join(root, "docs/installation-files", file),
    await readFile(path.join(root, file)),
  );
console.log(
  `Synced ${tools.length} MCP tools, public endpoint pages and installation files.`,
);
