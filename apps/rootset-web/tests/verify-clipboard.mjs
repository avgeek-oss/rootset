import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { reportError } from "./report-error.mjs";

const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const engine = process.env.ROOTSET_TEST_BROWSER ?? "chromium";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const candidateCommit = process.env.ROOTSET_CANDIDATE_COMMIT ?? null;
const output = new URL("../test-results/browser/", import.meta.url);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
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
await page.addInitScript(() => {
  window.__rootsetGridTiming = [];
  document.addEventListener(
    "paste",
    (event) => {
      window.__rootsetNativePaste = event.clipboardData?.getData("text/plain");
    },
    true,
  );
  new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      if (entry.name !== "rootset:grid:usable") continue;
      const grid = document.querySelector('[role="grid"]');
      const cells = Array.from(
        grid?.querySelectorAll('[role="gridcell"]') ?? [],
      );
      window.__rootsetGridTiming.push({
        time: entry.startTime,
        detail: entry.detail,
        visible: !!grid?.getClientRects().length,
        cells: cells.length,
        unloaded: cells.filter(
          (cell) => cell.getAttribute("data-cell-loaded") !== "true",
        ).length,
      });
    }
  }).observe({ type: "mark", buffered: true });
});
const report = {
  browser: engine,
  candidateCommit,
  classification: candidateCommit
    ? "exact candidate browser verification"
    : "working-tree development verification; no acceptance promotion",
  clipboard:
    "Real navigator.clipboard ClipboardItem deferred Blob promise; native keyboard paste supplies the actual system clipboard content",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (e) => report.pageErrors.push(reportError(e)));
