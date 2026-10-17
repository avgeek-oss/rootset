import { createElement, type ReactElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupScheduleSettings } from "./backups";
import { BackupHistorySettings } from "./backup-history";
import { RestoreRequestsSettings } from "./restore-requests";
import type { SettingsPanelProps } from "./types";

const renderToStaticMarkup = (element: ReactElement) =>
  renderMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, element),
  );
vi.mock("./account/last-synced-time", () => ({
  RelativeTime: ({ value, label }: { value: string; label: string }) =>
    createElement(
      "time",
      { dateTime: value, "aria-label": label },
      "a minute ago",
    ),
}));
vi.mock("./account/page-selection-title", () => ({
  PageSelectionTitle: ({
    label,
    actions,
  }: {
    label: string;
    actions?: ReactNode;
  }) => createElement("header", null, label, actions),
}));
const fixture = vi.hoisted(() => ({
  available: true,
  matches: true,
  loading: false,
  verified: false,
  pendingSave: false,
  active: false,
}));
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
            schedule: fixture.verified
              ? { testedAt: "2026-10-15T00:00:00.000Z" }
              : null,
            version: 0,
            pendingSaveJobId: fixture.pendingSave ? "save-job" : null,
            worker: {
              available: fixture.available,
              matchesSchedule: fixture.matches,
            },
            nextRuns: [],
          }
      : path?.includes("/backups?")
        ? {
            data: ["manual", "schedule"].map((trigger) => ({
              id: `backup-run-${trigger}`,
              kind: "backup",
              storageState: "available",
              prunedAt: null,
              retentionError: null,
              trigger,
              state:
                fixture.active && trigger === "manual"
                  ? "running"
                  : "succeeded",
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
            })),
            nextCursor: null,
          }
        : path?.includes("kind=database_restore")
          ? {
              data: [
                {
                  id: "restore-request",
                  backupId: "backup-run-manual",
                  kind: "database_restore",
                  createdAt: "2026-10-15T00:00:00.000Z",
                  state: "succeeded",
                  stage: "succeeded",
                  result: { databaseId: "restored-database" },
                  error: null,
                },
              ],
              nextCursor: null,
            }
          : { data: [], nextCursor: null },
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
  fixture.matches = true;
  fixture.loading = false;
  fixture.verified = false;
  fixture.pendingSave = false;
  fixture.active = false;
});
describe("database backup schedule page", () => {
  it("keeps the schedule form separate from history without exposing credentials or restore controls", () => {
    const html = renderToStaticMarkup(
      createElement(BackupScheduleSettings, props),
    );
    for (const label of [
      "Bucket",
      "Path prefix",
      "Cron schedule",
      "Time zone",
      "Save schedule",
    ])
      expect(html).toContain(label);
    expect(html).toContain("<form");
    expect(html).not.toContain("Enable scheduled backups");
    expect(html).not.toContain("Test destination");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Database backups");
    expect(html).not.toContain("Secret key");
    expect(html).not.toContain("Restore backup");
    expect(html).not.toContain("Back up now");
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

describe("database backup attempts page", () => {
  it("renders history in a table with concise type chips and the shared relative dates", () => {
    const html = renderToStaticMarkup(
      createElement(BackupHistorySettings, {
        ...props,
        section: "backup-history",
      }),
    );
    expect(html).toContain("<table");
    expect(html).toContain("Database backup attempts");
    expect(html).toContain("Backup Attempts");
    expect(html).toContain("Back up now");
    expect(html).toContain("chip__label");
    expect(html).toContain(">Manual<");
    expect(html).toContain(">Scheduled<");
    expect(html).not.toContain("Manual backup");
    expect(html).not.toContain("Scheduled backup");
    expect(html).toContain('aria-label="Scheduled"');
    expect(html).toContain('aria-label="Snapshot"');
    expect(html).toContain("a minute ago");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Save schedule");
    expect(html).not.toContain("Database restore attempts");
    expect(html).not.toContain("View attempt");
  });
  const backupButton = () => {
    const html = renderToStaticMarkup(
      createElement(BackupHistorySettings, {
        ...props,
        section: "backup-history",
      }),
    );
    return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
      .map(([button]) => button)
      .find((button) => button.includes("Back up now"));
  };
  it("allows a manual backup at a verified destination with an available matching worker", () => {
    fixture.verified = true;
    const button = backupButton();
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });
  it.each([
    { available: false },
    { matches: false },
    { verified: false },
    { pendingSave: true },
    { active: true },
    { loading: true },
  ])("blocks a manual backup when not ready: %j", (state) => {
    fixture.verified = true;
    Object.assign(fixture, state);
    expect(backupButton()).toContain("disabled");
  });
});

describe("database restore attempts page", () => {
  it("keeps restore status and destination links on a separate page", () => {
    const html = renderToStaticMarkup(
      createElement(RestoreRequestsSettings, {
        ...props,
        section: "restore-requests",
      }),
    );
    expect(html).toContain("Database restore attempts");
    expect(html).toContain("Restore Attempts");
    expect(html).toContain('aria-label="Restore requested"');
    expect(html).toContain("a minute ago");
    expect(html).toContain("Completed");
    expect(html).toContain('href="/databases/restored-database"');
    expect(html).toContain("View attempt");
    expect(html).not.toContain("Database backups");
    expect(html).not.toContain("Save schedule");
  });
});
