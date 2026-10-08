import { execFileSync, spawn } from "node:child_process";
import { createHash, createDecipheriv } from "node:crypto";
import { mkdir, writeFile, statfs } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceName = process.env.ROOTSET_RECOVERY_SOURCE_NAME;
if (!sourceName || !/^rootset-[a-z0-9-]+$/.test(sourceName))
  throw new Error(
    "Set the explicit fresh-baseline Rootset recovery source container name",
  );
const sourcePort = process.env.ROOTSET_RECOVERY_SOURCE_PORT ?? "55468";
const restoredName =
  process.env.ROOTSET_RECOVERY_TARGET_NAME ??
  "rootset-delivery-physical-recovery";
const restoredPort = Number(process.env.ROOTSET_RECOVERY_TARGET_PORT ?? 55469);
if (
  !/^rootset-delivery-physical-recovery(?:-[a-z0-9-]+)?$/.test(restoredName) ||
  !Number.isInteger(restoredPort) ||
  restoredPort < 55000 ||
  restoredPort > 55999 ||
  restoredPort === Number(sourcePort)
)
  throw new Error(
    "Choose a distinct Rootset recovery container and loopback test port",
  );
const image =
  "postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2";
const source = JSON.parse(
  execFileSync("docker", ["inspect", sourceName], { encoding: "utf8" }),
)[0];
if (
  source.Config.Labels?.["com.rootset.fixture"] !== "v1" ||
  !source.State.Running
)
  throw new Error(
    "The authorized Rootset v1 PostgreSQL fixture is unavailable",
  );
process.loadEnvFile(join(root, ".env.test"));
const sourceURL = new URL(process.env.ROOTSET_TEST_DATABASE_URL ?? "");
if (
  !["localhost", "127.0.0.1"].includes(sourceURL.hostname) ||
  sourceURL.port !== sourcePort
)
  throw new Error(
    "Recovery rehearsal is restricted to the authorized loopback fixture",
  );
const directory = resolve(
  root,
  "verification/v1-recovery/physical-recovery-" +
    new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const clusterDirectory = join(directory, "cluster");
await mkdir(clusterDirectory, { mode: 0o700 });
const space = await statfs(directory);
if (Number(space.bavail) * Number(space.bsize) < 40 * 1024 ** 3)
  throw new Error("Recovery rehearsal needs at least 40 GiB free host storage");
const connectionFile = join(directory, "connection.env");
await writeFile(
  connectionFile,
  `PGPASSWORD=${decodeURIComponent(sourceURL.password)}\n`,
  { mode: 0o600 },
);
const retained = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    ["ROOTSET_SECRET", "ROOTSET_ENCRYPTION_KEY"].includes(name),
  ),
);
await writeFile(
  join(directory, "protected-keys.json"),
  JSON.stringify(retained) + "\n",
  { mode: 0o600 },
);
const record = {
  startedAt: new Date().toISOString(),
  baseline: "0001_baseline.sql",
  acceptance: false,
  directory,
  sourceContainerId: source.Id,
  sourceImage: source.Image,
  restoredContainer: restoredName,
  restoredPort,
  postgresImage: image,
  status: "prepared",
  limitations: [
    "This recovery result does not complete the current V1 checklist",
    "Logical artifact recovery requires the matching object-copy rehearsal",
  ],
};
const report = () =>
  writeFile(
    join(directory, "report.json"),
    JSON.stringify(record, null, 2) + "\n",
    { mode: 0o600 },
  );
await report();
console.log(
  JSON.stringify({
    event: "recovery_prepared",
    directory,
    keyIds: record.keyIds,
  }),
);
if (!process.argv.includes("--run")) process.exit(0);

