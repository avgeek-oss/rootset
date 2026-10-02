import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { newId, getOperation, type Actor } from "@rootset/contracts";
import { transaction, migrationStatus, migrate } from "@rootset/database";
import { EmailOutbox, decryptProtected } from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { loadConfig } from "./config.js";
import {
  InstallationService,
  resolveInstallationConfig,
} from "./installation.js";

test("installation configuration encrypts secrets, preserves key rotation, applies live ceilings and rolls back with approval transactions", async () => {
  const db = await isolatedDatabase();
  try {
    const config = loadConfig(),
      outbox = new EmailOutbox(db.identity, {
        ...config,
        smtp: {
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          from: config.smtp.from,
        },
      });
    const installation = new InstallationService(
      db.identity,
      config,
      "0",
      outbox,
    );
    const actor: Actor = {
      id: newId(),
      kind: "operator",
      userId: newId(),
      orgId: newId(),
      role: "owner",
      scopes: ["installation:read", "installation:manage"],
      targets: [],
      operator: true,
      unrestricted: true,
    };
    const parsed = (value: unknown) =>
      getOperation("getInstallationConfiguration").outputSchema.parse(
        value,
      ) as { restartRequired: boolean; limits: Record<string, number> };
    assert.equal(
      parsed(await installation.configuration()).restartRequired,
      false,
    );
    const immediate = parsed(
      await installation.execute(
        "updateInstallationConfiguration",
        actor,
        { limits: { principalRequestsPerMinute: 31 } },
        { idempotencyKey: `installation-config:${newId()}` },
      ),
    );
    assert.equal(immediate.restartRequired, false);
    assert.equal(
      (await installation.admissionLimits()).principalRequestsPerMinute,
      31,
    );
    await assert.rejects(
      installation.execute(
        "updateInstallationConfiguration",
        actor,
        { limits: { arbitrarySetting: 9 } },
        { idempotencyKey: `installation-config:${newId()}` },
      ),
    );
    await assert.rejects(
      installation.execute(
        "updateInstallationConfiguration",
        actor,
        { limits: { concurrentMutations: 51 } },
        { idempotencyKey: `installation-config:${newId()}` },
      ),
    );
    const smtpSecret = randomBytes(32).toString("base64url");
    const response = await installation.execute(
      "updateInstallationConfiguration",
      actor,
      {
        smtp: {
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          from: config.smtp.from,
          user: "fixture-user",
          password: smtpSecret,
        },
      },
      { idempotencyKey: `installation-config:${newId()}` },
    );
    assert.equal(JSON.stringify(response).includes(smtpSecret), false);
    assert.equal(parsed(response).restartRequired, true);
    const saved = (
      await db.owner.query<{
        protected_configuration: string;
        revision: string;
      }>(
        "SELECT protected_configuration,revision::text FROM rootset_control.installation_settings",
      )
    ).rows[0]!;
    assert.equal(saved.protected_configuration.includes(smtpSecret), false);
    assert.equal(
      decryptProtected<{ smtp: { password: string } }>(
        saved.protected_configuration,
        config,
      ).smtp.password,
      smtpSecret,
    );
    const restart = await resolveInstallationConfig(db.identity, config);
    assert.equal(restart.config.smtp.auth?.pass, smtpSecret);
    assert.equal(
      parsed(
        await new InstallationService(
          db.identity,
          restart.config,
          restart.revision,
          outbox,
        ).configuration(),
      ).restartRequired,
      false,
    );
    const next = {
      ...config,
      encryptionKeys: {
        ...config.encryptionKeys,
        next: randomBytes(32).toString("base64"),
      },
      activeEncryptionKeyId: "next",
    };
    assert.equal(
      (await resolveInstallationConfig(db.identity, next)).config.smtp.auth
        ?.pass,
      smtpSecret,
    );
    await assert.rejects(
      resolveInstallationConfig(db.identity, {
        ...next,
        encryptionKeys: { next: next.encryptionKeys.next },
      }),
    );
    await assert.rejects(
      transaction(db.identity, async (client) => {
        const result = parsed(
          await installation.execute(
            "updateInstallationConfiguration",
            actor,
            { limits: { concurrentReads: 3 } },
            {
              approvalClient: client,
              idempotencyKey: `installation-config:${newId()}`,
            },
          ),
        );
        assert.equal(result.limits.concurrentReads, 3);
        throw new Error("Simulated failure before approval transaction commit");
      }),
      /Simulated failure before approval transaction commit/,
    );
    assert.equal((await installation.admissionLimits()).concurrentReads, 10);
    assert.equal(
      (
        await db.owner.query(
          "SELECT revision::text FROM rootset_control.installation_settings",
        )
      ).rows[0].revision,
      saved.revision,
    );
    await new InstallationService(
      db.identity,
      next,
      restart.revision,
      outbox,
    ).execute(
      "updateInstallationConfiguration",
      actor,
      { limits: { concurrentReads: 4 } },
      { idempotencyKey: `installation-config:${newId()}` },
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT protected_configuration FROM rootset_control.installation_settings",
        )
      ).rows[0].protected_configuration.startsWith("next:"),
      true,
    );
    await installation.execute(
      "testEmail",
      actor,
      { recipient: "rootset-installation-test@example.test" },
      { idempotencyKey: "installation-email-test-001" },
    );
    await installation.execute(
      "testEmail",
      actor,
      { recipient: "rootset-installation-test@example.test" },
      { idempotencyKey: "installation-email-test-001" },
    );
    const messages = (
      await db.owner.query(
        "SELECT state,provider_id,payload_encrypted FROM rootset_control.email_outbox WHERE dedupe_key LIKE 'installation-test:%'",
      )
    ).rows;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].state, "sent");
    assert(messages[0].provider_id);
    assert.equal(messages[0].payload_encrypted, "");
  } finally {
    await db.close();
  }
});

