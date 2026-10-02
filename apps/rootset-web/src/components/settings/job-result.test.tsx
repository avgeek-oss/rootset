import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobSchema, type JsonValue } from "@rootset/contracts";
import { JobResultDetails } from "./job-result";

const artifactId = "01M3YXT3XA864RRTE47RRKMWT1";
function render(result: JsonValue, state = "succeeded") {
  const job = JobSchema.parse({
    id: artifactId,
    orgId: artifactId,
    kind: "import",
    operationId: "importRows",
    state,
    createdAt: "2026-10-02T18:00:00.000Z",
    updatedAt: "2026-10-02T18:00:01.000Z",
    result,
  });
  return renderToStaticMarkup(
    createElement(JobResultDetails, { result: job.result!, openArtifact() {} }),
  );
}

describe("shared durable job result consumer", () => {
  it("shows the producer's committed count for a partial import", () => {
    const html = render(
      {
        committed: 2,
        rejected: 1,
        processed: 3,
        partial: true,
        rejectionArtifactId: artifactId,
      },
      "partially_completed",
    );
    expect(html).toContain("Committed");
    expect(html).toMatch(/Committed(?:<!-- -->)?\s*(?:<!-- -->)?2/);
    expect(html).toContain("rejected");
  });
  it("offers the real import rejection artifact instead of requiring the validation-report field", () => {
    const html = render(
      { committed: 2, rejected: 1, rejectionArtifactId: artifactId },
      "partially_completed",
    );
    expect(html).toContain("Download rejection report");
    expect(html).not.toContain("Download result");
  });
  it("preserves validation-report and export artifact controls", () => {
    expect(
      render({
        valid: false,
        accepted: 0,
        rejected: 1,
        reportArtifactId: artifactId,
      }),
    ).toContain("Download rejection report");
    expect(render({ artifactId, rowCount: 3 })).toContain("Download result");
  });
  it("shows zero committed rows truthfully and preserves existing count variants", () => {
    const html = render({ committed: 0, inserted: 1, updated: 2, rejected: 3 });
    expect(html).toContain("Committed");
    expect(html).toMatch(/Committed(?:<!-- -->)?\s*(?:<!-- -->)?0/);
    expect(html).toContain("Inserted");
    expect(html).toContain("updated");
    expect(html).toContain("rejected");
  });
});
