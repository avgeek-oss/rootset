import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");
await mkdir(destination, { recursive: true });
const entryPoints = {
  api: "apps/rootset-api/src/index.ts",
  worker: "apps/rootset-worker/src/main.ts",
  migrate: "tools/migrate.ts",
  operator: "tools/operator.ts",
};
const options = {
  bundle: true,
  platform: "node" as const,
  target: "node24",
  format: "esm" as const,
  sourcemap: "external" as const,
  sourcesContent: false,
  external: ["pg-native"],
  banner: {
    js: 'import { createRequire as __rootsetCreateRequire } from "node:module"; const require = __rootsetCreateRequire(import.meta.url);',
  },
};
const result = await build({
  ...options,
  absWorkingDir: root,
  entryPoints,
  outdir: destination,
  outExtension: { ".js": ".mjs" },
  metafile: true,
});
await build({
  ...options,
  stdin: {
    contents: `import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
const id=(await readFile(process.env.ROOTSET_WORKER_ID_FILE ?? '/tmp/rootset-worker-id','utf8')).trim();
if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error('Worker heartbeat identity is unavailable');
const pool=new Pool({connectionString:process.env.ROOTSET_DATABASE_URL,max:1,connectionTimeoutMillis:3000,options:'-c statement_timeout=3000'});
try { const result=await pool.query("SELECT 1 FROM rootset_control.worker_heartbeats WHERE id=$1 AND state='ready' AND heartbeat_at>now()-interval '30 seconds'",[id]); if(result.rowCount!==1) process.exitCode=1; } finally { await pool.end(); }`,
    resolveDir: root,
    sourcefile: "worker-health.ts",
  },
  outfile: resolve(destination, "worker-health.mjs"),
});
await build({
  ...options,
  stdin: {
    contents: `import { S3Client,HeadBucketCommand,CreateBucketCommand } from '@aws-sdk/client-s3';
const region=process.env.ROOTSET_S3_REGION ?? 'us-east-1';
const client=new S3Client({endpoint:process.env.ROOTSET_S3_ENDPOINT,region,forcePathStyle:true,credentials:{accessKeyId:process.env.ROOTSET_S3_ACCESS_KEY,secretAccessKey:process.env.ROOTSET_S3_SECRET_KEY}});
try { await client.send(new HeadBucketCommand({Bucket:process.env.ROOTSET_S3_BUCKET})); console.log('Artifact bucket exists'); }
catch(error) { if(!['NotFound','NoSuchBucket'].includes(error.name)&&error.$metadata?.httpStatusCode!==404)throw new Error('Object storage prerequisite failed'); await client.send(new CreateBucketCommand({Bucket:process.env.ROOTSET_S3_BUCKET,...(region==='us-east-1'?{}:{CreateBucketConfiguration:{LocationConstraint:region}})})); console.log('Created artifact bucket'); }
finally { client.destroy(); }`,
    resolveDir: resolve(root, "packages/core"),
    sourcefile: "objects-init.ts",
  },
  outfile: resolve(destination, "objects-init.mjs"),
});
const files = [...Object.keys(entryPoints), "worker-health", "objects-init"];
const digests = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name + ".mjs",
      createHash("sha256")
        .update(await readFile(resolve(destination, name + ".mjs")))
        .digest("hex"),
    ]),
  ),
);
const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(resolve(root, path)))
    .digest("hex");
const sourceInputs = [
  ...Object.keys(result.metafile.inputs).filter(
    (path) => !path.includes("node_modules/"),
  ),
  "tools/build-apps.ts",
].sort();
const migrations = (
  await readdir(resolve(root, "packages/database/migrations"))
)
  .filter((name) => name.endsWith(".sql"))
  .sort();
type DependencyLicense = {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage?: string;
};
const licenses = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: root,
    maxBuffer: 8 * 1024 ** 2,
  }).toString(),
) as Record<string, DependencyLicense[]>;
const noticeDirectory = resolve(destination, "notices");
await mkdir(noticeDirectory, { recursive: true });
const noticeInventory = [];
for (const dependencies of Object.values(licenses)) {
  for (const dependency of dependencies) {
    const folder = dependency.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    await mkdir(resolve(noticeDirectory, folder), { recursive: true });
    const files: string[] = [];
    for (const [versionIndex, packagePath] of dependency.paths.entries()) {
      for (const name of (await readdir(packagePath)).filter((name) =>
        /^(licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(name),
      )) {
        const output = `${versionIndex}-${name}`;
        await writeFile(
          resolve(noticeDirectory, folder, output),
          await readFile(resolve(packagePath, name)),
        );
        files.push(folder + "/" + output);
      }
    }
    noticeInventory.push({
      name: dependency.name,
      versions: dependency.versions,
      license: dependency.license,
      homepage: dependency.homepage,
      noticeFiles: files,
    });
  }
}
await writeFile(
  resolve(noticeDirectory, "dependency-inventory.json"),
  JSON.stringify(noticeInventory, null, 2) + "\n",
);
for (const [name, path] of [
  ["Rootset-LICENSE", "LICENSE"],
  ["Towbar-LICENSE", "packages/email/LICENSE-Towbar"],
  ["email-reference-notices.md", "packages/email/THIRD_PARTY_NOTICES.md"],
  ["web-ui-reference-notices.md", "apps/rootset-web/THIRD_PARTY_NOTICES.md"],
]) {
  await writeFile(
    resolve(noticeDirectory, name!),
    await readFile(resolve(root, path!)),
  );
}
await writeFile(
  resolve(destination, "build-manifest.json"),
  JSON.stringify(
    {
      node: process.version,
      files: digests,
      lockfileSha256: await sha256("pnpm-lock.yaml"),
      sourceDigests: Object.fromEntries(
        await Promise.all(
          sourceInputs.map(async (path) => [path, await sha256(path)]),
        ),
      ),
      migrationDigests: Object.fromEntries(
        await Promise.all(
          migrations.map(async (name) => [
            name,
            await sha256("packages/database/migrations/" + name),
          ]),
        ),
      ),
      upgradeDigests: {
        "v0.1.4.sql": await sha256("packages/database/upgrades/v0.1.4.sql"),
      },
      bundledInputs: Object.keys(result.metafile.inputs).sort(),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Built ${files.length} production entry points; recorded artifact SHA-256 digests.`,
);
