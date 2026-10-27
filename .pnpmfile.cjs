// TypeScript 7 has no programmatic compiler API. typescript-eslint and the
// packages behind its type-aware rules declare typescript as a peer, which
// would resolve to the workspace's TypeScript 7. Neither overrides nor
// packageExtensions can replace a peer, so this hook turns that peer into a
// dependency on @typescript/typescript6: the TypeScript 6 API, published by
// the TypeScript team for tools that still need it. tsc stays TypeScript 7.
const TYPESCRIPT_6 = "npm:@typescript/typescript6@6.0.2";

function needsTypeScriptApi(name) {
  return (
    name === "typescript-eslint" ||
    name === "ts-api-utils" ||
    name.startsWith("@typescript-eslint/")
  );
}

function readPackage(pkg) {
  if (needsTypeScriptApi(pkg.name) && pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: TYPESCRIPT_6 };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
