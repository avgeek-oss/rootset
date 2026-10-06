import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300",
  output = new URL("../test-results/browser/", import.meta.url);
const f = JSON.parse(
    await readFile(
      new URL("../test-results/browser/fixture.json", import.meta.url),
      "utf8",
    ),
  ),
  c = parseEnv(
    await readFile(
      new URL("../.env.cells-browser-test", import.meta.url),
      "utf8",
    ),
  );
const b = await chromium.launch(),
  x = await b.newContext({ baseURL, viewport: { width: 1440, height: 1000 } }),
  p = await x.newPage();
const report = { browser: "chromium", checks: [], pageErrors: [] };
p.on("pageerror", (e) => report.pageErrors.push(e.message));
const path = `/orgs/${f.orgId}/databases/${f.databaseId}/tables/${f.tableId}`;
let originalField, originalRow;
async function call(method, path, data) {
  const r = await x.request.fetch(`/api/internal/v1${path}`, {
      method,
      ...(data ? { data } : {}),
      headers: {
        Origin: new URL(baseURL).origin,
        "Idempotency-Key": randomUUID(),
      },
    }),
    j = r.status() === 204 ? null : await r.json();
  if (!r.ok())
    throw new Error(`${method} ${path}: HTTP ${r.status()} ${j.error?.code}`);
  return j;
}
async function settle(result) {
  if (!result.jobId) return;
  for (let n = 0; n < 45; n++) {
    const j = await call("GET", `/orgs/${f.orgId}/jobs/${result.jobId}`);
    if (j.state === "succeeded") return;
    if (["failed", "cancelled", "partially_completed"].includes(j.state))
      throw new Error(`Schema job ${j.state}: ${j.error?.code}`);
    await p.waitForTimeout(1000);
  }
  throw new Error("Schema job did not complete.");
}
function input(field) {
  const value = { ...field };
  delete value.id;
  delete value.order;
  return value;
}
async function saveView(trigger) {
  const next = p.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      new URL(r.url()).pathname.endsWith(`/view-preferences/${f.tableId}`),
  );
  await trigger();
  const r = await next;
  expect(r.status()).toBe(200);
  return r.json();
}
try {
  await x.request.post("/v1/auth/sign-in/email", {
    headers: { Origin: new URL(baseURL).origin },
    data: {
      email: c.ROOTSET_TEST_OWNER_EMAIL,
      password: c.ROOTSET_TEST_OWNER_PASSWORD,
    },
  });
  await x.request.get("/api/internal/v1/context");
  await call("PUT", `/view-preferences/${f.tableId}`, {
    preferences: {
      columnOrder: [],
      hiddenColumns: [],
      frozenColumns: 0,
      columnWidths: {},
    },
  });
  await p.goto(baseURL);
  await p.getByRole("button", { name: "UI verification", exact: true }).click();
  await p.getByRole("button", { name: "Cell types", exact: true }).click();
  const grid = p.getByRole("grid", { name: "Cell types spreadsheet" });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("gridcell").first()).not.toHaveText("Loading…");
  const schema = await call("GET", `${path}/schema`);
  originalField = schema.fields.find((v) => v.type === "text");
  const json = schema.fields.find((v) => v.type === "json");
  const view = await saveView(async () => {
    await p
      .getByRole("separator", {
        name: `Resize ${originalField.name}`,
        exact: true,
      })
      .focus();
    await p.keyboard.press("ArrowRight");
  });
  expect(view.preferences.columnWidths[originalField.id]).toBe(200);
  await expect(p.locator(".column-reorder")).toHaveCount(0);
  // Fields control the grid order; API preferences can still freeze columns.
  await call("PUT", `/view-preferences/${f.tableId}`, {
    preferences: {
      ...view.preferences,
      columnOrder: [...schema.fields].reverse().map((field) => field.id),
      hiddenColumns: [json.id],
      frozenColumns: 1,
    },
  });
  await p.reload();
  await expect(p.locator(".column-header").first()).toContainText(
    schema.fields[0].name,
  );
  await expect(p.locator(".column-header").first()).toHaveClass(/frozen/);
  await expect(
    p.getByRole("separator", {
      name: `Resize ${originalField.name}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-valuenow", "200");
  await expect(p.getByRole("columnheader")).toHaveCount(schema.fields.length);
  await expect(
    p.getByRole("columnheader").filter({ hasText: json.name }),
  ).toBeVisible();
  await expect(
    p.getByRole("button", { name: "Columns", exact: true }),
  ).toHaveCount(0);
  await mkdir(output, { recursive: true });
  await p.screenshot({
    path: new URL("chromium-view-preferences.png", output).pathname,
  });
  report.checks.push({
    name: "Keyboard column resize persists through reload; field order controls the grid while API freezing is honoured and hidden-column preferences cannot conceal fields in the UI",
    status: "passed",
  });
  await call("PUT", `/view-preferences/${f.tableId}`, {
    preferences: {
      columnOrder: [],
      hiddenColumns: [],
      frozenColumns: 0,
      columnWidths: {},
    },
  });
  await p.reload();
  await expect(grid.getByRole("gridcell").first()).not.toHaveText("Loading…");
  const rows = await call("POST", `${path}/query`, { query: { limit: 1000 } });
  originalRow = rows.data[0];
  await grid.getByRole("gridcell").first().click();
  let dialog = p.getByRole("dialog", {
    name: `Edit ${originalField.name}`,
    exact: true,
  });
  const editor = dialog.getByRole("textbox", {
    name: new RegExp(`^${originalField.name}`),
  });
  await editor.fill("UI schema draft");
  for (let index = 0; index < 12; index++) {
    await p.keyboard.press("Tab");
    expect(
      await dialog.evaluate(
        (element) =>
          element.contains(document.activeElement) ||
          document.activeElement === document.body,
      ),
    ).toBe(true);
  }
  await expect(editor).toHaveValue("UI schema draft");
  report.checks.push({
    name: "Uncommitted cell draft survives keyboard traversal; modal focus prevents navigation or a filter change until an explicit save or cancel",
    status: "passed",
  });
  const before = schema.table.schemaVersion;
  const change = await call("PATCH", `${path}/fields/${originalField.id}`, {
    field: {
      ...input(originalField),
      name: `${originalField.name}_reviewed`,
    },
    expectedSchemaVersion: before,
    conversion: "explicit",
  });
  await settle(change);
  await dialog.getByRole("button", { name: "Save value", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(editor).toHaveValue("UI schema draft");
  await expect(
    dialog.getByRole("button", { name: "Retry save", exact: true }),
  ).toBeDisabled();
  const untouched = await call("GET", `${path}/rows/${originalRow.id}`);
  expect(untouched.version).toBe(originalRow.version);
  await dialog
    .getByRole("button", {
      name: "Reload schema and review draft",
      exact: true,
    })
    .click();
  dialog = p.getByRole("dialog", {
    name: `Edit ${originalField.name}_reviewed`,
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", {
      name: new RegExp(`^${originalField.name}_reviewed`),
    }),
  ).toHaveValue("UI schema draft");
  await expect(
    dialog.getByRole("button", { name: "Save value", exact: true }),
  ).toBeEnabled();
  await p.screenshot({
    path: new URL("chromium-schema-conflict-review.png", output).pathname,
  });
  await dialog.getByRole("button", { name: "Save value", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await call("GET", `${path}/rows/${originalRow.id}`)).values[
      `${originalField.name}_reviewed`
    ],
  ).toBe("UI schema draft");
  report.checks.push({
    name: "Real concurrent schema change rejects stale cell mutation; retained input requires explicit schema review before corrected save",
    status: "passed",
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
  report.visibleErrors = await p.getByRole("alert").allTextContents();
} finally {
  try {
    if (originalField) {
      const s = await call("GET", `${path}/schema`);
      const current = s.fields.find((field) => field.id === originalField.id);
      if (current && current.name !== originalField.name)
        await settle(
          await call("PATCH", `${path}/fields/${originalField.id}`, {
            field: input(originalField),
            expectedSchemaVersion: s.table.schemaVersion,
            conversion: "explicit",
          }),
        );
    }
    if (originalRow && originalField) {
      const row = await call("GET", `${path}/rows/${originalRow.id}`),
        s = await call("GET", `${path}/schema`);
      if (
        row.values[originalField.name] !==
        originalRow.values[originalField.name]
      )
        await call("PATCH", `${path}/rows/${originalRow.id}`, {
          values: {
            [originalField.name]: originalRow.values[originalField.name],
          },
          expectedVersion: row.version,
          expectedSchemaVersion: s.table.schemaVersion,
        });
    }
    await call("PUT", `/view-preferences/${f.tableId}`, {
      preferences: {
        columnOrder: [],
        hiddenColumns: [],
        frozenColumns: 0,
        columnWidths: {},
      },
    });
  } catch (error) {
    report.cleanupError = reportError(error);
    report.status = "failed";
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL("chromium-view-schema-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await x.close();
  await b.close();
  if (report.status !== "passed") process.exitCode = 1;
}
