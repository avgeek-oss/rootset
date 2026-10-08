import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";

const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";
const output = new URL("../test-results/browser/", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
);
const browser = await chromium.launch();
const admin = await browser.newContext({ baseURL });
const member = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
const page = await member.newPage();
const adminPage = await admin.newPage();
const report = {
  browser: "chromium",
  source:
    "Actual admin and member roles, automatic installation context, schema guards and personal settings",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
adminPage.on("pageerror", (error) =>
  report.pageErrors.push(reportError(error)),
);
async function signIn(context, file, role) {
  const credentials = parseEnv(
    await readFile(new URL(file, import.meta.url), "utf8"),
  );
  const response = await context.request.post(
    new URL("/v1/auth/sign-in/email", apiURL).href,
    {
      headers: { Origin: baseURL },
      data: {
        email: credentials.ROOTSET_TEST_OWNER_EMAIL,
        password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
      },
    },
  );
  expect(response.ok()).toBe(true);
  const current = await context.request.get(
    new URL("/api/internal/v1/context", apiURL).href,
  );
  expect(current.ok()).toBe(true);
  const value = await current.json();
  expect(value.organisation.id).toBe(fixture.orgId);
  expect(value.principal.role).toBe(role);
  return value;
}
const target = `organisationId=${fixture.orgId}&databaseId=${fixture.databaseId}&tableId=${fixture.tableId}`;
try {
  const memberContext = await signIn(
    member,
    "../.env.permissions-browser-test",
    "member",
  );
  expect(memberContext.scopes).toContain("rows:write");
  expect(memberContext.scopes).not.toContain("databases:manage");
  expect(memberContext.scopes).not.toContain("tables:manage");
  await page.goto(baseURL);
  await expect(page.locator(".rootset-application")).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Primary navigation", exact: true })
      .getByRole("button", { name: "Create database", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "UI verification", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create table", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: fixture.tableName, exact: true })
    .click();
  await expect(
    page.getByRole("grid", { name: `${fixture.tableName} spreadsheet` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add row", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Table settings", exact: true }),
  ).toHaveCount(0);
  report.checks.push({
    name: "Member can edit rows but has no database, table or schema management controls",
    status: "passed",
  });
  const protectedRequests = [];
  page.on("request", (request) => {
    if (
      /\/installation\/|\/members$|\/schema$/.test(
        new URL(request.url()).pathname,
      )
    )
      protectedRequests.push(new URL(request.url()).pathname);
  });
  for (const section of ["fields", "members", "operator"]) {
    await page.goto(`/settings/${section}?${target}`);
    await expect(page.locator("#table-content")).toContainText(
      "Admin access is required",
    );
    await expect(page.locator("#table-content form")).toHaveCount(0);
  }
  expect(protectedRequests).toEqual([]);
  await page.goto("/settings/api-keys");
  await page
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Name*", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Permissions", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.goto(`/settings/imports?${target}`);
  await expect(
    page.getByRole("link", { name: "Import rows", exact: true }),
  ).toBeVisible();
  report.checks.push({
    name: "Direct admin links do not fetch or mount protected forms; members retain imports and personal keys",
    status: "passed",
  });
  const adminContext = await signIn(admin, "../.env.browser-test", "admin");
  expect(adminContext.scopes).toContain("installation:manage");
  await adminPage.goto(baseURL);
  await expect(
    adminPage
      .getByRole("navigation", { name: "Primary navigation", exact: true })
      .getByRole("button", { name: "Create database", exact: true }),
  ).toBeVisible();
  await adminPage.goto(`/settings/operator?${target}`);
  await expect(
    adminPage
      .getByRole("heading", { name: "Installation health", exact: true })
      .last(),
  ).toBeVisible();
  await expect(
    adminPage.getByRole("link", { name: /Resource access|Organisation audit/ }),
  ).toHaveCount(0);
  report.checks.push({
    name: "Admin alone manages installation and schema without a second authority flag",
    status: "passed",
  });
  await page.screenshot({
    path: new URL("chromium-member-personal-settings.png", output).pathname,
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
  report.visibleErrors = await page.getByRole("alert").allTextContents();
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL("chromium-member-permissions-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await admin.close();
  await member.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
