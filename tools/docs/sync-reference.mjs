import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";

const root = path.resolve(import.meta.dirname, "../..");
const docs = path.join(root, "docs");
const specText = await readFile(
  path.join(root, "packages/contracts/generated/openapi.json"),
  "utf8",
);
const spec = JSON.parse(specText);
const tools = JSON.parse(
  await readFile(
    path.join(root, "packages/contracts/generated/mcp-tools.json"),
    "utf8",
  ),
);
const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
const apiGroups = new Map();
const mcpGroups = new Map();
const labels = {
  accounts: "Accounts and Workspace",
  databases: "Databases and Backups",
  schema: "Tables and Schema",
  data: "Records and History",
  artifacts: "Imports and Exports",
  jobs: "Background Jobs",
};
const endpointPages = new Set(["overview"]);
const toolPages = new Set();
await mkdir(path.join(docs, "api-reference"), { recursive: true });
await mkdir(path.join(docs, "mcp-reference"), { recursive: true });
await writeFile(path.join(docs, "api-reference/openapi.json"), specText);
const save = async (slug, text) =>
  writeFile(
    path.join(docs, slug + ".mdx"),
    await format(text, { parser: "mdx" }),
  );
const add = (groups, label, slug) => {
  if (!groups.has(label)) groups.set(label, []);
  groups.get(label).push(slug);
};
function typeLabel(schema) {
  if (schema.enum)
    return schema.enum.map((value) => JSON.stringify(value)).join(" or ");
  if (schema.anyOf)
    return [...new Set(schema.anyOf.map(typeLabel))].join(" or ");
  if (schema.type === "array")
    return `array of ${typeLabel(schema.items ?? {})}`;
  return schema.type ?? "JSON value";
}
const escape = (value) =>
  String(value)
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ");
const argumentDescriptions = {
  orgId: "Workspace ID returned by rootset_get_context.",
  databaseId: "ID of the database to work with.",
  tableId: "ID of the table to work with.",
  rowId: "Stable record ID, not its position in the spreadsheet.",
  fieldId: "ID of the field to work with.",
  fieldIds: "All field IDs in the desired presentation order.",
  expectedSchemaVersion: "Current version returned by the table schema.",
  expectedRevision: "Current revision returned when reading the record.",
  cursor: "Continuation cursor from the previous response.",
  limit: "Maximum number of items to return.",
  select: "Field names to include in the result.",
  values: "Field names and values matching the table schema.",
  orderBy: "Fields to sort by, with asc or desc direction.",
};

