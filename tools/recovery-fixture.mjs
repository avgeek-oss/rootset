import { createHash, randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { newId } from "../packages/contracts/src/index.ts";
import { createPool } from "../packages/database/src/index.ts";
import { TableStorage } from "../packages/table-storage/src/index.ts";
import { ArtifactStore } from "../packages/jobs/src/artifacts.ts";
import { encryptProtected } from "../packages/email/src/index.ts";
import { loadConfig } from "../packages/core/src/config.ts";

const url = new URL(process.env.ROOTSET_TEST_DATABASE_URL ?? "");
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.port !== (process.env.ROOTSET_RECOVERY_SOURCE_PORT ?? "55468")
)
  throw new Error(
    "The recovery fixture is restricted to the authorized Rootset test database",
  );
const config = loadConfig();
const owner = createPool(url.toString(), 1),
  app = createPool(config.databaseURL, 2),
  ddl = createPool(config.databaseURL, 2);
const storage = new TableStorage({
  pool: app,
  ddlPool: ddl,
  cursorSecret: config.cursorSecret,
});
const store = new ArtifactStore(app, {
  ...config.artifacts,
  encryptionKey: config.encryptionKey,
});
let orgId = newId();
const userId = newId(),
  actionId = newId();
const marker = randomBytes(32).toString("hex");
try {
  const migrations = (
    await owner.query(
      "SELECT name FROM rootset_control.migrations ORDER BY name",
    )
  ).rows;
  if (migrations.length !== 1 || migrations[0].name !== "0001_baseline.sql")
    throw new Error(
      "Recovery fixture requires a fresh 0001_baseline.sql installation",
    );
  await owner.query(
    "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
    [
      userId,
      "Recovery fixture Admin",
      `recovery-${userId.toLowerCase()}@example.test`,
    ],
  );
  const organisations = (
    await owner.query("SELECT id FROM rootset_control.organisations")
  ).rows;
  if (organisations.length > 1)
    throw new Error(
      "Recovery fixture requires the current single-organisation baseline",
    );
  if (organisations.length === 1) orgId = organisations[0].id;
  else
    await owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
      [orgId, `Rootset disaster recovery ${orgId}`],
    );
  await owner.query(
    "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')",
    [newId(), orgId, userId],
  );
  const actor = {
    kind: "session",
    id: userId,
    userId,
    orgId,
    role: "admin",
    scopes: [],
    membershipVersion: 1,
  };
  const database = await storage.createDatabase(actor, {
    name: "Recovery proof",
  });
  const table = await storage.createTable(actor, database.id, {
    name: "Persisted proof",
    fields: [{ name: "proof", type: "json" }],
  });
  const row = await storage.createRow(
    actor,
    table.id,
    {
      proof: {
        version: 1,
        markerSha256: createHash("sha256").update(marker).digest("hex"),
      },
    },
    { idempotencyKey: "recovery-proof-row" },
  );
  const payload = { name: "Rootset recovery proof", marker };
  await owner.query(
    "INSERT INTO rootset_control.account_actions(id,user_id,org_id,actor_id,operation,payload_encrypted,digest,expires_at) VALUES($1,$2,$3,$4,'updateProfile',$5,$6,now()+interval '7 days')",
    [
      actionId,
      userId,
      orgId,
      userId,
      encryptProtected(payload, config),
      createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    ],
  );
  const bytes = Buffer.from(
    JSON.stringify({ rootsetRecoveryProof: 1, marker }) + "\n",
  );
  const artifact = await store.write(
    actor,
    null,
    { type: "table", id: table.id },
    "installation-recovery-proof",
    "jsonl",
    "application/x-ndjson",
    (async function* () {
      yield bytes;
    })(),
    { syntheticRecoveryFixture: true },
    { lifetimeSeconds: 7 * 86400 },
  );
  const report = {
    orgId,
    userId,
    databaseId: database.id,
    tableId: table.id,
    rowId: row.id,
    actionId,
    artifactId: artifact.id,
    markerSha256: createHash("sha256").update(marker).digest("hex"),
    plaintextSha256: createHash("sha256").update(bytes).digest("hex"),
    plaintextBytes: bytes.length,
    source:
      "Dedicated synthetic recovery fixture; original scale rows unchanged",
  };
  const destination = resolve(
    `verification/v1-recovery/fixture-${newId()}/nonempty-recovery-fixture.json`,
  );
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(
    destination,
    JSON.stringify({ ...report, acceptance: false }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      event: "nonempty_recovery_fixture_created",
      report: destination,
      orgId,
      artifactId: artifact.id,
      plaintextBytes: bytes.length,
    }),
  );
} finally {
  store.client.destroy();
  await Promise.all([owner.end(), app.end(), ddl.end()]);
}
