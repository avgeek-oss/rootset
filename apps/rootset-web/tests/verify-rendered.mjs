import { reportError } from "./report-error.mjs";
import { chromium, webkit, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

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
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const engine = process.env.ROOTSET_TEST_BROWSER ?? "chromium";
const browser = await { chromium, webkit }[engine].launch();
const report = {
  browser: engine,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  requests: [],
};
await mkdir(output, { recursive: true });

async function login(context) {
  const response = await context.request.post(
    `${baseURL}/v1/auth/sign-in/email`,
    {
      data: {
        email: credentials.ROOTSET_TEST_OWNER_EMAIL,
        password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
      },
      headers: { Origin: new URL(baseURL).origin },
    },
  );
  if (!response.ok())
    throw new Error(`Verification sign-in failed (${response.status()}).`);
}
async function call(context, method, path, data) {
  const response = await context.request.fetch(
    `${baseURL}/api/internal/v1${path}`,
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
      `${method} ${path}: ${response.status()} ${body.error?.code ?? ""}: ${body.error?.message ?? ""}`,
    );
  return body;
}
function watch(page) {
  page.on("pageerror", (error) =>
    report.errors.push({ type: "page", message: reportError(error) }),
  );
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      new URL(response.url()).pathname.startsWith("/api/internal")
    )
      report.requests.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
}
async function selectOrg(page, name) {
  await page.goto(baseURL);
  const choose = page.getByRole("heading", {
    name: "Choose an organisation",
    exact: true,
  });
  await expect(
    choose.or(page.getByRole("button", { name: /^Switch organisation from / })),
  ).toBeVisible();
  if (!(await choose.isVisible())) {
    await page
      .getByRole("button", { name: /^Switch organisation from / })
      .click();
  }
  await page
    .getByRole("button", { name: new RegExp(`${name}\\s*owner$`) })
    .click();
  await expect(page.locator(".rootset-shell")).toBeVisible();
  await expect(page.locator(".org-switch")).toHaveAttribute(
    "aria-label",
    `Switch organisation from ${name}`,
  );
}
async function table(page, databaseName, tableName) {
  if (
    !(await page
      .getByRole("complementary", { name: "Databases", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "Open databases", exact: true })
      .click();
  await page
    .getByRole("complementary", { name: "Databases", exact: true })
    .getByRole("button", { name: databaseName, exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Tables", exact: true })
    .getByRole("button", { name: tableName, exact: true })
    .click();
  const grid = page.getByRole("grid", {
    name: `${tableName} spreadsheet`,
    exact: true,
  });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("gridcell").first()).not.toHaveText("Loading…");
  return grid;
}
async function run(name, action) {
  const start = performance.now();
  try {
    const details = await action();
    report.checks.push({
      name,
      status: "passed",
      elapsedMs: performance.now() - start,
      ...details,
    });
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      elapsedMs: performance.now() - start,
      error: reportError(error),
    });
    console.error(`${engine}: ${name}: ${reportError(error)}`);
  }
}
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
watch(page);

try {
  await login(context);
  await selectOrg(page, "Rootset UI verification");
  const database = await call(
    context,
    "GET",
    `/orgs/${fixture.orgId}/databases/${fixture.databaseId}`,
  );
  let grid = await table(page, database.name, fixture.tableName);

  await run("desktop-light-layout-keyboard-and-accessibility", async () => {
    await page.screenshot({
      path: new URL(`${engine}-grid-light.png`, output).pathname,
    });
    await grid.focus();
    await page.keyboard.press("ArrowDown");
    await expect(grid).toHaveAttribute("aria-activedescendant", /cell-/);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).not.toBeVisible();
    await expect(grid).toBeFocused();
    const a11y = await new AxeBuilder({ page }).analyze();
    await writeFile(
      new URL(`${engine}-grid-aria.yml`, output),
      await grid.ariaSnapshot(),
    );
    await writeFile(
      new URL(`${engine}-grid-axe.json`, output),
      JSON.stringify(a11y, null, 2),
    );
    expect(
      a11y.violations,
      a11y.violations.map((v) => `${v.id}: ${v.nodes.length}`).join(", "),
    ).toEqual([]);
    return {
      gridRows: await grid.getByRole("row").count(),
      gridCells: await grid.getByRole("gridcell").count(),
      axeViolations: 0,
    };
  });

  await run("dark-and-high-zoom-layout", async () => {
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({
      path: new URL(`${engine}-grid-dark.png`, output).pathname,
    });
    const a11y = await new AxeBuilder({ page }).analyze();
    await writeFile(
      new URL(`${engine}-dark-axe.json`, output),
      JSON.stringify(a11y, null, 2),
    );
    expect(
      a11y.violations,
      a11y.violations.map((v) => `${v.id}: ${v.nodes.length}`).join(", "),
    ).toEqual([]);
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expect(
      page.getByRole("button", { name: "Last row window" }),
    ).toBeVisible();
    await page.screenshot({
      path: new URL(`${engine}-grid-zoom200.png`, output).pathname,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
      document.documentElement.dataset.theme = "light";
    });
    return { axeViolations: 0, zoom: "200%" };
  });

  await run("all-settings-sections-real-server", async () => {
    await page
      .locator(".main-sidebar")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(
      page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "People and invitations", exact: true }),
    ).toBeVisible();
    const sections = await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button")
      .allTextContents();
    const result = [];
    for (const label of sections) {
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: label, exact: true })
        .click();
      await expect(page.locator(".settings-header h1")).toHaveText(label);
      await page.waitForTimeout(
        Number(process.env.ROOTSET_SETTINGS_PAUSE_MS ?? 1500),
      );
      await expect(
        page
          .locator(".settings-content [role=status]")
          .filter({ hasText: /Loading/ }),
      ).toHaveCount(0, { timeout: 10_000 });
      const errors = await page
        .locator(".settings-content [role=alert]")
        .filter({ hasText: /\S/ })
        .allTextContents();
      const a11y = await new AxeBuilder({ page }).analyze();
      result.push({
        section: label,
        errors,
        accessibility: a11y.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          targets: v.nodes.map((n) => n.target),
        })),
      });
      if (
        [
          "Your profile",
          "People and invitations",
          "API keys",
          "Fields",
          "Database backups",
        ].includes(label)
      )
        await page.screenshot({
          path: new URL(
            `${engine}-settings-${label.replaceAll(" ", "-").toLowerCase()}.png`,
            output,
          ).pathname,
        });
    }
    await writeFile(
      new URL(`${engine}-settings.json`, output),
      JSON.stringify(result, null, 2),
    );
    const errors = result.flatMap((item) =>
      item.errors.map((error) => `${item.section}: ${error}`),
    );
    expect(errors, errors.join("\n")).toEqual([]);
    const accessibility = result.flatMap((item) =>
      item.accessibility.map((error) => `${item.section}: ${error.id}`),
    );
    expect(accessibility, accessibility.join("\n")).toEqual([]);
    await page.getByRole("button", { name: "Close settings" }).click();
    return { sections: result.length, endpointErrors: 0, axeViolations: 0 };
  });

  await run("mobile-touch-all-navigation-and-cell-editing", async () => {
    const mobile = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    const surface = await mobile.newPage();
    watch(surface);
    try {
      await login(mobile);
      await selectOrg(surface, "Rootset UI verification");
      const viewport = await table(surface, database.name, fixture.tableName);
      expect(
        await surface.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await surface.screenshot({
        path: new URL(`${engine}-grid-mobile390.png`, output).pathname,
      });
      await viewport.getByRole("gridcell").first().tap();
      await expect(surface.getByRole("dialog")).toBeVisible();
      await surface.getByRole("button", { name: "Cancel", exact: true }).tap();
      await expect(surface.getByRole("dialog")).not.toBeVisible();
      await surface.getByRole("button", { name: "Last row window" }).tap();
      await expect(viewport).toBeVisible();
      const a11y = await new AxeBuilder({ page: surface }).analyze();
      await writeFile(
        new URL(`${engine}-mobile-axe.json`, output),
        JSON.stringify(a11y, null, 2),
      );
      expect(
        a11y.violations,
        a11y.violations.map((v) => `${v.id}: ${v.nodes.length}`).join(", "),
      ).toEqual([]);
      return {
        viewport: "390x844",
        touch: true,
        bodyHorizontalOverflow: false,
        axeViolations: 0,
      };
    } finally {
      await mobile.close();
    }
  });

  await run("five-million-first-middle-last-and-wide200", async () => {
    await page
      .getByRole("button", { name: "Close settings" })
      .isVisible()
      .then(async (visible) => {
        if (visible)
          await page.getByRole("button", { name: "Close settings" }).click();
      });
    await page
      .getByRole("button", { name: /^Switch organisation from / })
      .click();
    await page
      .getByRole("button", {
        name: /Five-million-row verification fixture\s*owner$/,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Switch organisation from Five-million-row verification fixture",
        exact: true,
      }),
    ).toBeAttached();
    const orgId = "01M3YBJF63FQKFPQSK568N7A1D",
      databaseId = "01M3YBJF72543P36XD1F8H4NZT",
      tableId = "01M3YBJF7RQTTAFG160ST17VWR",
      wideTableId = "01M3YCBF1XT4YKMQWNY4BR6PJ7";
    const db = await call(
      context,
      "GET",
      `/orgs/${orgId}/databases/${databaseId}`,
    );
    const scale = await call(
      context,
      "GET",
      `/orgs/${orgId}/databases/${databaseId}/tables/${tableId}`,
    );
    const wide = await call(
      context,
      "GET",
      `/orgs/${orgId}/databases/${databaseId}/tables/${wideTableId}`,
    );
    grid = await table(page, db.name, scale.name);
    const snapshots = [];
    for (const mode of [
      "First row window",
      "Middle row window",
      "Last row window",
      "First row window",
      "Next row window",
      "Middle row window",
      "Last row window",
    ]) {
      const before = performance.now();
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname.endsWith(
            `/tables/${tableId}/windows/query`,
          ) && r.request().method() === "POST",
        { timeout: 90_000 },
      );
      await page.getByRole("button", { name: mode, exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(200);
      const data = await result.json();
      await expect(page.locator(".row-navigation span")).toHaveText(
        new RegExp(
          `${data.window.start + 1}–${data.window.start + data.data.length} of 5,000,000`,
        ),
      );
      const memory = await grid.evaluate((element) => ({
        rows: element.querySelectorAll(".grid-row").length,
        columns: element.querySelectorAll(".column-header").length,
        cells: element.querySelectorAll(".grid-cell").length,
        scrollHeight: element.scrollHeight,
        cacheWindows: Number(element.dataset.cacheWindows),
        cacheBytes: Number(element.dataset.cacheBytes),
        heapUsed: performance.memory?.usedJSHeapSize ?? null,
      }));
      expect(memory.rows).toBeLessThan(32);
      expect(memory.columns).toBeLessThan(12);
      expect(memory.cacheWindows).toBeLessThanOrEqual(5);
      expect(memory.cacheBytes).toBeLessThanOrEqual(33554432);
      expect(memory.scrollHeight).toBeLessThan(10_000);
      snapshots.push({
        mode,
        elapsedMs: performance.now() - before,
        start: data.window.start,
        returned: data.data.length,
        ...memory,
      });
    }
    await page.screenshot({
      path: new URL(`${engine}-grid-five-million-last.png`, output).pathname,
    });
    grid = await table(page, db.name, wide.name);
    await expect(grid).toHaveAttribute("aria-colcount", "200");
    expect(await grid.getByRole("columnheader").count()).toBeLessThan(12);
    await grid.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(grid.getByRole("columnheader").last()).toBeVisible();
    expect(await grid.getByRole("columnheader").count()).toBeLessThan(12);
    await page.screenshot({
      path: new URL(`${engine}-grid-wide200.png`, output).pathname,
    });
    await writeFile(
      new URL(`${engine}-scale-navigation.json`, output),
      JSON.stringify(snapshots, null, 2),
    );
    return {
      rowCapacity: 5_000_000,
      fieldCapacity: 200,
      navigation: snapshots,
    };
  });
} catch (error) {
  report.errors.push({ type: "runner", message: reportError(error) });
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    new URL(`${engine}-rendered-report.json`, output),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      browser: engine,
      checks: report.checks.map(({ name, status, error }) => ({
        name,
        status,
        ...(error ? { error } : {}),
      })),
      pageErrors: report.errors,
    }),
  );
  await context.close();
  await browser.close();
  if (
    report.checks.some((check) => check.status === "failed") ||
    report.errors.length
  )
    process.exitCode = 1;
}
