import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { validateNavigation } from "@avgeek-oss/docs";
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
for (const file of ["compose.images.yaml", "rootset.env.example"])
  assert.equal(
    await readFile(path.join(docs, "installation-files", file), "utf8"),
    await readFile(path.join(root, file), "utf8"),
    `Installation file drift: ${file}`,
  );
const compose = YAML.parse(
  await readFile(path.join(root, "compose.images.yaml"), "utf8"),
);
for (const [name, service] of Object.entries(compose.services)) {
  assert(!service.build, `${name} must pull a published image`);
  if (name !== "postgres")
    assert.match(
      service.image,
      /^ghcr\.io\/avgeek-oss\/rootset-(api|web):\$\{ROOTSET_VERSION:/,
    );
}
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
  if (slug.startsWith("api-reference/")) {
    assert(
      expected.delete(slug.slice("api-reference/".length)),
      `Unexpected endpoint ${slug}`,
    );
    assert.match(text, /openapi:/);
  }
}
assert.equal(expected.size, 0, "Missing endpoint reference pages");
for (const group of site.footer.links)
  for (const item of group.items) await linkExists(item.href, "footer");
await linkExists(site.navbar.primary.href, "navbar");
let screenshots = 0;
for (const file of await readdir(path.join(docs, "assets/screenshots"))) {
  if (!file.endsWith(".png")) continue;
  const buffer = await readFile(path.join(docs, "assets/screenshots", file));
  assert.equal(buffer.subarray(1, 4).toString(), "PNG", file);
  assert.equal(buffer.readUInt32BE(16), 3840, file);
  assert.equal(buffer.readUInt32BE(20), 2160, file);
  screenshots++;
}
assert(screenshots >= 20, "Missing 2x light/dark captures");
console.log(
  `Checked ${pages.length} pages, all public endpoints, links, image dimensions and image-based Compose.`,
);
