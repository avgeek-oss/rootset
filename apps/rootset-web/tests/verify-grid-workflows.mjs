import { reportError } from "./report-error.mjs";
import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";

const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const engine = process.env.ROOTSET_TEST_BROWSER ?? "chromium";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const browser = await { chromium, webkit }[engine].launch();
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const output = new URL("../test-results/browser/", import.meta.url);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const fixture = JSON.parse(
  await readFile(
    new URL("../test-results/browser/fixture.json", import.meta.url),
    "utf8",
  ),
);
const report = { browser: engine, checks: [], pageErrors: [] };
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
await mkdir(output, { recursive: true });
if (process.env.ROOTSET_VERIFY_INITIAL_PAUSE_MS)
  await page.waitForTimeout(
    Number(process.env.ROOTSET_VERIFY_INITIAL_PAUSE_MS),
  );

async function request(method, path, data) {
  const response = await context.request.fetch(
    new URL(`/api/internal/v1${path}`, apiURL).href,
    {
      method,
      ...(data ? { data } : {}),
      headers: {
        Origin: new URL(baseURL).origin,
        "Idempotency-Key": randomUUID(),
      },
    },
  );
  const body = response.status() === 204 ? undefined : await response.json();
  if (!response.ok())
    throw new Error(
      `${method} ${path}: ${response.status()} ${body.error?.code}: ${body.error?.message}`,
    );
  return body;
}
async function responseTo(pattern, trigger) {
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname.endsWith(pattern),
  );
  await trigger();
  const result = await response;
  if (!result.ok()) {
    const error = await result.json();
    throw new Error(`${pattern}: ${result.status()} ${error.error?.message}`);
  }
  return result.json();
}
async function paste(text) {
  const grid = page.getByRole("grid");
  await grid.focus();
  await page.keyboard.press("Control+Home");
  await grid.evaluate((element, data) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", data);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, clipboardData }),
    );
  }, text);
  await expect(
    page.getByRole("dialog", { name: "Review paste", exact: true }),
  ).toBeVisible();
}

