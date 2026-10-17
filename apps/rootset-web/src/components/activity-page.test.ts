import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@rootset/contracts";
import { activityHref } from "./activity-page";

const event: ActivityEvent = {
  id: "m:record",
  category: "records",
  occurredAt: "2026-10-17T00:00:00.000Z",
  summary: "Records changed",
  event: "records.changed",
  status: "succeeded",
  actor: {
    id: null,
    key: "system:rootset-worker",
    kind: "system",
    name: "Rootset worker",
    avatarUrl: null,
  },
  database: { id: "db", name: "Aircraft", state: "active" },
  table: { id: "table", name: "Models", state: "active" },
  rowId: "row",
  affectedRows: 1,
  jobId: null,
  fileName: null,
  destination: "record",
};
describe("activity resource navigation", () => {
  it("opens the exact record independently of relationship filter parameters", () => {
    expect(activityHref(event)).toBe("/databases/db/tables/table?row=row");
    expect(activityHref({ ...event, rowId: null })).toBeNull();
  });
  it("keeps request links in the right database or table scope", () => {
    expect(activityHref({ ...event, destination: "imports" })).toBe(
      "/databases/db/tables/table/settings/import-requests",
    );
    expect(activityHref({ ...event, destination: "exports" })).toBe(
      "/databases/db/tables/table/settings/export-requests",
    );
    expect(
      activityHref({ ...event, destination: "database-exports", table: null }),
    ).toBe("/databases/db/settings/export-requests");
    expect(
      activityHref({ ...event, destination: "backup-history", table: null }),
    ).toBe("/databases/db/settings/backup-attempts");
    expect(
      activityHref({
        ...event,
        category: "restores",
        destination: "backup-history",
        table: null,
      }),
    ).toBe("/databases/db/settings/restore-attempts");
  });
  it("suppresses unavailable and deleted targets instead of opening unrelated data", () => {
    for (const patch of [
      { destination: null },
      { database: null },
      { database: { ...event.database!, state: "deleted" as const } },
      { table: { ...event.table!, state: "deleted" as const } },
      { table: { ...event.table!, state: "maintenance" as const } },
      { table: null },
    ])
      expect(activityHref({ ...event, ...patch })).toBeNull();
  });
});