test("installation capacity and deletion-retention patches preserve omitted values and share the approval rollback", async () => {
  const db = await isolatedDatabase();
  try {
    const config = loadConfig();
    const outbox = new EmailOutbox(db.identity, {
      ...config,
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        from: config.smtp.from,
      },
    });
    const installation = new InstallationService(
      db.identity,
      config,
      "0",
      outbox,
    );
    const actor: Actor = {
      id: newId(),
      kind: "operator",
      userId: newId(),
      orgId: newId(),
      role: "owner",
      scopes: ["installation:read", "installation:manage"],
      targets: [],
      operator: true,
      unrestricted: true,
    };
    const initial = await installation.configuration();
    assert.equal(initial.storage.defaultOrganisationQuotaBytes, null);
    assert.deepEqual(initial.deletionRetention, {
      organisationDays: null,
      accountAuditDays: null,
    });
    await installation.execute(
      "updateInstallationConfiguration",
      actor,
      {
        storage: { defaultOrganisationQuotaBytes: "9007199254740993" },
        deletionRetention: { organisationDays: 14 },
      },
      { idempotencyKey: `installation-config:${newId()}` },
    );
    await installation.execute(
      "updateInstallationConfiguration",
      actor,
      {
        storage: { reportMaxAgeSeconds: 60 },
        deletionRetention: { accountAuditDays: 30 },
      },
      { idempotencyKey: `installation-config:${newId()}` },
    );
    const current = await installation.configuration();
    assert.equal(
      current.storage.defaultOrganisationQuotaBytes,
      "9007199254740993",
    );
    assert.equal(current.storage.reportMaxAgeSeconds, 60);
    assert.deepEqual(current.deletionRetention, {
      organisationDays: 14,
      accountAuditDays: 30,
    });
    assert.equal(current.restartRequired, false);
    await assert.rejects(
      transaction(db.identity, async (client) => {
        await installation.execute(
          "updateInstallationConfiguration",
          actor,
          {
            storage: {
              defaultOrganisationQuotaBytes: null,
              reportMaxAgeSeconds: 90,
            },
            deletionRetention: { organisationDays: null },
          },
          {
            approvalClient: client,
            idempotencyKey: `installation-config:${newId()}`,
          },
        );
        throw new Error("Approval transaction rollback fixture");
      }),
      /Approval transaction rollback fixture/,
    );
    assert.deepEqual(await installation.configuration(), current);
  } finally {
    await db.close();
  }
});

test("installation retries bind the credential and input, publish once concurrently, and roll back their receipt with approval", async () => {
  const db = await isolatedDatabase();
  try {
    const config = loadConfig();
    const outbox = new EmailOutbox(db.identity, config);
    const installation = new InstallationService(
      db.identity,
      config,
      "0",
      outbox,
    );
    const actor: Actor = {
      id: newId(),
      kind: "operator",
      userId: newId(),
      orgId: newId(),
      role: "owner",
      scopes: ["installation:read", "installation:manage"],
      targets: [],
      operator: true,
      unrestricted: true,
    };
    const key = `configuration-retry:${newId()}`;
    const input = { limits: { concurrentReads: 7 } };
    const update = (principal: Actor = actor, value = input) =>
      installation.execute(
        "updateInstallationConfiguration",
        principal,
        value,
        { idempotencyKey: key },
      );
    const [first, second] = await Promise.all([update(), update()]);
    assert.deepEqual(second, first);
    assert.deepEqual(await update(), first);
    const count = async () =>
      (
        await db.owner.query(
          "SELECT revision::text,(SELECT count(*)::integer FROM rootset_control.installation_audit) AS audit_count FROM rootset_control.installation_settings",
        )
      ).rows[0];
    assert.deepEqual(await count(), { revision: "1", audit_count: 1 });
    await assert.rejects(
      update(actor, { limits: { concurrentReads: 8 } }),
      (error: unknown) =>
        (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
    );
    assert.deepEqual(await count(), { revision: "1", audit_count: 1 });
    await update({ ...actor, id: newId(), credentialId: newId() });
    assert.deepEqual(await count(), { revision: "2", audit_count: 2 });
    const rollbackKey = `configuration-rollback:${newId()}`;
    await assert.rejects(
      transaction(db.identity, async (client) => {
        await installation.execute(
          "updateInstallationConfiguration",
          actor,
          { limits: { concurrentReads: 6 } },
          { approvalClient: client, idempotencyKey: rollbackKey },
        );
        throw new Error("Receipt rollback after mutation");
      }),
      /Receipt rollback after mutation/,
    );
    assert.deepEqual(await count(), { revision: "2", audit_count: 2 });
    assert.equal((await installation.admissionLimits()).concurrentReads, 7);
    const receipts = (
      await db.owner.query(
        "SELECT key_digest,input_digest,outcome FROM rootset_control.control_mutation_replays WHERE operation_id='updateInstallationConfiguration'",
      )
    ).rows;
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) {
      assert.match(receipt.key_digest, /^[a-f0-9]{64}$/);
      assert.match(receipt.input_digest, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(receipt).includes(key), false);
      getOperation("updateInstallationConfiguration").outputSchema.parse(
        receipt.outcome,
      );
    }
  } finally {
    await db.close();
  }
});

