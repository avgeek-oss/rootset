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
    "Rendered settings email navigation with real login and automatic single-organisation context",
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
    "Manual backups",
  );
  await expect(
    page.locator(`main nav a[href="/?databaseId=${fixture.databaseId}"]`),
  ).toHaveText("Tables");
  await expect(page.locator("main nav a[href*=tableId]")).toHaveCount(0);
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
  const selected = await context.request.get("/api/internal/v1/context");
  expect(selected.ok()).toBe(true);
  await page.goto(path);
  await expect(page.locator(".settings-header h1")).toHaveText(
    "Database backups",
    { timeout: 15000 },
  );
  await expect(
    page.locator(`main nav a[href="/?databaseId=${fixture.databaseId}"]`),
  ).toHaveText("Tables");
  const switched = await context.request.get("/api/internal/v1/context");
  expect((await switched.json()).organisation.id).toBe(fixture.orgId);
  await expect(
    page.locator(".settings-content [role=alert]").filter({ hasText: /\S/ }),
  ).toHaveCount(0);
  report.checks.push({
    name: "Signed-in email link opens its installation organisation with its database navigation",
    status: "passed",
  });
  await page.goto(
    `/settings/backups?organisationId=${fixture.orgId === "01K6DVWSFS9MR156YW1H5XZ440" ? "01K6DVWSFS9MR156YW1H5XZ441" : "01K6DVWSFS9MR156YW1H5XZ440"}&databaseId=${fixture.databaseId}`,
  );
  await expect(page.getByRole("alert")).toContainText(
    "different installation organisation",
  );
  expect(
    (await (await context.request.get("/api/internal/v1/context")).json())
      .organisation.id,
  ).toBe(fixture.orgId);
  report.checks.push({
    name: "Foreign organisation deep link is refused without changing the session context",
    status: "passed",
  });
  await page.goto(path);
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
