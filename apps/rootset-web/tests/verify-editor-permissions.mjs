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
const browser = await chromium.launch();
const owner = await browser.newContext({ baseURL });
const editor = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
const page = await editor.newPage();
const report = {
  browser: "chromium",
  source:
    "Real verified Editor membership and versioned Owner grants, rendered controls and actual database creation",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
let original, memberId;
const path = `/api/internal/v1/orgs/${fixture.orgId}`;
async function signIn(context, file) {
  const credentials = parseEnv(
    await readFile(new URL(file, import.meta.url), "utf8"),
  );
  const response = await context.request.post("/v1/auth/sign-in/email", {
    headers: { Origin: baseURL },
    data: {
      email: credentials.ROOTSET_TEST_OWNER_EMAIL,
      password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
    },
  });
  expect(response.ok()).toBe(true);
  const selected = await context.request.post("/v1/auth/organisation", {
    headers: { Origin: baseURL },
    data: { orgId: fixture.orgId },
  });
  expect(selected.ok()).toBe(true);
  return credentials.ROOTSET_TEST_OWNER_EMAIL;
}
async function get(context, url) {
  const response = await context.request.get(url);
  if (!response.ok()) throw new Error(`GET ${url} HTTP ${response.status()}`);
  return response.json();
}
async function grant(unrestricted, targets) {
  const grants = (await get(owner, `${path}/grants`)).data;
  const current = grants.find((value) => value.membershipId === memberId);
  const response = await owner.request.patch(`${path}/grants`, {
    headers: { Origin: baseURL, "Idempotency-Key": randomUUID() },
    data: {
      grants: [
        {
          membershipId: memberId,
          unrestricted,
          targets,
          version: current?.version ?? 1,
        },
      ],
    },
  });
  if (!response.ok()) {
    const body = await response.json();
    throw new Error(
      `Grant update HTTP ${response.status()}: ${body.error?.code}`,
    );
  }
  await page.goto(baseURL);
  await expect(page.locator(".rootset-shell")).toBeVisible();
}
try {
  await signIn(owner, "../.env.browser-test");
  const email = await signIn(editor, "../.env.permissions-browser-test");
  memberId = (await get(owner, `${path}/members`)).data.find(
    (member) => member.email === email,
  ).id;
  original = (await get(owner, `${path}/grants`)).data.find(
    (value) => value.membershipId === memberId,
  ) ?? { membershipId: memberId, unrestricted: true, targets: [] };
  await grant(true, []);
  const basic = await get(editor, "/api/internal/v1/context");
  expect(basic.principal.role).toBe("editor");
  expect(basic.scopes).not.toContain("databases:manage");
  await expect(
    page
      .locator(".main-sidebar")
      .getByRole("button", { name: "Create database", exact: true }),
  ).toHaveCount(0);
  report.checks.push({
    name: "Default Editor has no database-management scope and no global create control",
    status: "passed",
  });
  await grant(false, [{ databaseId: fixture.databaseId, level: "manage" }]);
  const scoped = await get(editor, "/api/internal/v1/context");
  expect(
    scoped.targets.some(
      (target) =>
        target.databaseId === fixture.databaseId && target.level === "manage",
    ),
  ).toBe(true);
  await expect(
    page
      .locator(".main-sidebar")
      .getByRole("button", { name: "Create database", exact: true }),
  ).toHaveCount(0);
  const denied = await editor.request.post(`${path}/databases`, {
    headers: { Origin: baseURL, "Idempotency-Key": randomUUID() },
    data: { name: `Denied Editor database ${randomUUID().slice(0, 8)}` },
  });
  expect([403, 404]).toContain(denied.status());
  report.checks.push({
    name: "Database-specific manage grant cannot expose or authorize organisation-wide creation",
    status: "passed",
    statusCode: denied.status(),
    hasDatabaseManageScope: scoped.scopes.includes("databases:manage"),
  });
  await grant(false, [{ level: "manage" }]);
  const wide = await get(editor, "/api/internal/v1/context");
  expect(wide.scopes).toContain("databases:manage");
  expect(
    wide.targets.some(
      (target) =>
        target.level === "manage" && !target.databaseId && !target.tableId,
    ),
  ).toBe(true);
  await page
    .locator(".main-sidebar")
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create database",
    exact: true,
  });
  const name = `Explicit Editor management ${randomUUID().slice(0, 8)}`;
  await dialog.getByRole("textbox", { name: "Database name" }).fill(name);
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      new URL(value.url()).pathname === `${path}/databases`,
  );
  await dialog
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  const created = await response;
  expect(created.status()).toBe(201);
  const database = await created.json();
  await expect(
    page.locator(".database-list").getByRole("button", { name, exact: true }),
  ).toBeVisible();
  const teamKeys = await editor.request.get(`${path}/keys`);
  expect(teamKeys.status()).toBe(403);
  report.checks.push({
    name: "Explicit organisation-wide manage grant plus scope renders creation and commits a real database, while team-key administration remains denied",
    status: "passed",
    databaseId: database.id,
    teamKeysStatus: teamKeys.status(),
  });
  await page.screenshot({
    path: new URL("chromium-editor-explicit-management.png", output).pathname,
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
  if (original && memberId) {
    try {
      await grant(original.unrestricted, original.targets);
      await expect(
        page
          .locator(".main-sidebar")
          .getByRole("button", { name: "Create database", exact: true }),
      ).toHaveCount(0);
      report.restoredOriginalGrant = true;
    } catch (error) {
      report.status = "failed";
      report.restoreError = reportError(error);
    }
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL("chromium-editor-permissions-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await owner.close();
  await editor.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
