import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityInputSchema, ActivityFilterInputSchema } from "./activity";
import {
  activityEventCatalog,
  activityEventDefinitions,
  ActivityEventNameSchema,
} from "./activity-events";

test("audit event names are unique and every selectable event has a label, category and icon", () => {
  const names = activityEventDefinitions.map((event) => event.name);
  assert.equal(new Set(names).size, names.length);
  for (const event of activityEventDefinitions) {
    assert.equal(ActivityEventNameSchema.parse(event.name), event.name);
    assert.ok(event.label && event.category && event.icon);
  }
  assert.equal(
    activityEventCatalog["job.exportView.succeeded"]!.label,
    "View export completed",
  );
  assert.equal(activityEventCatalog["foreign-key.create"]!.icon, "foreign-key");
  assert.equal(
    activityEventCatalog["database.backup_schedule.delete"]!.icon,
    "schedule",
  );
  assert.equal(activityEventCatalog["backup.failed.resolved"]!.icon, "alert");
  assert.equal(
    activityEventCatalog["job.restoreDatabaseBackup.succeeded"],
    undefined,
  );
});

test("audit filters reject unknown event names, malformed resource keys and unbounded option requests", () => {
  const orgId = "01M4Z29DYW3NBAVHB1QS52RYAS";
  assert.equal(
    ActivityInputSchema.safeParse({ orgId, event: "private-view.secret" })
      .success,
    false,
  );
  assert.equal(
    ActivityInputSchema.safeParse({ orgId, resource: "table:invalid" }).success,
    false,
  );
  assert.equal(
    ActivityFilterInputSchema.safeParse({ orgId, kind: "actors", limit: 101 })
      .success,
    false,
  );
  assert.equal(
    ActivityInputSchema.parse({
      orgId,
      event: "records.changed",
      actor: "system:rootset-worker",
      resource: `database:${orgId}`,
    }).event,
    "records.changed",
  );
});