for (const [url, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
    const tag = op.tags?.[0] ?? "API";
    const label = labels[tag] ?? tag;
    const slug = "api-reference/" + op.operationId;
    add(apiGroups, label, slug);
    endpointPages.add(op.operationId);
    const words = op.operationId
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
    const title = words[0].toUpperCase() + words.slice(1);
    await save(
      slug,
      `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(op.summary)}\nopenapi: ${JSON.stringify("/api-reference/openapi.json " + method.toUpperCase() + " " + url)}\n---\n`,
    );

    const tool = toolMap.get(op["x-rootset-mcp-tool"]);
    if (!tool) continue;
    const toolSlug = "mcp-reference/" + tool.name;
    add(mcpGroups, label, toolSlug);
    toolPages.add(tool.name);
    const properties = tool.inputSchema.properties ?? {};
    const required = new Set(tool.inputSchema.required ?? []);
    const argumentsTable = Object.entries(properties)
      .map(
        ([name, schema]) =>
          `| \`${name}\` | ${required.has(name) ? "Yes" : "No"} | ${escape(typeLabel(schema))} | ${escape(schema.description ?? argumentDescriptions[name] ?? "—")} |`,
      )
      .join("\n");
    const args = structuredClone(op["x-rootset-request-example"]);
    if (properties.idempotencyKey) args.idempotencyKey = "example-request-0001";
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool.name, arguments: args },
    };
    const target = properties.tableId
      ? "Read the table schema"
      : properties.databaseId
        ? "Find the database"
        : "Check the account";
    const outcome = op["x-rootset-job"]
      ? "Check the job result"
      : "Read the result";
    const scopes = op["x-rootset-scopes"];
    const role = op["x-rootset-minimum-role"];
    const access = [
      ...(!op["x-rootset-personal"] || role !== "viewer"
        ? [
            `Requires a current workspace role of **${{ viewer: "Viewer", member: "Member", admin: "Admin" }[role]}** or higher.`,
          ]
        : []),
      ...(op["x-rootset-personal"]
        ? ["Use a personal OAuth connection for the signed-in account."]
        : []),
    ].join(" ");
    const behavior = [
      tool.annotations.readOnlyHint
        ? "This tool reads data without changing it."
        : "This tool changes data or starts work. Confirm the target and input before calling it.",
      ...(properties.idempotencyKey
        ? [
            "Keep the same `idempotencyKey` when retrying an unchanged request; use a new key for different input.",
          ]
        : []),
      ...(properties.expectedSchemaVersion
        ? [
            "Read the current table schema before supplying `expectedSchemaVersion`.",
          ]
        : []),
      ...(properties.expectedRevision
        ? ["Read the current record revision before making a change."]
        : []),
      ...(op["x-rootset-job"]
        ? [
            "A returned job is pending work. Use [rootset_get_job](/mcp-reference/rootset_get_job) to check its final result.",
          ]
        : []),
    ];
    await save(
      toolSlug,
      `---\ntitle: ${JSON.stringify(tool.name)}\nsidebarTitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(op.summary)}\nicon: "/assets/icons/mcp.svg"\n---\n\n## Workflow\n\n\`\`\`mermaid\nflowchart LR\n  discover[${JSON.stringify(target)}] --> invoke[${JSON.stringify(title)}]\n  invoke --> outcome[${JSON.stringify(outcome)}]\n\`\`\`\n\n## Access and behavior\n\n${access}${scopes.length ? " The connection needs " + scopes.map((scope) => "`" + scope + "`").join(", ") + " scope." : ""}\n\n${behavior.map((text) => "- " + text).join("\n")}\n\n## Arguments\n\n${argumentsTable ? "| Argument | Required | Type | Details |\n| --- | --- | --- | --- |\n" + argumentsTable : "This tool takes an empty arguments object."}\n\n<Accordion title="Complete input schema">\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`\n\n</Accordion>\n\n## Example call\n\nYour client initializes the MCP connection before this call. Example identifiers and values are illustrative; use the IDs, schema version and values from your installation.\n\n\`\`\`json\n${JSON.stringify(call, null, 2)}\n\`\`\`\n\n## Result\n\nRead the structured result returned by the tool. A tool failure sets \`isError\`; do not treat an error as a completed operation. The [REST operation](/api-reference/${op.operationId}) documents the corresponding result fields and errors.\n\n[Connect an MCP client](/mcp-guide) · [REST conventions](/api-reference/overview)\n`,
    );
  }
}
for (const [directory, expected] of [
  ["api-reference", endpointPages],
  ["mcp-reference", toolPages],
]) {
  for (const file of await readdir(path.join(docs, directory)))
    if (file.endsWith(".mdx") && !expected.has(file.slice(0, -4)))
      await unlink(path.join(docs, directory, file));
}
const configPath = path.join(docs, "site.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const integrations = config.navigation.dropdowns.find(
  (item) => item.dropdown === "API & MCP",
);
integrations.groups.find((group) => group.group === "API Reference").pages = [
  "api-reference/overview",
  ...[...apiGroups].map(([group, pages]) => ({ group, pages })),
];
integrations.groups.find((group) => group.group === "MCP reference").pages = [
  ...mcpGroups,
].map(([group, pages]) => ({ group, pages }));
await writeFile(
  configPath,
  await format(JSON.stringify(config), { parser: "json" }),
);
await mkdir(path.join(docs, "installation-files"), { recursive: true });
for (const file of ["compose.images.yaml", "rootset.env.example"])
  await writeFile(
    path.join(docs, "installation-files", file),
    await readFile(path.join(root, file)),
  );
const version = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).version;
const deploymentFiles = [
  ["towbar.yml", "yaml", "towbar.yml"],
  [
    "rootset-api.service.yml",
    "yaml",
    ".towbar/services/rootset-api.service.yml",
  ],
  [
    "rootset-worker.service.yml",
    "yaml",
    ".towbar/services/rootset-worker.service.yml",
  ],
  [
    "rootset-web.service.yml",
    "yaml",
    ".towbar/services/rootset-web.service.yml",
  ],
  [
    "rootset-postgres.datastore.yml",
    "yaml",
    ".towbar/datastores/rootset-postgres.datastore.yml",
  ],
  ["postgres-init.sh", "bash", ".towbar/config/postgres-init.sh"],
];
const codeTabs = [];
for (const [file, language, title] of deploymentFiles) {
  const filePath = path.join(docs, "installation-files/towbar", file);
  const text = (await readFile(filePath, "utf8")).replace(
    /ghcr\.io\/avgeek-oss\/rootset-(api|worker|web):\d+\.\d+\.\d+/g,
    `ghcr.io/avgeek-oss/rootset-$1:${version}`,
  );
  await writeFile(filePath, text);
  codeTabs.push(`\`\`\`${language} ${title}\n${text.trimEnd()}\n\`\`\``);
}
await save(
  "snippets/towbar-manifests",
  `{/* Generated from installation-files/towbar by docs:sync. */}\n\n<CodeGroup>\n\n${codeTabs.join("\n\n")}\n\n</CodeGroup>\n`,
);
console.log(
  `Synced ${toolPages.size} MCP tool pages, ${endpointPages.size - 1} endpoint pages and installation files.`,
);