async function call(method, path, data) {
  const headers = {
    Origin: new URL(baseURL).origin,
    "Idempotency-Key": randomUUID(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await context.request.fetch(
      new URL(`/api/internal/v1${path}`, apiURL).href,
      {
        method,
        ...(data ? { data } : {}),
        headers,
      },
    );
    const body = response.status() === 204 ? undefined : await response.json();
    if (response.ok()) return body;
    if (response.status() === 429 && attempt < 2) {
      const seconds = Number(response.headers()["retry-after"] ?? 60);
      if (Number.isInteger(seconds) && seconds > 0 && seconds <= 60) {
        (report.admissionWaits ??= []).push({ method, seconds });
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        continue;
      }
    }
    throw new Error(
      `${method} ${path}: HTTP ${response.status()} ${body.error?.code}`,
    );
  }
}
let grid;
async function select(row, columns, rowCount = 1) {
  await grid.focus();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < row; i++) await page.keyboard.press("ArrowDown");
  for (let i = 1; i < rowCount; i++)
    await page.keyboard.press("Shift+ArrowDown");
  for (let i = 1; i < columns; i++)
    await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(1100);
  await expect(grid).toHaveAttribute("aria-busy", "false");
}
async function copy() {
  await page.keyboard.press("Control+c");
  await expect(
    page.getByText("Selection copied.", { exact: true }),
  ).toBeAttached();
  return readClipboard();
}
async function readClipboard() {
  await grid.focus();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+v" : "Control+v",
  );
  const dialog = page.getByRole("dialog", {
    name: "Review paste",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const text = await page.evaluate(() => window.__rootsetNativePaste);
  expect(typeof text).toBe("string");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  return text;
}
async function paste(text, row) {
  await select(row, 1);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+v" : "Control+v",
  );
  const dialog = page.getByRole("dialog", {
    name: "Review paste",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.__rootsetNativePaste)).toBe(text);
  await expect(dialog).toContainText("quoted empty cell preserves empty text");
  await dialog
    .getByRole("button", { name: "Commit paste", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
try {
  const login = await context.request.post(
    new URL("/v1/auth/sign-in/email", apiURL).href,
    {
      data: {
        email: credentials.ROOTSET_TEST_OWNER_EMAIL,
        password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
      },
      headers: { Origin: new URL(baseURL).origin },
    },
  );
  expect(login.ok()).toBe(true);
  const chosen = await context.request.get(
    new URL("/api/internal/v1/context", apiURL).href,
  );
  expect(chosen.ok()).toBe(true);
  const root = `/orgs/${fixture.orgId}/databases/${fixture.databaseId}`;
  const definitions = Array.from({ length: 24 }, (_, i) => ({
    name: `COL_${String.fromCharCode(65 + i)}`,
    type:
      i === 5
        ? "integer"
        : i === 6
          ? "float"
          : i === 7
            ? "boolean"
            : i === 8
              ? "date"
              : i === 9
                ? "time"
                : i === 10
                  ? "date-time"
                  : i >= 11 && i <= 17
                    ? "json"
                    : "text",
    ...(i < 5 || i > 17 ? { charLimit: 256 } : {}),
  }));
  const created = await call("POST", `${root}/tables`, {
    name: `Clipboard verified ${randomUUID().slice(0, 8)}`,
    fields: definitions,
  });
  const path = `${root}/tables/${created.table.id}`;
  const firstValues = Object.fromEntries(
    definitions.map((f, i) => [
      f.name,
      i === 0
        ? ""
        : i === 1
          ? null
          : i === 2
            ? 'a "quote"'
            : i === 3
              ? "line\nnext"
              : i === 4
                ? "a\tb"
                : i === 5
                  ? -42
                  : i === 6
                    ? 1.25
                    : i === 7
                      ? false
                      : i === 8
                        ? "2026-10-02"
                        : i === 9
                          ? "12:34:56Z"
                          : i === 10
                            ? "2026-10-02T12:34:56Z"
                            : i === 11
                              ? "abc"
                              : i === 12
                                ? { nested: 'a\t\n"', array: [null, 0, false] }
                                : i === 13
                                  ? ["✈️", null]
                                  : i === 14
                                    ? 42.5
                                    : i === 15
                                      ? false
                                      : i === 16
                                        ? ""
                                        : i === 17
                                          ? null
                                          : `actual-${i}`,
    ]),
  );
  const secondValues = {
    ...firstValues,
    COL_A: null,
    COL_B: "",
    COL_F: 0,
    COL_G: 0,
    COL_H: true,
    COL_I: "1900-01-01",
    COL_J: "00:00:00Z",
    COL_K: "1900-01-01T00:00:00Z",
    COL_L: "null",
    COL_M: { empty: "", null: null },
    COL_S: "✈️ — Unicode",
  };
  const targetValues = Object.fromEntries(
    definitions.map((f, i) => [
      f.name,
      f.type === "integer" || f.type === "float"
        ? 123
        : f.type === "boolean"
          ? null
          : f.type === "date"
            ? "2001-01-01"
            : f.type === "time"
              ? "01:00:00Z"
              : f.type === "date-time"
                ? "2001-01-01T01:00:00Z"
                : f.type === "json"
                  ? { target: i }
                  : `target-${i}`,
    ]),
  );
  const sourceRows = [],
    targetRows = [];
  for (const values of [firstValues, secondValues])
    sourceRows.push(
      (
        await call("POST", `${path}/rows`, {
          expectedSchemaVersion: created.table.schemaVersion,
          values,
        })
      ).row,
    );
  for (let i = 0; i < 2; i++)
    targetRows.push(
      (
        await call("POST", `${path}/rows`, {
          expectedSchemaVersion: created.table.schemaVersion,
          values: targetValues,
        })
      ).row,
    );
  await page.goto(
    `${baseURL}/settings/table?organisationId=${fixture.orgId}&databaseId=${fixture.databaseId}&tableId=${created.table.id}`,
  );
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  await page.waitForTimeout(1200);
  const timing = await page.evaluate(() => ({
    observed: window.__rootsetGridTiming,
    marks: performance
      .getEntriesByName("rootset:grid:usable")
      .map((mark) => ({ time: mark.startTime, detail: mark.detail })),
    measurements: performance
      .getEntriesByName("rootset:grid:navigation-viewport")
      .map((measure) => ({
        start: measure.startTime,
        duration: measure.duration,
      })),
  }));
  expect(timing.marks).toHaveLength(1);
  expect(timing.measurements).toHaveLength(1);
  expect(timing.measurements[0].start).toBe(0);
  expect(timing.measurements[0].duration).toBe(timing.marks[0].time);
  expect(timing.observed.at(-1)).toMatchObject({
    visible: true,
    unloaded: 0,
    detail: { tableId: created.table.id },
  });
  expect(timing.observed.at(-1).cells).toBeGreaterThan(0);
  report.checks.push({
    name: "Bounded first-usable User Timing mark follows an actually populated visible DOM paint opportunity; navigation measure starts at zero",
    status: "passed",
    timing,
  });
  const reads = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname ===
        `/api/internal/v1/tables/${created.table.id}/windows/query` &&
      r.postDataJSON().query?.select?.length === 21
    )
      reads.push(new URL(r.url()).pathname);
  });
  await select(0, 21, 2);
  const cacheBefore = await grid.getAttribute("data-cache-bytes");
  const text = await copy();
  expect(reads).toHaveLength(1);
  expect(await grid.getAttribute("data-cache-bytes")).toBe(cacheBefore);
  expect(text).toContain('""\t\t');
  expect(text).toContain('"""abc"""');
  expect(text).toContain("actual-20");
  report.checks.push({
    name: "Real deferred ClipboardItem write after off-projection fetch in the user gesture",
    status: "passed",
    canonicalReads: reads.length,
    copiedRows: 2,
    copiedColumns: 21,
    viewportCacheUnchanged: true,
    clipboardBytes: Buffer.byteLength(text),
  });
  await paste(text, 2);
  const canonicalSources = await Promise.all(
    sourceRows.map((row) => call("GET", `${path}/rows/${row.id}`)),
  );
  const canonicalTargets = await Promise.all(
    targetRows.map((row) => call("GET", `${path}/rows/${row.id}`)),
  );
  const histories = [];
  for (let i = 0; i < 2; i++) {
    const expected = Object.fromEntries(
      created.fields
        .slice(0, 21)
        .map((field) => [field.name, canonicalSources[i].values[field.name]]),
    );
    expect(
      Object.fromEntries(
        created.fields
          .slice(0, 21)
          .map((field) => [field.name, canonicalTargets[i].values[field.name]]),
      ),
    ).toEqual(expected);
    expect(canonicalTargets[i].version).toBe("2");
    for (const field of created.fields.slice(0, 21)) {
      const history = await call(
        "GET",
        `${path}/rows/${targetRows[i].id}/cells/${field.id}/history?limit=50`,
      );
      const latest = history.data.at(-1);
      expect(
        history.data.filter((entry) => entry.operation === "update"),
      ).toHaveLength(1);
      expect(latest.before).toEqual(targetRows[i].values[field.name]);
      expect(latest.after).toEqual(canonicalSources[i].values[field.name]);
      histories.push({
        rowId: targetRows[i].id,
        fieldId: field.id,
        type: field.type,
        before: latest.before,
        after: latest.after,
        version: latest.version,
      });
    }
  }
  report.checks.push({
    name: "All eight types, null/empty text, JSON scalar/object/array/empty strings, Unicode and embedded quotes/tabs/newlines roundtrip to canonical stored values and exactly one cell update history",
    status: "passed",
    tableId: created.table.id,
    histories,
  });
  await select(0, 21);
  let beforeFailure = await readClipboard();
  const current = await call("GET", `${path}/rows/${sourceRows[0].id}`);
  await call("PATCH", `${path}/rows/${sourceRows[0].id}`, {
    expectedVersion: current.version,
    expectedSchemaVersion: created.table.schemaVersion,
    values: { COL_C: "changed after the displayed projection" },
  });
  await page.keyboard.press("Control+c");
  await expect(
    page.getByRole("alert").filter({ hasText: "A selected row changed" }),
  ).toBeVisible();
  expect(await readClipboard()).toBe(beforeFailure);
  report.checks.push({
    name: "Stale canonical row revision refuses copy and preserves the previous system clipboard",
    status: "passed",
  });
  await page.reload();
  await page.waitForTimeout(700);
  await select(0, 21);
  await context.setOffline(true);
  await page.keyboard.press("Control+c");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Rootset is temporarily unavailable" }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Rootset is temporarily unavailable" }),
  ).toBeHidden();
  expect(await readClipboard()).toBe(beforeFailure);
  report.checks.push({
    name: "Actual offline canonical read refuses copy without clearing prior clipboard",
    status: "passed",
  });
  // Hold a genuine upstream read until selection changes, then release it unchanged.
  await select(0, 21);
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route(
    `**/api/internal/v1/tables/${created.table.id}/windows/query`,
    async (route) => {
      if (route.request().postDataJSON().query?.select?.length !== 21)
        return route.continue();
      const response = await route.fetch();
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      try {
        await route.fulfill({ response });
      } catch {
        /* Expected client cancellation. */
      }
    },
  );
  await page.keyboard.press("Control+c");
  await waiting;
  await page.keyboard.press("ArrowLeft");
  release();
  await expect(
    page.getByText("Copy cancelled; your clipboard has not changed.", {
      exact: true,
    }),
  ).toBeAttached();
  await page.unroute(
    `**/api/internal/v1/tables/${created.table.id}/windows/query`,
  );
  expect(await readClipboard()).toBe(beforeFailure);
  report.checks.push({
    name: "Selection change cancels a pending real canonical HTTP read; old clipboard survives",
    status: "passed",
    delayedRead:
      "Response delivery held by browser harness, actual upstream row fetched unchanged",
  });
  await select(0, 21);
  if (engine === "chromium") {
    const cdp = await browser.newBrowserCDPSession();
    const { browserContextIds } = await cdp.send("Target.getBrowserContexts");
    await cdp.send("Browser.setPermission", {
      browserContextId: browserContextIds[0],
      origin: new URL(baseURL).origin,
      permission: { name: "clipboard-write" },
      setting: "denied",
    });
    expect(
      await page.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "clipboard-write" }))
            .state,
      ),
    ).toBe("denied");
    await page.keyboard.press("Control+c");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Clipboard access was denied" }),
    ).toBeVisible();
    expect(await readClipboard()).toBe(beforeFailure);
    report.checks.push({
      name: "Genuine Chromium clipboard permission denial while preparing canonical data preserves old clipboard and avoids unhandled rejection",
      status: "passed",
      provenance:
        "Browser permission overridden through CDP to denied; native navigator.clipboard implementation unchanged",
    });
    await cdp.send("Browser.resetPermissions", {
      browserContextId: browserContextIds[0],
    });
    await context.clearPermissions();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await cdp.detach();
    await select(0, 21);
    beforeFailure = await copy();
    report.checks.push({
      name: "Restored native clipboard permission permits an actual retry with current data",
      status: "passed",
    });
  } else {
    report.permissionDenialLimitation =
      "Automated WebKit shell permitted non-gesture writes; it does not substantiate a native Safari permission-denial negative. Successful gesture writes/native paste and other failure preservation are exercised.";
  }
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get: () => undefined,
    }),
  );
  await page.keyboard.press("Control+c");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Clipboard access is unavailable" }),
  ).toBeVisible();
  await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
  await page.waitForTimeout(300);
  expect(await readClipboard()).toBe(beforeFailure);
  report.checks.push({
    name: "Unavailable clipboard capability with pending preparation is explicit and has no orphan rejection or clipboard replacement",
    status: "passed",
    provenance:
      "Capability getter absence injected by isolated browser harness; underlying system clipboard restored unchanged",
  });
  await select(0, 21);
  const rowToDelete = await call("GET", `${path}/rows/${sourceRows[0].id}`);
  const deletion = await context.request.delete(
    new URL(`/api/internal/v1${path}/rows/${rowToDelete.id}`, apiURL).href,
    {
      headers: {
        Origin: new URL(baseURL).origin,
        "Idempotency-Key": randomUUID(),
        "If-Match": `"${rowToDelete.id}:${rowToDelete.version}"`,
      },
      data: { expectedSchemaVersion: created.table.schemaVersion },
    },
  );
  expect(deletion.status()).toBe(200);
  expect((await deletion.json()).deleted).toBe(true);
  const deletedRead = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/internal/v1/tables/${created.table.id}/windows/query` &&
      response.request().postDataJSON().query?.select?.length === 21,
  );
  await page.keyboard.press("Control+c");
  expect((await deletedRead).status()).toBe(200);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "A selected row changed or moved" }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(await readClipboard()).toBe(beforeFailure);
  report.checks.push({
    name: "Deleted selected row never becomes blank clipboard data",
    status: "passed",
  });
  await page.screenshot({
    path: new URL(`${engine}-clipboard.png`, output).pathname,
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = reportError(e);
  report.visibleErrors = await page.getByRole("alert").allTextContents();
  report.gridState = await grid?.evaluate((element) => ({
    busy: element.getAttribute("aria-busy"),
    active: element.getAttribute("aria-activedescendant"),
    columns: Array.from(element.querySelectorAll('[role="columnheader"]')).map(
      (column) => column.getAttribute("aria-colindex"),
    ),
  }));
  process.exitCode = 1;
} finally {
  await context.setOffline(false);
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL(`${engine}-clipboard-report.json`, output),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
