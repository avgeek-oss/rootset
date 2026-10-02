import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
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
    "Actual operator configuration and measurement UI with immutable action approval",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
let original;
async function configuration() {
  const response = await context.request.get(
    "/api/internal/v1/installation/configuration",
  );
  if (!response.ok()) throw new Error(`Configuration HTTP${response.status()}`);
  return response.json();
}
async function approve() {
  const dialog = page.getByRole("dialog", {
    name: "Approve account action",
    exact: true,
  });
  await expect(dialog.locator(".action-review")).toContainText(
    "Requested changes",
  );
  await dialog
    .getByRole("button", { name: "Approve action", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
async function saveCapacity(value) {
  await page
    .getByLabel("Installation quota (bytes)", { exact: true })
    .fill(value.installationQuotaBytes ?? "");
  await page
    .getByLabel("Default organisation quota (bytes)", { exact: true })
    .fill(value.defaultOrganisationQuotaBytes ?? "");
  await page
    .getByLabel("Minimum free disk reserve (bytes)", { exact: true })
    .fill(value.minimumFreeBytes ?? "");
  await page
    .getByLabel("Maximum filesystem report age (seconds)", { exact: true })
    .fill(String(value.reportMaxAgeSeconds));
  await page
    .getByLabel("Organisation quota overrides", { exact: true })
    .fill(
      value.organisationOverrides
        .map(({ orgId, quotaBytes }) => `${orgId}=${quotaBytes ?? "none"}`)
        .join("\n"),
    );
  await page
    .getByRole("button", { name: "Save storage policy", exact: true })
    .click();
  await approve();
  await expect(page.locator(".settings-content")).toContainText(
    "Storage admission policy saved.",
  );
}
await mkdir(output, { recursive: true });
try {
  const signed = await context.request.post("/v1/auth/sign-in/email", {
    headers: { Origin: baseURL },
    data: {
      email: credentials.ROOTSET_TEST_OWNER_EMAIL,
      password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
    },
  });
  expect(signed.ok()).toBe(true);
  await page.goto(`/settings/operator?organisationId=${fixture.orgId}`);
  await expect(page.locator(".settings-header h1")).toHaveText(
    "Installation settings",
    { timeout: 15000 },
  );
  await expect(
    page.getByLabel("Installation quota (bytes)", { exact: true }),
  ).toBeVisible();
  original = await configuration();
  await expect(page.locator(".settings-content")).toContainText(
    "Operational metrics",
  );
  await expect(page.locator(".settings-content")).toContainText(
    "Installation usage",
  );
  await expect(
    page.locator(".settings-content [role=alert]").filter({ hasText: /\S/ }),
  ).toHaveCount(0);
  const precise = "9007199254740993";
  const target = {
    ...original.storage,
    installationQuotaBytes: precise,
    defaultOrganisationQuotaBytes: precise,
  };
  await saveCapacity(target);
  const saved = await configuration();
  expect(saved.storage.installationQuotaBytes).toBe(precise);
  expect(saved.storage.defaultOrganisationQuotaBytes).toBe(precise);
  report.checks.push({
    name: "Operator quota controls preserve exact decimal byte strings above Number.MAX_SAFE_INTEGER through approval and PostgreSQL readback",
    status: "passed",
    quotaBytes: precise,
  });
  await saveCapacity(original.storage);
  expect((await configuration()).storage).toEqual(original.storage);
  report.checks.push({
    name: "Original capacity policy restored through the same approved UI",
    status: "passed",
  });
  await page
    .getByRole("button", { name: "Save deletion retention", exact: true })
    .click();
  await approve();
  expect((await configuration()).deletionRetention).toEqual(
    original.deletionRetention,
  );
  report.checks.push({
    name: "Deletion retention UI preserves the installation's existing indefinite policy through real approval",
    status: "passed",
  });
  await page
    .getByRole("button", { name: "Refresh health", exact: true })
    .click();
  await expect(page.locator(".settings-content")).toContainText(
    "PostgreSQL and background work",
  );
  await page.screenshot({
    path: new URL("chromium-operator-metrics-capacity.png", output).pathname,
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
  if (original) {
    try {
      if (
        JSON.stringify((await configuration()).storage) !==
        JSON.stringify(original.storage)
      )
        await saveCapacity(original.storage);
    } catch {
      report.restoration =
        "failed: restore the original capacity policy from this private test fixture before continuing";
      report.status = "failed";
    }
  }
  await writeFile(
    new URL("chromium-operator-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