test("readiness detects migration drift, stale workers, unavailable SMTP and object storage without exposing credentials", async () => {
  const db = await isolatedDatabase();
  try {
    const config = loadConfig();
    const outbox = new EmailOutbox(db.identity, {
      ...config,
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        from: config.smtp.from,
      },
    });
    const installation = new InstallationService(
      db.identity,
      config,
      "0",
      outbox,
    );
    const workerId = newId();
    await db.owner.query(
      "INSERT INTO rootset_control.worker_heartbeats(id,state) VALUES($1,'ready')",
      [workerId],
    );
    const ready = await installation.status();
    getOperation("getInstallationStatus").outputSchema.parse(ready);
    assert.equal(ready.healthy, true);
    assert.equal(ready.metrics.databaseStatus, "healthy");
    assert.equal(ready.storage?.admission.state, "available");
    const latest = (
      await db.owner.query<{ name: string; digest: string; applied_at: Date }>(
        "SELECT name,digest,applied_at FROM rootset_control.migrations ORDER BY name DESC LIMIT 1",
      )
    ).rows[0]!;
    await db.owner.query(
      "UPDATE rootset_control.migrations SET digest=$2 WHERE name=$1",
      [latest.name, "0".repeat(64)],
    );
    assert.equal(
      (await installation.status()).dependencies.postgresql,
      "degraded",
    );
    await assert.rejects(migrate(db.owner), /changed after application/);
    await db.owner.query(
      "UPDATE rootset_control.migrations SET digest=$2 WHERE name=$1",
      [latest.name, latest.digest],
    );
    await db.owner.query(
      "DELETE FROM rootset_control.migrations WHERE name=$1",
      [latest.name],
    );
    assert.equal((await migrationStatus(db.identity)).complete, false);
    await db.owner.query(
      "INSERT INTO rootset_control.migrations(name,digest,applied_at) VALUES($1,$2,$3)",
      [latest.name, latest.digest, latest.applied_at],
    );
    await db.owner.query(
      "INSERT INTO rootset_control.migrations(name,digest) VALUES('999_unexpected.sql',$1)",
      ["0".repeat(64)],
    );
    assert.equal((await migrationStatus(db.identity)).complete, false);
    await db.owner.query(
      "DELETE FROM rootset_control.migrations WHERE name='999_unexpected.sql'",
    );
    assert.equal((await installation.status()).healthy, true);
    await db.owner.query(
      "UPDATE rootset_control.worker_heartbeats SET heartbeat_at=now()-interval '31 seconds' WHERE id=$1",
      [workerId],
    );
    const stale = await installation.status();
    assert.equal(stale.dependencies.worker, "unavailable");
    assert.equal(stale.healthy, false);
    await db.owner.query(
      "UPDATE rootset_control.worker_heartbeats SET heartbeat_at=now() WHERE id=$1",
      [workerId],
    );
    const unavailableSMTP = new EmailOutbox(db.identity, {
      ...config,
      smtp: {
        host: "127.0.0.1",
        port: 1,
        secure: false,
        from: config.smtp.from,
      },
    });
    const smtpFailure = await new InstallationService(
      db.identity,
      config,
      "0",
      unavailableSMTP,
    ).status();
    assert.equal(smtpFailure.dependencies.smtp, "unavailable");
    assert.equal(smtpFailure.healthy, false);
    const objectFailure = await new InstallationService(
      db.identity,
      {
        ...config,
        artifacts: {
          ...config.artifacts,
          bucket: `absent-${newId().toLowerCase()}`,
        },
      },
      "0",
      outbox,
    ).status();
    assert.equal(objectFailure.dependencies.objectStorage, "unavailable");
    assert.equal(objectFailure.healthy, false);
    const serialized = JSON.stringify(objectFailure);
    for (const secret of [
      config.secret,
      config.cursorSecret,
      config.artifacts.secretAccessKey,
    ])
      assert.equal(serialized.includes(secret), false);
    await transaction(db.identity, (client) =>
      installation.capacity.configure(client, { minimumFreeBytes: "1" }),
    );
    const reportMissing = await installation.status();
    assert.equal(reportMissing.storage?.admission.state, "report_stale");
    assert.equal(reportMissing.dependencies.storageAdmission, "degraded");
  } finally {
    await db.close();
  }
});
