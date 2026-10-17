import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExportRequestsTable } from "./jobs";
import type { Job } from "./types";

vi.mock("./account/last-synced-time", () => ({
  RelativeTime: ({ value }: { value: string }) =>
    createElement("time", null, value),
}));
const render = (requests: Job[], databaseLevel = false) =>
  renderToStaticMarkup(
    createElement(ExportRequestsTable, {
      requests,
      databaseLevel,
      busy: false,
      onDownload() {},
      onCancel() {},
      onRetry() {},
    }),
  );
const request = (state: string, extra: Partial<Job> = {}): Job => ({
  id: "export-1",
  kind: "export",
  state,
  format: "csv",
  createdAt: "2026-10-09T10:00:00Z",
  ...extra,
});
describe("export request history", () => {
  it("shows the completed file and row count with a download action", () => {
    const html = render([
      request("succeeded", {
        result: { artifactId: "artifact-1", rowCount: 30 },
      }),
    ]);
    for (const text of ["CSV", "30", "Download", "Requested", "Status"])
      expect(html).toContain(text);
    expect(html).not.toContain(">Cancel<");
    expect(html).not.toContain(">Retry<");
  });
  it("offers cancellation while running and retry after failure", () => {
    const running = render([request("running", { format: "jsonl" })]);
    expect(running).toContain("JSONL");
    expect(running).toContain(">Cancel<");
    expect(running).not.toContain(">Download<");
    const failed = render([request("failed")]);
    expect(failed).toContain(">Retry<");
    expect(failed).not.toContain(">Download<");
  });
  it("shows database table data format and table counts in the shared table", () => {
    const html = render(
      [
        request("succeeded", {
          format: "jsonl",
          result: { artifactId: "artifact-1", rowCount: 30, tableCount: 3 },
        }),
      ],
      true,
    );
    for (const text of ["JSONL", "Tables", "Rows", "30", "Download"])
      expect(html).toContain(text);
    expect(html).toContain("<table");
    expect(html).toContain(">3<");
    expect(render([], true)).toContain(
      "every table’s schema and CSV or JSONL data",
    );
    expect(render([request("succeeded")])).not.toContain(">Tables<");
  });
  it("explains that requests include every row and field", () => {
    expect(render([])).toContain("every row and field as CSV or JSONL");
  });
});