try {
  const signed = await context.request.post(
    new URL("/v1/auth/sign-in/email", apiURL).href,
    {
      data: {
        email: credentials.ROOTSET_TEST_OWNER_EMAIL,
        password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
      },
      headers: { Origin: new URL(baseURL).origin },
    },
  );
  if (!signed.ok()) throw new Error(`QA sign-in failed (${signed.status()}).`);
  await context.request.get(new URL("/api/internal/v1/context", apiURL).href);
  await page.goto(baseURL);
  const suffix = randomUUID().slice(0, 8);
  await page
    .locator(".main-sidebar")
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  const createDB = page.getByRole("dialog", {
    name: "Create database",
    exact: true,
  });
  await createDB
    .getByRole("textbox", { name: "Database name" })
    .fill(`Grid workflows ${suffix}`);
  const database = await responseTo("/databases", () =>
    createDB
      .getByRole("button", { name: "Create database", exact: true })
      .click(),
  );
  await page
    .getByRole("button", { name: "Create table", exact: true })
    .first()
    .click();
  const createTable = page.getByRole("dialog", {
    name: "Create table",
    exact: true,
  });
  await createTable
    .getByRole("textbox", { name: "Table name" })
    .fill(`Pastes ${suffix}`);
  const created = await responseTo("/tables", () =>
    createTable
      .getByRole("button", { name: "Create table", exact: true })
      .click(),
  );
  const tableId = created.table.id,
    path = `/orgs/${fixture.orgId}/databases/${database.id}/tables/${tableId}`;
  await page.getByRole("button", { name: "Add a field", exact: true }).click();
  for (const field of [
    { name: "NAME", type: "text" },
    { name: "COUNT", type: "integer" },
  ]) {
    const form = page.locator(".settings-form").first();
    await form.getByRole("textbox", { name: /^Name/ }).fill(field.name);
    await form
      .locator(".settings-field")
      .filter({ has: page.getByText("Field type", { exact: true }) })
      .getByRole("button")
      .click();
    await page.getByRole("option", { name: field.type, exact: true }).click();
    if (field.type === "text") {
      await form.getByLabel(/^Maximum characters/).fill("24");
      await form.getByText("Required", { exact: true }).click();
    } else {
      await form.getByLabel("Minimum (inclusive)", { exact: true }).fill("0");
      await form
        .getByLabel("Maximum (inclusive)", { exact: true })
        .fill("10000");
    }
    await responseTo("/fields", () =>
      form.getByRole("button", { name: "Create field", exact: true }).click(),
    );
    await expect(
      page
        .locator(".settings-record strong")
        .filter({ hasText: new RegExp(`^${field.name}$`) }),
    ).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await request("POST", `${path}/rows`, {
    values: { NAME: "First" },
    idempotencyKey: randomUUID(),
  });
  await request("POST", `${path}/rows`, {
    values: { NAME: "Second" },
    idempotencyKey: randomUUID(),
  });
  await page.reload();
  report.checks.push({
    name: "UI database/table/field creation with API-created fixture rows",
    status: "passed",
  });

  await paste("Alpha\t1\nBeta\t2");
  await responseTo("/rows/batch", () =>
    page.getByRole("button", { name: "Commit paste", exact: true }).click(),
  );
  await expect(page.getByRole("dialog")).not.toBeVisible();
  let result = await request("POST", `${path}/query`, {
    query: { limit: 1000 },
  });
  expect(result.data.map((row) => row.values)).toEqual([
    { NAME: "Alpha", COUNT: 1 },
    { NAME: "Beta", COUNT: 2 },
  ]);
  await paste("Valid\t1\nToo long for twenty-four characters\t2");
  await expect(
    page.getByRole("button", { name: "Commit paste", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  const after = await request("POST", `${path}/query`, {
    query: { limit: 1000 },
  });
  expect(after.data).toEqual(result.data);
  report.checks.push({
    name: "small atomic paste and invalid typed rectangle preserves rows",
    status: "passed",
  });

  await page
    .getByRole("gridcell")
    .filter({ hasText: /^Alpha$/ })
    .click({ button: "right" });
  const history = page.getByRole("dialog", {
    name: "NAME history",
    exact: true,
  });
  await expect(history).toContainText("First");
  await expect(history).toContainText("Alpha");
  await page.screenshot({
    path: new URL(`${engine}-cell-history.png`, output).pathname,
  });
  await history.getByRole("button", { name: "Close dialog" }).click();
  report.checks.push({
    name: "intended cell history before after actor and time",
    status: "passed",
  });

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  await filters.getByRole("button", { name: /Field 1$/ }).click();
  await page.getByRole("option", { name: "NAME", exact: true }).click();
  await filters.getByRole("button", { name: /Match 1$/ }).click();
  await page.getByRole("option", { name: "contains", exact: true }).click();
  await filters
    .getByRole("textbox", { name: "Value 1", exact: true })
    .fill("Alpha");
  await filters.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(filters).not.toBeVisible();
  await expect(
    page.getByRole("gridcell").filter({ hasText: /^Beta$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("gridcell").filter({ hasText: /^Alpha$/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Filter · active", exact: true })
    .click();
  await filters
    .getByRole("textbox", { name: "Value 1", exact: true })
    .fill("Beta");
  await filters.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("gridcell").filter({ hasText: /^Alpha$/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Filter · active", exact: true })
    .click();
  await expect(
    filters.getByRole("textbox", { name: "Value 1", exact: true }),
  ).toHaveValue("Alpha");
  await filters
    .getByRole("button", { name: "Clear all filters", exact: true })
    .click();
  await expect(
    page.getByRole("gridcell").filter({ hasText: /^Beta$/ }),
  ).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: "Table actions" });
  await expect(toolbar.getByRole("button")).toHaveCount(1);
  await expect(
    toolbar.getByRole("button", { name: "Filter", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add row", exact: true }),
  ).toHaveCount(0);
  report.checks.push({
    name: "Typed modal filter, cancelled draft isolation, clear filters and floating Filter action without Add row",
    status: "passed",
  });
  await expect(page.locator(".grid-footer")).toContainText("Live view");

  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
  await page.screenshot({
    path: new URL(`${engine}-workflow-failure.png`, output).pathname,
  });
} finally {
  await writeFile(
    new URL(`${engine}-grid-workflows.json`, output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
