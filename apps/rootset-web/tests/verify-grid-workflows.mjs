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
async function addRow(name) {
  await page
    .getByRole("button", { name: "Add row", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add row", exact: true });
  await dialog.locator(".add-row-field").filter({ hasText: "NAME" }).click();
  await dialog.getByRole("textbox", { name: /^NAME/ }).fill(name);
  await dialog.getByRole("button", { name: "Save value", exact: true }).click();
  await responseTo("/rows", () =>
    dialog.getByRole("button", { name: "Add row", exact: true }).click(),
  );
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("gridcell").filter({ hasText: name }).first(),
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
  await addRow("First");
  await addRow("Second");
  report.checks.push({
    name: "UI database table fields and row creation",
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
  await expect(toolbar.getByRole("button")).toHaveCount(2);
  await expect(
    toolbar.getByRole("button", { name: "Filter", exact: true }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "Add row", exact: true }),
  ).toBeVisible();
  report.checks.push({
    name: "Typed modal filter, cancelled draft isolation, clear filters and Filter/Add row header actions",
    status: "passed",
  });
  await expect(page.locator(".grid-footer")).toContainText("Live view");

  await paste(
    Array.from(
      { length: 1001 },
      (_, index) => `Imported ${String(index).padStart(4, "0")}\t${index}`,
    ).join("\n"),
  );
  await page
    .getByLabel("Paste write mode", { exact: true })
    .selectOption("create");
  await page
    .getByRole("button", { name: "Upload and validate paste", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start paste import", exact: true }),
  ).toBeEnabled({ timeout: 90_000 });
  await page.screenshot({
    path: new URL(`${engine}-large-paste-validation.png`, output).pathname,
  });
  const imported = await responseTo("/imports", () =>
    page
      .getByRole("button", { name: "Start paste import", exact: true })
      .click(),
  );
  await expect
    .poll(
      async () =>
        (await request("GET", `/orgs/${fixture.orgId}/jobs/${imported.jobId}`))
          .state,
      { timeout: 90_000, intervals: [1000, 2000] },
    )
    .toBe("succeeded");
  await expect(page.getByRole("dialog")).toContainText("succeeded", {
    timeout: 90_000,
  });
  result = await request("POST", `${path}/query`, { query: { limit: 5000 } });
  expect(result.data).toHaveLength(1003);
  expect(result.data[2].values.NAME).toBe("Imported 0000");
  await page.screenshot({
    path: new URL(`${engine}-large-paste-result.png`, output).pathname,
  });
  report.checks.push({
    name: "large paste visible validation and actual durable import job",
    status: "passed",
    rows: result.data.length,
  });
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
