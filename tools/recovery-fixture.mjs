import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { newId } from "../packages/contracts/src/index.ts";
import { createPool } from "../packages/database/src/index.ts";
import { TableStorage } from "../packages/table-storage/src/index.ts";
import { ArtifactStore } from "../packages/jobs/src/artifacts.ts";
import { encryptProtected } from "../packages/email/src/index.ts";
import { loadConfig } from "../packages/core/src/config.ts";

const url = new URL(process.env.ROOTSET_TEST_DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "55448")
  throw new Error(
    "The recovery fixture is restricted to the authorized Rootset test database",
  );
const config = loadConfig();
const owner = createPool(url.toString(), 1),
  app = createPool(config.databaseURL, 2),
  ddl = createPool(config.ddlDatabaseURL, 2);
const storage = new TableStorage({
  pool: app,
  ddlPool: ddl,
  cursorSecret: config.cursorSecret,
});
const store = new ArtifactStore(app, {
  ...config.artifacts,
  encryptionKeys: config.encryptionKeys,
  activeKeyId: config.activeEncryptionKeyId,
});
const orgId = newId(),
  userId = newId(),
  actionId = newId();
const marker = randomBytes(32).toString("hex");
try {
  await owner.query(
    "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
    [
      userId,
      "Recovery fixture owner",
      `recovery-${userId.toLowerCase()}@example.test`,
    ],
  );
  await owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
    [orgId, `Rootset disaster recovery ${orgId}`],
  );
  await owner.query(
    "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'owner')",
    [newId(), orgId, userId],
  );
  const actor = {
    kind: "operator",
    id: userId,
    userId,
    orgId,
    role: "owner",
    scopes: ["*"],
    targets: [],
    unrestricted: true,
    operator: true,
  };
  const database = await storage.createDatabase(actor, {
    name: "Recovery proof",
  });
  const table = await storage.createTable(actor, database.id, {
    name: "Persisted proof",
    fields: [{ apiKey: "proof", label: "Proof", type: "json" }],
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
    keyId: artifact.encryption_key_id,
    markerSha256: createHash("sha256").update(marker).digest("hex"),
    plaintextSha256: createHash("sha256").update(bytes).digest("hex"),
    plaintextBytes: bytes.length,
    source:
      "Dedicated synthetic recovery fixture; original scale rows unchanged",
  };
  await writeFile(
    "verification/delivery/nonempty-recovery-fixture.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      event: "nonempty_recovery_fixture_created",
      orgId,
      artifactId: artifact.id,
      plaintextBytes: bytes.length,
      keyId: artifact.encryption_key_id,
    }),
  );
} finally {
  store.client.destroy();
  await Promise.all([owner.end(), app.end(), ddl.end()]);
}
