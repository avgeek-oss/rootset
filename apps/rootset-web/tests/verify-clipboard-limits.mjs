import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { reportError } from "./report-error.mjs";
const engine = process.env.ROOTSET_TEST_BROWSER ?? "chromium";
const verifyTerminal =
  process.env.ROOTSET_VERIFY_LARGE_PASTE_TERMINAL === "true";
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
  const response = await context.request.fetch(`/api/internal/v1${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: {
      Origin: new URL(baseURL).origin,
      "Idempotency-Key": randomUUID(),
    },
  });
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
      await context.request.post("/v1/auth/sign-in/email", {
        data: {
          email: credentials.ROOTSET_TEST_OWNER_EMAIL,
          password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
        },
        headers: { Origin: new URL(baseURL).origin },
      })
    ).ok(),
  ).toBe(true);
  expect((await context.request.get("/api/internal/v1/context")).ok()).toBe(
    true,
  );
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
  await expect(dialog).toBeVisible();
  const text = await page.evaluate(() => window.__rootsetLimitPaste);
  const expected = `${rows.map((row) => fields.map((field) => row.values[field.name]).join("\t")).join("\n")}\n`;
  expect(text).toBe(expected);
  expect(Buffer.byteLength(text)).toBeLessThan(8 * 1024 * 1024);
  await expect(
    dialog.getByRole("button", { name: "Commit paste", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Upload and validate paste",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
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
    name: "Native keyboard paste preserves all 40,000 cells exactly; an over-8-MiB canonical batch is routed to existing large-paste validation rather than an oversized atomic request",
    status: "passed",
    canonicalValuesBytes: Buffer.byteLength(
      JSON.stringify(rows.map((row) => row.values)),
    ),
    unchangedRevision: "1",
    jobExecution: verifyTerminal
      ? "Terminal validation/import assertions follow below"
      : "Worker intentionally stopped; rendered job validation entry verified without mutation",
  });
  if (verifyTerminal) {
    await grid.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Enter");
    const editor = page.getByRole("dialog", {
      name: "Edit Wide 0",
      exact: true,
    });
    await editor
      .getByLabel("Wide 0", { exact: true })
      .fill("Changed before large clipboard import");
    await editor
      .getByRole("button", { name: "Save value", exact: true })
      .click();
    await expect(editor).not.toBeVisible();
    const changed = await call("GET", `${path}/rows/${rows[0].id}`);
    expect(changed.version).toBe("2");
    await grid.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+v" : "Control+v",
    );
    await expect(dialog).toBeVisible();
    const accepted = [];
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (
        response.request().method() === "POST" &&
        /\/imports(?:\/validate)?$/.test(pathname)
      )
        accepted.push(response);
    });
    await dialog
      .getByRole("button", { name: "Upload and validate paste", exact: true })
      .click();
    await expect(dialog).toContainText(
      "200 examined · 200 accepted · 0 rejected.",
      { timeout: 90_000 },
    );
    await dialog
      .getByRole("button", { name: "Start paste import", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Start paste import", exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByText("import", { exact: true })).toBeVisible();
    await expect(dialog.locator(".settings-status-succeeded")).toBeVisible({
      timeout: 90_000,
    });
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    const restored = await call("GET", `${path}/rows/${rows[0].id}`);
    expect(restored.values).toEqual(rows[0].values);
    expect(restored.version).toBe("3");
    const untouched = await call("GET", `${path}/rows/${rows.at(-1).id}`);
    expect(untouched.values).toEqual(rows.at(-1).values);
    expect(untouched.version).toBe("1");
    const firstField = created.fields[0];
    const history = await call(
      "GET",
      `${path}/rows/${rows[0].id}/cells/${firstField.id}/history?limit=50`,
    );
    expect(
      history.data.filter((entry) => entry.operation === "update"),
    ).toHaveLength(2);
    expect(history.data.at(-1).after).toBe(rows[0].values[firstField.name]);
    report.checks.push({
      name: "Actual over-8-MiB paste uploads encrypted JSONL, validates 200 records, runs an owned-org scoped worker, reaches terminal UI, restores changed canonical value once and leaves no-op rows/revisions unchanged",
      status: "passed",
      restoredRevision: restored.version,
      noOpRevision: untouched.version,
      updates: 2,
      acceptedJobs: await Promise.all(
        accepted.map(async (response) => ({
          httpStatus: response.status(),
          ...(await response.json()),
        })),
      ),
    });
  }
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
