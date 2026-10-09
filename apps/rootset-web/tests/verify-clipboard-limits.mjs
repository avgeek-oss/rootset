import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { reportError } from "./report-error.mjs";
const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const engine = process.env.ROOTSET_TEST_BROWSER ?? "chromium";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const browser = await { chromium, webkit }[engine].launch();
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1000, height: 900 },
  ...(engine === "chromium"
    ? { permissions: ["clipboard-read", "clipboard-write"] }
    : {}),
});
const page = await context.newPage();
const report = {
  browser: engine,
  candidateCommit: process.env.ROOTSET_CANDIDATE_COMMIT ?? null,
  classification: process.env.ROOTSET_CANDIDATE_COMMIT
    ? "exact candidate verification"
    : "working-tree development verification; no acceptance promotion",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (e) => report.pageErrors.push(reportError(e)));
await page.addInitScript(() =>
  document.addEventListener(
    "paste",
    (event) => {
      window.__rootsetLimitPaste = event.clipboardData?.getData("text/plain");
    },
    true,
  ),
);
async function call(method, path, data) {
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
      `${method} ${path}: HTTP ${response.status()} ${body.error?.code}`,
    );
  return body;
}
try {
  expect(
    (
      await context.request.post(
        new URL("/v1/auth/sign-in/email", apiURL).href,
        {
          data: {
            email: credentials.ROOTSET_TEST_OWNER_EMAIL,
            password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
          },
          headers: { Origin: new URL(baseURL).origin },
        },
      )
    ).ok(),
  ).toBe(true);
  expect(
    (
      await context.request.get(
        new URL("/api/internal/v1/context", apiURL).href,
      )
    ).ok(),
  ).toBe(true);
  const root = `/orgs/${fixture.orgId}/databases/${fixture.databaseId}`;
  const fields = Array.from({ length: 200 }, (_, i) => ({
    name: `${String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26))}_${"K".repeat(61)}`,
    type: "text",
    charLimit: 190,
  }));
  const created = await call("POST", `${root}/tables`, {
    name: `Clipboard byte continuation ${randomUUID().slice(0, 8)}`,
    fields,
  });
  const path = `${root}/tables/${created.table.id}`;
  report.tableId = created.table.id;
  const rows = [];
  for (let start = 0; start < 200; start += 100) {
    const mutations = Array.from({ length: 100 }, (_, i) => ({
      type: "create",
      values: Object.fromEntries(
        fields.map((field, column) => [
          field.name,
          `row-${String(start + i).padStart(3, "0")}-col-${String(column).padStart(3, "0")}-`.padEnd(
            190,
            "X",
          ),
        ]),
      ),
    }));
    const result = await call("POST", `${path}/rows/batch`, {
      expectedSchemaVersion: created.table.schemaVersion,
      mutations,
    });
    rows.push(...result.results.map((entry) => entry.row));
  }
  const pages = [],
    rowGets = [];
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (
      response.request().method() === "GET" &&
      pathname.startsWith(`/api/internal/v1${path}/rows/`)
    )
      rowGets.push(pathname);
    if (response.request().method() !== "POST" || !pathname.endsWith("/query"))
      return;
    const query = response.request().postDataJSON()?.query;
    if (query?.select?.length === 200)
      pages.push({
        pathname,
        cursor: !!query.cursor,
        limit: query.limit,
        response,
      });
  });
  await page.goto(
    `${baseURL}/settings/table?organisationId=${fixture.orgId}&databaseId=${fixture.databaseId}&tableId=${created.table.id}`,
  );
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  await page.waitForTimeout(1000);
  await grid.focus();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 199; i++) await page.keyboard.press("Shift+ArrowDown");
  for (let i = 0; i < 199; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(1100);
  await expect(grid).toHaveAttribute("aria-busy", "false");
  const cacheBefore = await grid.getAttribute("data-cache-bytes");
  await page.keyboard.press("Control+c");
  await expect(
    page.getByText("Selection copied.", { exact: true }),
  ).toBeAttached({ timeout: 15_000 });
  expect(pages).toHaveLength(2);
  expect(rowGets).toHaveLength(0);
  const results = await Promise.all(
    pages.map(async ({ response, ...request }) => ({
      ...request,
      ...(await response.json()),
    })),
  );
  expect(results[0].page.stopReason).toBe("byte_limit");
  expect(results[1].cursor).toBe(true);
  expect(results.reduce((sum, result) => sum + result.data.length, 0)).toBe(
    200,
  );
  expect(await grid.getAttribute("data-cache-bytes")).toBe(cacheBefore);
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(700);
  await grid.focus();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+v" : "Control+v",
  );
  const dialog = page.getByRole("dialog", {
    name: "Review paste",
    exact: true,
  });
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Paste is too large. Use a smaller selection.", {
      exact: true,
    }),
  ).toBeVisible();
  const text = await page.evaluate(() => window.__rootsetLimitPaste);
  const expected = `${rows.map((row) => fields.map((field) => row.values[field.name]).join("\t")).join("\n")}\n`;
  expect(text).toBe(expected);
  expect(Buffer.byteLength(text)).toBeLessThan(8 * 1024 * 1024);
  report.checks.push({
    name: "200-row/200-column projected copy uses signed byte-limit continuation, decodes at most 200 rows, does zero canonical GETs and leaves viewport cache unchanged",
    status: "passed",
    tableId: created.table.id,
    pages: results.map((result) => ({
      path: result.pathname,
      cursor: result.cursor,
      requestedLimit: result.limit,
      returned: result.data.length,
      stopReason: result.page.stopReason,
    })),
    clipboardBytes: Buffer.byteLength(text),
    clipboardSha256: createHash("sha256").update(text).digest("hex"),
    viewportCacheUnchanged: true,
  });
  report.checks.push({
    name: "Oversized clipboard edit is rejected with a toast without creating an import job",
    status: "passed",
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = reportError(e);
  report.visibleErrors = await page.getByRole("alert").allTextContents();
  report.gridState = await page
    .getByRole("grid")
    .evaluate((element) => ({
      busy: element.getAttribute("aria-busy"),
      active: element.getAttribute("aria-activedescendant"),
      cacheBytes: element.dataset.cacheBytes,
      columns: Array.from(
        element.querySelectorAll('[role="columnheader"]'),
      ).map((column) => column.getAttribute("aria-colindex")),
    }))
    .catch(() => null);
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL(`${engine}-clipboard-limits-report.json`, output),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