async function command(args) {
  const child = spawn("docker", args, { stdio: "inherit" });
  await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? done() : reject(new Error("Recovery command failed")),
    );
  });
}
const sourcePool = new Pool({
  connectionString: sourceURL.toString(),
  max: 1,
  connectionTimeoutMillis: 5000,
});
async function inventory(pool) {
  const migrations = (
    await pool.query(
      "SELECT name FROM rootset_control.migrations ORDER BY name",
    )
  ).rows;
  if (migrations.length !== 1 || migrations[0].name !== "0001_baseline.sql")
    throw new Error(
      "Recovery requires a fresh installation using only 0001_baseline.sql",
    );
  const metadata = (
    await pool.query(
      "SELECT d.id AS database_id,d.schema_name,t.id AS table_id,t.physical_name,t.row_count,t.schema_version,t.state FROM rootset_control.databases d JOIN rootset_control.tables t ON t.database_id=d.id ORDER BY d.id,t.id",
    )
  ).rows;
  const native = [];
  for (const table of metadata) {
    if (
      !/^rsd_[a-z0-9]{26}$/.test(table.schema_name) ||
      !/^rst_[a-z0-9]{26}(_g[0-9]+)?$/.test(table.physical_name)
    )
      throw new Error("Unexpected managed physical identifier");
    const path = `"${table.schema_name}"."${table.physical_name}"`;
    const exists = (
      await pool.query("SELECT to_regclass($1) AS relation", [path])
    ).rows[0].relation;
    native.push({
      ...table,
      physicalRows: exists
        ? (await pool.query(`SELECT count(*)::text AS count FROM ${path}`))
            .rows[0].count
        : null,
    });
  }
  const control = [];
  const names = (
    await pool.query(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rootset_control' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname",
    )
  ).rows;
  for (const { relname } of names) {
    if (!/^[a-z_]+$/.test(relname))
      throw new Error("Unexpected control identifier");
    control.push({
      name: relname,
      rows: (
        await pool.query(
          `SELECT count(*)::text AS count FROM rootset_control."${relname}"`,
        )
      ).rows[0].count,
    });
  }
  const roles = (
    await pool.query(
      "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname LIKE 'rootset%' ORDER BY rolname",
    )
  ).rows;
  const enforcement = (
    await pool.query(
      "SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rootset_control' OR n.nspname LIKE 'rsd_%' ORDER BY n.nspname,c.relname",
    )
  ).rows;
  return { native, control, roles, enforcement };
}
let restoredPool;
try {
  const existing = JSON.parse(
    execFileSync(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        "name=^/" + restoredName + "$",
        "--format",
        "{{json .}}",
      ],
      { encoding: "utf8" },
    ).trim() || "null",
  );
  if (existing)
    throw new Error(
      "Recovery container already exists; preserve it and choose a reviewed new rehearsal",
    );
  await command([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--mount",
    `type=bind,source=${clusterDirectory},target=/recovery/cluster`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "chown postgres:postgres /recovery/cluster && chmod 0700 /recovery/cluster",
  ]);
  record.before = await inventory(sourcePool);
  record.status = "copying";
  await report();
  await command([
    "run",
    "--rm",
    "--user",
    "postgres",
    "--network",
    "container:" + sourceName,
    "--env-file",
    connectionFile,
    "--mount",
    `type=bind,source=${clusterDirectory},target=/recovery/cluster`,
    image,
    "pg_basebackup",
    "--host",
    "127.0.0.1",
    "--port",
    "5432",
    "--username",
    decodeURIComponent(sourceURL.username),
    "--pgdata",
    "/recovery/cluster",
    "--wal-method",
    "stream",
    "--checkpoint",
    "fast",
    "--manifest-checksums",
    "SHA256",
    "--progress",
    "--verbose",
    "--no-password",
  ]);
  await command([
    "run",
    "--rm",
    "--user",
    "postgres",
    "--mount",
    `type=bind,source=${clusterDirectory},target=/recovery/cluster,readonly`,
    image,
    "pg_verifybackup",
    "/recovery/cluster",
  ]);
  const backupManifest = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "postgres",
      "--mount",
      `type=bind,source=${clusterDirectory},target=/recovery/cluster,readonly`,
      "--entrypoint",
      "cat",
      image,
      "/recovery/cluster/backup_manifest",
    ],
    { maxBuffer: 16 * 1024 ** 2 },
  );
  record.manifestSha256 = createHash("sha256")
    .update(backupManifest)
    .digest("hex");
  record.walRanges = JSON.parse(backupManifest.toString("utf8"))["WAL-Ranges"];
  record.restoreResources = {
    cpus: 4,
    memoryBytes: 4 * 1024 ** 3,
    memorySwapBytes: 4 * 1024 ** 3,
    sharedBuffers: "256MB",
    storage: "host bind directory",
  };
  await command([
    "run",
    "-d",
    "--name",
    restoredName,
    "--label",
    "com.rootset.fixture=physical-recovery",
    "--user",
    "postgres",
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--cpus",
    "4",
    "--shm-size",
    "1g",
    "--env",
    "PGDATA=/recovery/cluster",
    "--mount",
    `type=bind,source=${clusterDirectory},target=/recovery/cluster`,
    "--publish",
    `127.0.0.1:${restoredPort}:5432`,
    image,
    "postgres",
    "-c",
    "shared_buffers=256MB",
    "-c",
    "max_connections=50",
  ]);
  const restoredURL = new URL(sourceURL);
  restoredURL.port = String(restoredPort);
  restoredPool = new Pool({
    connectionString: restoredURL.toString(),
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await restoredPool.query("SELECT 1");
      ready = true;
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  if (!ready) throw new Error("Restored PostgreSQL did not become ready");
  record.restored = await inventory(restoredPool);
  record.after = await inventory(sourcePool);
  record.rolesMatch =
    JSON.stringify(record.before.roles) ===
    JSON.stringify(record.restored.roles);
  record.enforcementMatch = record.before.enforcement.every((before) => {
    const key = (row) => row.nspname + "." + row.relname;
    const after = record.after.enforcement.find(
      (row) => key(row) === key(before),
    );
    const target = record.restored.enforcement.find(
      (row) => key(row) === key(before),
    );
    return (
      !after ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(before) === JSON.stringify(target)
    );
  });
  record.stableNativeMatch = record.before.native.every((before) => {
    const after = record.after.native.find(
      (row) => row.table_id === before.table_id,
    );
    const target = record.restored.native.find(
      (row) => row.table_id === before.table_id,
    );
    return (
      !after ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(before) === JSON.stringify(target)
    );
  });
  const encryptionKey = process.env.ROOTSET_ENCRYPTION_KEY;
  const protectedRows = (
    await restoredPool.query(
      "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE payload_encrypted<>'' UNION ALL SELECT payload_encrypted FROM rootset_control.account_actions WHERE payload_encrypted<>''",
    )
  ).rows;
  let readable = 0,
    unavailable = 0;
  for (const row of protectedRows) {
    try {
      const [id, iv, tag, ciphertext] = row.payload_encrypted.split(":");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(encryptionKey ?? "", "hex"),
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from("rootset:v1:" + id));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8"),
      );
      readable++;
    } catch {
      unavailable++;
    }
  }
  record.protectedOutbox = { readable, unavailable };
  record.completedAt = new Date().toISOString();
  record.status =
    record.rolesMatch && record.enforcementMatch && record.stableNativeMatch
      ? "physical_restore_verified"
      : "comparison_failed";
  await report();
  console.log(
    JSON.stringify({
      event: record.status,
      directory,
      nativeTables: record.restored.native.length,
      protectedOutbox: record.protectedOutbox,
    }),
  );
  if (record.status !== "physical_restore_verified") process.exitCode = 1;
} catch (error) {
  record.status = "failed";
  record.error = error.message;
  await report();
  console.error(
    "Physical recovery rehearsal failed; protected report retains the exact stage.",
  );
  process.exitCode = 1;
} finally {
  await Promise.all([sourcePool.end(), restoredPool?.end()]);
}
