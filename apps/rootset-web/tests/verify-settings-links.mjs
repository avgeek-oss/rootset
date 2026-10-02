import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";

const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const report = {
  browser: "chromium",
  source:
    "Rendered settings email navigation with real login and organisation selection",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
const path = `/settings/backups?organisationId=${fixture.orgId}&databaseId=${fixture.databaseId}`;
await mkdir(output, { recursive: true });
try {
  await page.goto(path);
  await expect(
    page.getByRole("heading", { name: "Sign in to Rootset", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: /^Email address/ })
    .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
  await page
    .getByLabel(/^Password/)
    .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".settings-header h1")).toHaveText(
    "Database backups",
    { timeout: 15000 },
  );
  await expect(page.locator(".settings-content")).toContainText(
    "Backup schedule",
  );
  await expect(
    page.locator(".settings-content [role=alert]").filter({ hasText: /\S/ }),
  ).toHaveCount(0);
  const current = await context.request.get("/api/internal/v1/context");
  expect((await current.json()).organisation.id).toBe(fixture.orgId);
  report.checks.push({
    name: "Signed-out backup email link survives real sign-in and opens its authorised organisation and database",
    status: "passed",
    path,
  });
  const selected = await context.request.post("/v1/auth/organisation", {
    headers: { Origin: baseURL },
    data: { orgId: "01M3YBJF63FQKFPQSK568N7A1D" },
  });
  expect(selected.ok()).toBe(true);
  await page.goto(path);
  await expect(page.locator(".settings-header h1")).toHaveText(
    "Database backups",
    { timeout: 15000 },
  );
  const switched = await context.request.get("/api/internal/v1/context");
  expect((await switched.json()).organisation.id).toBe(fixture.orgId);
  await expect(
    page.locator(".settings-content [role=alert]").filter({ hasText: /\S/ }),
  ).toHaveCount(0);
  report.checks.push({
    name: "Signed-in email link selects an accessible destination organisation through the real session endpoint",
    status: "passed",
  });
  await page.screenshot({
    path: new URL("chromium-backup-email-link.png", output).pathname,
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
  report.visibleErrors = await page.getByRole("alert").allTextContents();
} finally {
  await writeFile(
    new URL("chromium-settings-links-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
