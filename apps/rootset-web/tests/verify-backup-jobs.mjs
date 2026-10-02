import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const browser = await chromium.launch(),
  context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
const path = `/orgs/${fixture.orgId}/databases/${fixture.databaseId}`;
const report = {
  browser: "chromium",
  source:
    "Actual rendered database backups and durable recovery-point deletion through worker and encrypted object storage",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
async function get(path) {
  const response = await context.request.get(`/api/internal/v1${path}`);
  if (!response.ok()) throw new Error(`GET${path} HTTP${response.status()}`);
  return response.json();
}
async function terminal(id) {
  let value;
  await expect
    .poll(
      async () => {
        value = await get(`/orgs/${fixture.orgId}/jobs/${id}`);
        if (
          ["failed", "cancelled", "partially_completed"].includes(value.state)
        )
          throw new Error(
            `Backup job${value.state}: ${value.error?.code ?? ""}`,
          );
        return value.state;
      },
      { timeout: 180_000, intervals: [2000, 5000] },
    )
    .toBe("succeeded");
  return value;
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
  await page.goto(
    `/settings/backups?organisationId=${fixture.orgId}&databaseId=${fixture.databaseId}`,
  );
  await expect(page.locator(".settings-header h1")).toHaveText(
    "Database backups",
  );
  let backups = (await get(`${path}/backups`)).data;
  while (backups.filter((backup) => backup.state === "succeeded").length < 2) {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith(`${path}/backups`),
    );
    await page
      .getByRole("button", { name: "Back up now", exact: true })
      .click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    const job = await terminal((await accepted.json()).jobId);
    backups = (await get(`${path}/backups`)).data;
    report.checks.push({
      name: "Rendered backup queues202 and reaches verified worker success",
      status: "passed",
      jobId: job.id,
    });
    await expect(
      page.locator(".settings-record:has(.settings-status-succeeded)"),
    ).toHaveCount(
      backups.filter((backup) => backup.state === "succeeded").length,
      { timeout: 10000 },
    );
  }
  const verified = backups.filter((backup) => backup.state === "succeeded"),
    target = verified.at(-1);
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname.endsWith(`${path}/backups/${target.id}`),
  );
  await page
    .locator(".settings-record:has(.settings-status-succeeded)")
    .last()
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete recovery point?", exact: true })
    .getByRole("button", { name: "Delete backup", exact: true })
    .click();
  const accepted = await response;
  expect(accepted.status()).toBe(202);
  const queued = await accepted.json();
  await expect(page.locator(".settings-content")).toContainText(
    "Backup deletion queued. Removal is confirmed only when the job succeeds.",
  );
  const job = await terminal(queued.jobId);
  expect(job.operationId).toBe("deleteBackup");
  const remaining = (await get(`${path}/backups`)).data;
  expect(remaining.some((backup) => backup.id === target.id)).toBe(false);
  expect(
    remaining.filter((backup) => backup.state === "succeeded").length,
  ).toBeGreaterThanOrEqual(1);
  await expect(
    page.locator(".settings-record:has(.settings-status-succeeded)"),
  ).toHaveCount(
    remaining.filter((backup) => backup.state === "succeeded").length,
    { timeout: 10000 },
  );
  report.checks.push({
    name: "Rendered deletion retains queued wording and follows its durable job before confirmed removal; a verified recovery point remains",
    status: "passed",
    deletedBackupId: target.id,
    jobId: job.id,
  });
  await page
    .locator(".settings-record:has(.settings-status-succeeded)")
    .first()
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  const restoreName = `Browser recovery verification ${randomUUID().slice(0, 8)}`;
  await page
    .getByRole("textbox", { name: "New database name" })
    .fill(restoreName);
  const previewResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/restore-preview"),
  );
  await page
    .getByRole("button", { name: "Preview restore", exact: true })
    .click();
  expect((await previewResponse).ok()).toBe(true);
  const restoreResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/restores"),
  );
  await page
    .getByRole("button", { name: "Start restore", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start restore?", exact: true })
    .getByRole("button", { name: "Start restore", exact: true })
    .click();
  const acceptedRestore = await restoreResponse;
  expect(acceptedRestore.status()).toBe(202);
  const restored = await terminal((await acceptedRestore.json()).jobId);
  expect(restored.operationId).toBe("restoreBackup");
  await expect(
    page
      .locator(".database-list")
      .getByRole("button", { name: restoreName, exact: true }),
  ).toBeVisible({ timeout: 15000 });
  report.checks.push({
    name: "Rendered new-database restore previews the verified point, queues202 and follows worker success before publishing the recovered database",
    status: "passed",
    jobId: restored.id,
  });
  await page.screenshot({
    path: new URL("chromium-backup-deletion-job.png", output).pathname,
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
  await writeFile(
    new URL("chromium-backup-jobs-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
