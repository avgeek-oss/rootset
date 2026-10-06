import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, getOperation } from "@rootset/contracts";
import { migrationStatus, migrate } from "@rootset/database";
import { EmailOutbox } from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { loadConfig } from "./config.js";
import { InstallationService } from "./installation.js";

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
    const installation = new InstallationService(db.identity, config, outbox);
    const workerId = newId();
    await db.owner.query(
      "INSERT INTO rootset_control.worker_heartbeats(id,state) VALUES($1,'ready')",
      [workerId],
    );
    const ready = await installation.status();
    getOperation("getInstallationStatus").outputSchema.parse(ready);
    assert.equal(ready.healthy, true);
    assert.equal(ready.metrics.databaseStatus, "healthy");
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
  } finally {
    await db.close();
  }
});
