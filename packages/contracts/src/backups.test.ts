import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BackupDestinationSchema,
  BackupScheduleInputSchema,
} from "./backups.js";
import { getOperation } from "./operations.js";

test("backup destinations normalize only outer slashes and reject unsafe or oversized object paths", () => {
  assert.deepEqual(
    BackupDestinationSchema.parse({
      bucket: "rootset-backups",
      prefix: "/production/data/",
    }),
    { bucket: "rootset-backups", prefix: "production/data" },
  );
  for (const prefix of [
    "../data",
    "data/../other",
    "data/./other",
    "data\\other",
    "secret\u0000",
    "航".repeat(300),
  ])
    assert.equal(
      BackupDestinationSchema.safeParse({ bucket: "rootset-backups", prefix })
        .success,
      false,
    );
  assert.equal(
    BackupDestinationSchema.safeParse({ bucket: "rootset-backups", prefix: "" })
      .success,
    true,
  );
});
test("schedules require explicit timezone and optimistic version", () => {
  const input = {
    bucket: "rootset-backups",
    prefix: "production",
    cron: "0 2 * * *",
    timezone: "UTC",
    expectedVersion: 0,
  };
  assert.equal(BackupScheduleInputSchema.safeParse(input).success, true);
  for (const field of ["timezone", "expectedVersion"]) {
    const missing: Record<string, unknown> = { ...input };
    delete missing[field];
    assert.equal(BackupScheduleInputSchema.safeParse(missing).success, false);
  }
  assert.equal(
    BackupScheduleInputSchema.safeParse({
      ...input,
      secretKey: "client-supplied",
    }).success,
    false,
  );
});
test("backup administration remains Admin-only and previews stay read-only across contracts", () => {
  for (const id of [
    "getBackupSchedule",
    "saveBackupSchedule",
    "deleteBackupSchedule",
    "previewBackupSchedule",
    "listDatabaseBackups",
    "runDatabaseBackup",
    "testBackupDestination",
  ]) {
    const operation = getOperation(id);
    assert.equal(operation.minimumRole, "admin");
    assert.equal(operation.resource, "database");
  }
  assert.equal(getOperation("previewBackupSchedule").readOnly, true);
  assert.equal(
    getOperation("previewBackupSchedule").idempotencyRequired,
    false,
  );
  assert.equal(getOperation("runDatabaseBackup").successStatus, 202);
});
