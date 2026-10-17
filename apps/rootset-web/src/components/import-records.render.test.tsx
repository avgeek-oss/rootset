import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Job } from "@rootset/contracts";
import {
  ImportStatus,
  importJobActive,
  importReportId,
} from "./import-records";

const request = (state: Job["state"], extra: Partial<Job> = {}): Job => ({
  id: "01J00000000000000000000000",
  orgId: "01J00000000000000000000001",
  kind: "import",
  operationId: "importRows",
  state,
  createdAt: "2026-10-17T10:00:00Z",
  updatedAt: "2026-10-17T10:00:00Z",
  ...extra,
});
describe("import request results", () => {
  it("distinguishes a completed validation with row errors from a successful import", () => {
    const invalid = request("succeeded", {
      kind: "import_preview",
      result: {
        total: 2,
        valid: 1,
        invalid: 1,
        schemaVersion: 1,
        fileName: "records.csv",
        preview: [],
        issues: [],
      },
    });
    const html = renderToStaticMarkup(
      createElement(ImportStatus, { job: invalid }),
    );
    expect(html).toContain("Needs correction");
    expect(html).not.toContain("Succeeded");
    expect(
      renderToStaticMarkup(
        createElement(ImportStatus, { job: request("succeeded") }),
      ),
    ).toContain("Succeeded");
  });
  it("keeps error reports available after partial commits and only polls active requests", () => {
    expect(
      importReportId(
        request("partially_completed", {
          error: {
            code: "IMPORT_VALIDATION_FAILED",
            requestId: "test",
            message: "Review the remaining rows",
            details: { reportArtifactId: "report-1" },
          },
        }),
      ),
    ).toBe("report-1");
    expect(
      importReportId(
        request("failed", {
          error: {
            code: "JOB_FAILED",
            message: "Failed",
            requestId: "test",
            details: "invalid",
          },
        }),
      ),
    ).toBeUndefined();
    expect(importJobActive(request("queued"))).toBe(true);
    expect(importJobActive(request("running"))).toBe(true);
    expect(importJobActive(request("partially_completed"))).toBe(false);
    expect(importJobActive(request("succeeded"))).toBe(false);
  });
});
