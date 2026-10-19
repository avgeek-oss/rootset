import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { validateNavigation } from "@avgeek-oss/mintlify-docs";
import { requirePinnedInstallation } from "../release/check.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const docs = path.join(root, "docs");
const site = JSON.parse(await readFile(path.join(docs, "site.json"), "utf8"));
const pages = ["index", ...validateNavigation(site.navigation)];
const specText = await readFile(
  path.join(root, "packages/contracts/generated/openapi.json"),
  "utf8",
);
assert.equal(
  await readFile(path.join(docs, "api-reference/openapi.json"), "utf8"),
  specText,
  "Public OpenAPI schema drifted",
);
const spec = JSON.parse(specText);
const expected = new Set(
  Object.values(spec.paths).flatMap((methods) =>
    Object.values(methods)
      .filter((op) => op.operationId)
      .map((op) => op.operationId),
  ),
);
const tools = JSON.parse(
  await readFile(
    path.join(root, "packages/contracts/generated/mcp-tools.json"),
    "utf8",
  ),
);
const expectedTools = new Map(tools.map((tool) => [tool.name, tool]));
for (const file of ["compose.images.yaml", "rootset.env.example"])
  assert.equal(
    await readFile(path.join(docs, "installation-files", file), "utf8"),
    await readFile(path.join(root, file), "utf8"),
    `Installation file drift: ${file}`,
  );
