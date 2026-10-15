import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupScheduleSettings } from "./backups";
import type { SettingsPanelProps } from "./types";

const fixture = vi.hoisted(() => ({ available: true, loading: false }));
vi.mock("./api", () => ({
  databasePath: () => "/orgs/org/databases/database",
  organisationPath: () => "/orgs/org",
  performAction: vi.fn(),
  readRaw: vi.fn(),
  useResource: (path?: string) => ({
    data: path?.includes("backup-schedule")
      ? fixture.loading
        ? null
        : {
            schedule: null,
            worker: { available: fixture.available, matchesSchedule: true },
            nextRuns: [],
          }
      : path?.includes("/backups?")
        ? {
            data: [
              {
                id: "backup-run",
                kind: "backup",
                trigger: "manual",
                state: "succeeded",
                stage: "succeeded",
                scheduledAt: "2026-10-15T00:00:00.000Z",
                snapshotAt: "2026-10-15T00:00:00.000Z",
                startedAt: null,
                completedAt: null,
                sizeBytes: 1024,
                tableCount: 2,
                rowCount: 4,
                error: null,
                note: null,
                objectKey: "db/backup.rootset-backup",
                bucket: "backup-bucket",
                skippedUntil: null,
              },
            ],
            nextCursor: null,
          }
        : null,
    loading: fixture.loading,
    reload() {},
    replace() {},
  }),
  useMutation: () => ({ busy: false, run: vi.fn() }),
}));
const props: SettingsPanelProps = {
  orgId: "org",
  databaseId: "database",
  section: "backup-schedule",
  onClose() {},
};
beforeEach(() => {
  fixture.available = true;
  fixture.loading = false;
});
describe("database backup schedule page", () => {
  it("uses labelled controls and a real table without exposing credentials or restore controls", () => {
    const html = renderToStaticMarkup(
      createElement(BackupScheduleSettings, props),
    );
    for (const label of [
      "Bucket",
      "Path prefix",
      "Cron schedule",
      "Timezone",
      "Automatic backups",
      "Test destination",
      "Save schedule",
    ])
      expect(html).toContain(label);
    expect(html).toContain("<form");
    expect(html).toContain("<table");
    expect(html).toContain("Database backups");
    expect(html).not.toContain("Secret key");
    expect(html).not.toContain("Restore backup");
  });
  it("explains unavailable worker configuration", () => {
    fixture.available = false;
    const html = renderToStaticMarkup(
      createElement(BackupScheduleSettings, props),
    );
    expect(html).toContain("no backup-enabled worker is online");
  });
  it("does not expose a premature schedule form before loading", () => {
    fixture.loading = true;
    expect(
      renderToStaticMarkup(createElement(BackupScheduleSettings, props)),
    ).not.toContain("<form");
  });
});
