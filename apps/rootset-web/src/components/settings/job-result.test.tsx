import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobResultDetails } from "./job-result";

describe("export job result", () => {
  it("shows the row count and a download action", () => {
    const html = renderToStaticMarkup(
      createElement(JobResultDetails, {
        result: { artifactId: "01M3YXT3XA864RRTE47RRKMWT1", rowCount: 3 },
        openArtifact() {},
      }),
    );
    expect(html).toContain("Download result");
    expect(html).toMatch(/Exported.*3.*rows/);
  });
  it("shows no download action for a result without an artifact", () => {
    const html = renderToStaticMarkup(
      createElement(JobResultDetails, {
        result: { rowCount: 0 },
        openArtifact() {},
      }),
    );
    expect(html).not.toContain("Download result");
  });
});
