import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";

const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL, acceptDownloads: true });
const page = await context.newPage();
const report = {
  browser: "chromium",
  source:
    "Rendered snapshot export queues through the worker then downloads with the current browser session",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
let downloadResolve;
const downloadPromise = new Promise((resolve) => {
  downloadResolve = resolve;
});
page.on("download", downloadResolve);
context.on("page", (opened) => opened.on("download", downloadResolve));
try {
  const signed = await context.request.post(
    new URL("/v1/auth/sign-in/email", apiURL).href,
    {
      headers: { Origin: baseURL },
      data: {
        email: credentials.ROOTSET_TEST_OWNER_EMAIL,
        password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
      },
    },
  );
  expect(signed.ok()).toBe(true);
  await page.goto(
    `/settings/exports?organisationId=${fixture.orgId}&databaseId=${fixture.databaseId}&tableId=${fixture.tableId}`,
  );
  await expect(page.locator(".settings-header h1")).toHaveText("Export rows");
  const queuedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/exports"),
  );
  await page.getByRole("button", { name: "Start export", exact: true }).click();
  const queued = await queuedResponse;
  expect(queued.status()).toBe(202);
  const jobId = (await queued.json()).jobId;
  let job;
  await expect
    .poll(
      async () => {
        const response = await context.request.get(
          new URL(
            `/api/internal/v1/orgs/${fixture.orgId}/jobs/${jobId}`,
            apiURL,
          ).href,
        );
        expect(response.ok()).toBe(true);
        job = await response.json();
        if (["failed", "cancelled", "partially_completed"].includes(job.state))
          throw new Error(`Export ${job.state}: ${job.error?.code}`);
        return job.state;
      },
      { timeout: 120000, intervals: [2000, 5000] },
    )
    .toBe("succeeded");
  report.checks.push({
    name: "Rendered export receives queued202 and follows verified worker success",
    status: "passed",
    jobId,
  });
  const artifactResponse = await context.request.get(
    new URL(
      `/api/internal/v1/orgs/${fixture.orgId}/artifacts/${job.result.artifactId}`,
      apiURL,
    ).href,
  );
  expect(artifactResponse.ok()).toBe(true);
  const artifact = await artifactResponse.json();
  await page
    .getByRole("button", { name: "Download result", exact: true })
    .click();
  const download = await Promise.race([
    downloadPromise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("The rendered download did not start.")),
        20000,
      ),
    ),
  ]);
  expect(new URL(download.url()).pathname).toBe(
    `/api/internal/v1/orgs/${fixture.orgId}/artifacts/${artifact.id}/download`,
  );
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(await download.path());
  expect(bytes.byteLength).toBe(artifact.sizeBytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    artifact.checksum,
  );
  expect(bytes.toString("utf8")).toContain("NAME");
  report.checks.push({
    name: "Actual Download result control starts an authenticated browser download with exact artifact length and SHA256",
    status: "passed",
    byteLength: bytes.byteLength,
    artifactId: artifact.id,
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
  report.visibleErrors = await page
    .getByRole("alert")
    .filter({ hasText: /\S/ })
    .allTextContents();
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL("chromium-export-download-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