const compose = YAML.parse(
  await readFile(path.join(root, "compose.images.yaml"), "utf8"),
);
requirePinnedInstallation(
  compose,
  await readFile(path.join(root, "rootset.env.example"), "utf8"),
  JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
);
assert.equal(
  compose.services.web.environment.ROOTSET_PUBLIC_API_ORIGIN,
  "${ROOTSET_API_URL:?Public API origin required}",
);
assert.equal(
  compose.services.api.depends_on.migrate.condition,
  "service_completed_successfully",
);
assert.equal(
  compose.services.worker.depends_on.migrate.condition,
  "service_completed_successfully",
);
const linkExists = async (url, from) => {
  if (!url.startsWith("/")) return;
  const target = url.split("#")[0].split("?")[0];
  const candidates = [target === "/" ? "/index.mdx" : target, target + ".mdx"];
  assert(
    (
      await Promise.all(
        candidates.map(async (candidate) =>
          stat(path.join(docs, candidate)).then(
            () => true,
            () => false,
          ),
        ),
      )
    ).some(Boolean),
    `${from}: missing ${url}`,
  );
};
for (const slug of pages) {
  const text = await readFile(path.join(docs, slug + ".mdx"), "utf8");
  assert.match(text, /^---\ntitle:/, `${slug}: missing title`);
  assert.match(text, /\ndescription:/, `${slug}: missing description`);
  for (const match of text.matchAll(
    /(?:href|light|dark)="([^"{}]+)"|\]\((\/[^ )]+)\)/g,
  ))
    await linkExists(match[1] ?? match[2], slug);
  const icon = text.match(/\nicon: "([^"]+)"/);
  if (icon) await linkExists(icon[1], slug);
  if (slug.startsWith("api-reference/") && slug !== "api-reference/overview") {
    assert(
      expected.delete(slug.slice("api-reference/".length)),
      `Unexpected endpoint ${slug}`,
    );
    assert.match(text, /openapi:/);
  }
  if (slug.startsWith("mcp-reference/")) {
    const name = slug.slice("mcp-reference/".length);
    const tool = expectedTools.get(name);
    assert(tool, `Unexpected MCP tool ${slug}`);
    expectedTools.delete(name);
    assert.match(text, /icon: "\/assets\/icons\/mcp.svg"/);
    const schema = text.match(
      /<Accordion title="Complete input schema">\s+```json\n([\s\S]*?)\n```/,
    );
    assert(schema, `${slug}: missing input schema`);
    assert.deepEqual(
      JSON.parse(schema[1]),
      tool.inputSchema,
      `${slug}: input schema drift`,
    );
    const example = text.match(
      /## Example call[\s\S]*?```json\n([\s\S]*?)\n```/,
    );
    assert(example, `${slug}: missing example call`);
    const call = JSON.parse(example[1]);
    assert.equal(call.method, "tools/call");
    assert.equal(call.params.name, name);
    const { idempotencyKey, ...input } = call.params.arguments;
    const op = Object.values(spec.paths)
      .flatMap(Object.values)
      .find((op) => op["x-rootset-mcp-tool"] === name);
    assert.deepEqual(
      input,
      op["x-rootset-request-example"],
      `${slug}: example drift`,
    );
    if (tool.inputSchema.properties?.idempotencyKey)
      assert.equal(idempotencyKey, "example-request-0001");
  }
}
assert.equal(expected.size, 0, "Missing endpoint reference pages");
assert.equal(expectedTools.size, 0, "Missing MCP reference pages");
for (const redirect of site.redirects) {
  assert.notEqual(redirect.source, redirect.destination, "Redirect loop");
  await linkExists(redirect.destination, "redirect");
}
for (const css of ["rootset.css", "oss-docs.css"]) {
  const text = await readFile(path.join(docs, css), "utf8");
  for (const match of text.matchAll(/url\("(\/[^" )]+)"\)/g))
    await linkExists(match[1], css);
}
const navigated = new Set(pages);
async function checkPageCoverage(directory, prefix = "") {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const slug = prefix + item.name;
    if (item.isDirectory()) {
      if (!["snippets", "assets", "installation-files"].includes(item.name))
        await checkPageCoverage(path.join(directory, item.name), slug + "/");
    } else if (item.name.endsWith(".mdx")) {
      assert(
        navigated.has(slug.slice(0, -4)),
        `Unlisted documentation page: ${slug}`,
      );
    }
  }
}
await checkPageCoverage(docs);
const deploymentFiles = [
  ["towbar.yml", "towbar.yml"],
  ["rootset-api.service.yml", ".towbar/services/rootset-api.service.yml"],
  ["rootset-worker.service.yml", ".towbar/services/rootset-worker.service.yml"],
  ["rootset-web.service.yml", ".towbar/services/rootset-web.service.yml"],
  [
    "rootset-postgres.datastore.yml",
    ".towbar/datastores/rootset-postgres.datastore.yml",
  ],
  ["postgres-init.sh", ".towbar/config/postgres-init.sh"],
];
const manifestSnippet = await readFile(
  path.join(docs, "snippets/towbar-manifests.mdx"),
  "utf8",
);
const codeTabs = new Map(
  [
    ...manifestSnippet.matchAll(/```(?:yaml|bash) ([^\n]+)\n([\s\S]*?)\n```/g),
  ].map((match) => [match[1], match[2]]),
);
const releaseVersion = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).version;
for (const [file, title] of deploymentFiles) {
  const text = await readFile(
    path.join(docs, "installation-files/towbar", file),
    "utf8",
  );
  assert(codeTabs.has(title), `Missing Towbar code tab: ${title}`);
  if (file.endsWith(".yml")) {
    const example = YAML.parse(text);
    assert.deepEqual(
      YAML.parse(codeTabs.get(title)),
      example,
      `Towbar code tab drift: ${title}`,
    );
    if (example.deployment) {
      assert.equal(
        example.deployment.image,
        `ghcr.io/avgeek-oss/${example.id}:${releaseVersion}`,
      );
      assert.equal(example.autoDeploy, false);
      assert.equal(example.environments.production.server, "192.0.2.10");
    }
  } else {
    assert.equal(
      codeTabs.get(title).trim(),
      text.trim(),
      `Towbar script drift: ${title}`,
    );
  }
}
for (const group of site.footer.links)
  for (const item of group.items) await linkExists(item.href, "footer");
await linkExists(site.navbar.primary.href, "navbar");
let screenshots = 0;
const capture = JSON.parse(
  await readFile(path.join(docs, "assets/screenshots/capture.json"), "utf8"),
);
assert.deepEqual(capture.viewport, { width: 1280, height: 800 });
assert.equal(capture.deviceScaleFactor, 2);
assert.equal(capture.zoom, 1);
for (const file of await readdir(path.join(docs, "assets/screenshots"))) {
  if (!file.endsWith(".png")) continue;
  const buffer = await readFile(path.join(docs, "assets/screenshots", file));
  assert.equal(buffer.subarray(1, 4).toString(), "PNG", file);
  assert.equal(buffer.readUInt32BE(16), 2560, file);
  assert.equal(buffer.readUInt32BE(20), 1600, file);
  screenshots++;
}
assert.equal(screenshots, 28, "Missing 2x light/dark captures");
console.log(
  `Checked ${pages.length} pages, all public endpoints, links, image dimensions and image-based Compose.`,
);
