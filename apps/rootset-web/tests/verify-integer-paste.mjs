import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { reportError } from "./report-error.mjs";

const engine = process.env.ROOTSET_TEST_BROWSER ?? "chromium";
const before = process.env.ROOTSET_VERIFY_BEFORE_FIX === "true";
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
  permissions:
    engine === "chromium" ? ["clipboard-read", "clipboard-write"] : [],
});
const page = await context.newPage();
const report = {
  browser: engine,
  candidateCommit: process.env.ROOTSET_CANDIDATE_COMMIT ?? null,
  classification:
    "working-tree development verification; no acceptance promotion",
  beforeFix: before,
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (e) => report.pageErrors.push(reportError(e)));
async function call(method, path, data) {
  const response = await context.request.fetch(`/api/internal/v1${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: {
      Origin: new URL(baseURL).origin,
      "Idempotency-Key": randomUUID(),
    },
  });
  const body = await response.json();
  if (!response.ok())
    throw new Error(
      `${method} ${path}: HTTP ${response.status()} ${body.error?.code}`,
    );
  return body;
}
try {
  const login = await context.request.post("/v1/auth/sign-in/email", {
    data: {
      email: credentials.ROOTSET_TEST_OWNER_EMAIL,
      password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
    },
    headers: { Origin: new URL(baseURL).origin },
  });
  expect(login.ok()).toBe(true);
  expect((await context.request.get("/api/internal/v1/context")).ok()).toBe(
    true,
  );
  const root = `/orgs/${fixture.orgId}/databases/${fixture.databaseId}`;
  const created = await call("POST", `${root}/tables`, {
    name: `Integer precision ${randomUUID().slice(0, 8)}`,
    fields: [
      { name: "TEXT", type: "text", charLimit: 256 },
      { name: "INTEGER", type: "integer" },
    ],
  });
  const path = `${root}/tables/${created.table.id}`;
  const row = (
    await call("POST", `${path}/rows`, {
      expectedSchemaVersion: created.table.schemaVersion,
      values: { TEXT: "Loading…", INTEGER: 7 },
    })
  ).row;
  const schema = await call("GET", `${path}/schema`);
  const integerField = schema.fields.find((field) => field.name === "INTEGER");
  report.tableId = created.table.id;
  await page.goto(
    `/settings/table?organisationId=${fixture.orgId}&databaseId=${fixture.databaseId}&tableId=${created.table.id}`,
  );
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("gridcell").first()).toHaveText("Loading…");
  await expect(grid).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(1500);
  const timing = await page.evaluate(() =>
    performance
      .getEntriesByName("rootset:grid:usable")
      .map((entry) => ({ startTime: entry.startTime, detail: entry.detail })),
  );
  if (before) expect(timing).toHaveLength(0);
  else {
    expect(timing).toHaveLength(1);
    expect(timing[0].detail.tableId).toBe(created.table.id);
    await expect(grid.getByRole("gridcell").first()).toHaveAttribute(
      "data-cell-loaded",
      "true",
    );
  }
  report.checks.push({
    name: "Legitimate loaded Loading… text does not count as an unloaded placeholder",
    observedMarks: timing.length,
    expectedBeforeFixDefect: before,
  });
  async function selectedInteger() {
    await grid.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowRight");
  }
  async function stored() {
    return {
      row: await call("GET", `${path}/rows/${row.id}`),
      history: await call(
        "GET",
        `${path}/rows/${row.id}/cells/${integerField.id}/history?limit=50`,
      ),
    };
  }
  for (const [spelling, rounded] of [
    ["9007199254740990.5", 9007199254740990],
    ["1.00000000000000001", 1],
  ]) {
    const baseline = await stored();
    await selectedInteger();
    // A real system clipboard write and native paste into Rootset's actual grid.
    const input = await page.evaluateHandle(() => {
      const button = document.createElement("button");
      button.textContent = "Clipboard fixture writer";
      button.addEventListener("click", () => {
        window.__fixtureClipboardWrite = navigator.clipboard.writeText(
          window.__fixtureClipboardText,
        );
      });
      document.body.append(button);
      return button;
    });
    await page.evaluate((text) => {
      window.__fixtureClipboardText = text;
    }, spelling);
    await input.asElement().click();
    await page.evaluate(() => window.__fixtureClipboardWrite);
    await input.evaluate((element) => element.remove());
    await selectedInteger();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+v" : "Control+v",
    );
    const review = page.getByRole("dialog", {
      name: "Review paste",
      exact: true,
    });
    await expect(review).toBeVisible();
    const commit = review.getByRole("button", {
      name: "Commit paste",
      exact: true,
    });
    if (before) {
      await expect(commit).toBeEnabled();
      await commit.click();
      await expect(review).not.toBeVisible();
      const after = await stored();
      expect(after.row.values.INTEGER).toBe(rounded);
      expect(after.row.version).not.toBe(baseline.row.version);
      report.checks.push({
        name: "Pre-fix native paste silently rounds a fractional spelling",
        spelling,
        stored: rounded,
      });
    } else {
      await expect(commit).toBeDisabled();
      await expect(review).toContainText("whole number");
      await review.getByRole("button", { name: "Close dialog" }).click();
      expect(await stored()).toEqual(baseline);
      report.checks.push({
        name: "Fractional spelling refused before commit, canonical row/revision/history unchanged",
        spelling,
      });
    }
    await selectedInteger();
    await page.keyboard.press("Enter");
    const editor = page.getByRole("dialog", {
      name: "Edit INTEGER",
      exact: true,
    });
    await editor.getByLabel("INTEGER", { exact: true }).fill(spelling);
    const editorBaseline = await stored();
    await editor
      .getByRole("button", { name: "Save value", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText("whole number");
    expect(await stored()).toEqual(editorBaseline);
    await page.keyboard.press("Escape");
    report.checks.push({
      name: "Ordinary integer cell editor also rejects the fractional spelling without mutation",
      spelling,
    });
  }
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (failure) {
  report.status = "failed";
  report.error = reportError(failure);
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await page.screenshot({
    path: new URL(
      `${engine}-integer-paste-${before ? "before" : "after"}.png`,
      output,
    ).pathname,
    fullPage: true,
  });
  await writeFile(
    new URL(
      `${engine}-integer-paste-${before ? "before" : "after"}-report.json`,
      output,
    ),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await browser.close();
}
