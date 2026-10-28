import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const stableTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function versionOf(tag) {
  const match = stableTag.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

// True when tag is at least as new as every published stable release, so
// publishing it as Latest cannot replace a newer release. Tags that are not
// stable vX.Y.Z versions are ignored.
export function isNewestRelease(tag, publishedTags) {
  const version = versionOf(tag);
  assert(version, `${tag} is not a stable release tag`);
  assert(Array.isArray(publishedTags), "Missing published release tags");
  return publishedTags.every((other) => {
    const published = versionOf(other);
    if (!published) return true;
    for (let index = 0; index < 3; index++)
      if (published[index] !== version[index])
        return published[index] < version[index];
    return true;
  });
}

// Usage: node tools/release/latest.mjs <tag> <releases.json>
// releases.json is `gh release list --exclude-drafts --exclude-pre-releases
// --json tagName` output. Prints true or false.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [tag, file] = process.argv.slice(2);
  assert(tag && file, "Supply the release tag and the releases file");
  const releases = JSON.parse(await readFile(file, "utf8"));
  assert(Array.isArray(releases), "The releases file must be a JSON array");
  console.log(
    String(
      isNewestRelease(
        tag,
        releases.map((release) => release.tagName),
      ),
    ),
  );
}
