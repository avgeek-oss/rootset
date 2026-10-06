import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { Pool } from "pg";
import { RootsetClient } from "@rootset/web-client";
import type {
  FieldDefinition,
  Job,
  Row,
  TableSchemaResult,
  Preferences,
  JsonValue,
} from "@rootset/contracts";
import {
  cellBrowserFields,
  cellBrowserValues,
  type BrowserDatabaseFixture,
} from "./browser-fixture";

const root = resolve(import.meta.dirname, "../../../../..");
if (existsSync(resolve(root, ".env.test")))
  process.loadEnvFile(resolve(root, ".env.test"));
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const statePath =
  process.env.ROOTSET_BROWSER_STATE_PATH ?? "/tmp/rootset-browser-state.json";
const isolatedStatePath = resolve(
  tmpdir(),
  `rootset-cell-browser-${randomUUID()}.json`,
);
const fixturePath =
  process.env.ROOTSET_UI_FIXTURE_PATH ??
  resolve(root, "apps/rootset-web/test-results/browser/fixture.json");
const credentialsPath =
  process.env.ROOTSET_BROWSER_CREDENTIALS_PATH ??
  resolve(root, "apps/rootset-web/.env.cells-browser-test");
const evidenceDirectory = resolve(
  root,
  "apps/rootset-web/test-results/cells-browser-evidence",
);
const tableName = `Cell editors ${randomUUID().slice(0, 8)}`;

test.use({
  baseURL,
  storageState: isolatedStatePath,
  viewport: { width: 1920, height: 1080 },
  screenshot: "only-on-failure",
  trace: "off",
});
test.describe.configure({ mode: "serial", timeout: 90_000 });

let fixture: BrowserDatabaseFixture;
let schema: TableSchemaResult;
let editableRow: Row;
let duplicateRow: Row;
let wideRow: Row;
let originalPreferences: Preferences;
let databaseName: string;
let previousTestStart = 0;

function api(page: Page): RootsetClient {
  return new RootsetClient({
    baseUrl: `${baseURL}/api/internal/v1`,
    fetch: async (input, init) => {
      const response = await page.request.fetch(String(input), {
        method: init?.method ?? "GET",
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          Origin: new URL(baseURL).origin,
        },
        ...(init?.body !== undefined ? { data: String(init.body) } : {}),
      });
      return new Response(
        response.status() === 204 ? null : await response.text(),
        { status: response.status(), headers: response.headers() },
      );
    },
  });
}

async function assertInstallationContext(page: Page) {
  const response = await page.request.get(`${baseURL}/api/internal/v1/context`);
  if (!response.ok())
    throw new Error(
      `The automatic installation context endpoint returned ${response.status()}.`,
    );
  expect((await response.json()).organisation.id).toBe(fixture.orgId);
}

async function awaitJob(page: Page, id: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await api(page).operation<Job>("getJob", {
      orgId: fixture.orgId,
      id,
    });
    if (job.state === "succeeded") return;
    if (
      job.state === "failed" ||
      job.state === "cancelled" ||
      job.state === "partially_completed"
    ) {
      throw new Error(
        `Fixture operation ${job.operationId} job ${id} ended ${job.state}: ${job.error?.code ?? "no error code"}.`,
      );
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Fixture job ${id} did not complete within 60 seconds.`);
}

function target() {
  return {
    orgId: fixture.orgId,
    databaseId: fixture.databaseId,
    tableId: schema.table.id,
  };
}
function field(key: string): FieldDefinition {
  const found = schema.fields.find((candidate) => candidate.name === key);
  if (!found) throw new Error(`Browser fixture field ${key} was not created.`);
  return found;
}

async function readRow(page: Page): Promise<Row> {
  return api(page).operation<Row>("getRow", {
    ...target(),
    rowId: editableRow.id,
  });
}

async function setPreferences(page: Page, patch: Partial<Preferences>) {
  return api(page).operation<Preferences>("updatePreferences", patch);
}

async function showTable(page: Page) {
  await page.goto("/");
  await page
    .locator(".database-list")
    .getByRole("button", { name: databaseName, exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Tables" })
    .getByRole("button", { name: tableName, exact: true })
    .click();
  await expect(
    page.getByRole("grid", { name: `${tableName} spreadsheet` }),
  ).toBeVisible();
}

async function cell(
  page: Page,
  key: string,
  rowId = editableRow.id,
): Promise<Locator> {
  const definition = field(key);
  const index = schema.fields.findIndex(
    (candidate) => candidate.id === definition.id,
  );
  const grid = page.getByRole("grid", { name: `${tableName} spreadsheet` });
  await grid.evaluate(
    (element, scrollLeft) => {
      element.scrollLeft = scrollLeft;
    },
    Math.max(0, index * 180 - 180),
  );
  const locator = page.locator(`#cell-${rowId}-${definition.id}`);
  await expect(locator).toBeVisible();
  await expect(locator).not.toHaveText("Loading…");
  return locator;
}

async function openEditor(page: Page, key: string): Promise<Locator> {
  await (await cell(page, key)).click();
  const dialog = page.getByRole("dialog", {
    name: `Edit ${field(key).name}`,
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  return dialog;
}

async function setCheckbox(
  dialog: Locator,
  name: string | RegExp,
  checked: boolean,
) {
  const control = dialog.getByRole("checkbox", { name });
  if ((await control.isChecked()) !== checked)
    await dialog.getByText(name, { exact: typeof name === "string" }).click();
  if (checked) await expect(control).toBeChecked();
  else await expect(control).not.toBeChecked();
}

async function fillAndSave(
  page: Page,
  key: string,
  value: string,
  keyboard = false,
) {
  const dialog = await openEditor(page, key);
  const input = dialog.getByLabel(field(key).name, { exact: true });
  await input.fill(value);
  if (keyboard)
    await input.press(key === "NAME" ? "ControlOrMeta+Enter" : "Enter");
  else
    await dialog
      .getByRole("button", { name: /^(Save value|Retry save)$/ })
      .click();
  await expect(dialog).not.toBeVisible();
}

async function saveResponse(page: Page, action: () => Promise<void>) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      new URL(candidate.url()).pathname.endsWith(`/rows/${editableRow.id}`),
  );
  await action();
  return response;
}

async function captureEvidence(page: Page, name: string) {
  mkdirSync(evidenceDirectory, { recursive: true });
  const path = resolve(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await test.info().attach(name, { path, contentType: "image/png" });
}

function annotate(...gates: string[]) {
  test
    .info()
    .annotations.push(
      ...gates.map((description) => ({ type: "gate", description })),
    );
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  if (!existsSync(credentialsPath) && !existsSync(statePath))
    throw new Error(
      `Browser prerequisite missing: separate verified account credentials at ${credentialsPath} or storage state at ${statePath}.`,
    );
  if (!existsSync(fixturePath))
    throw new Error(
      `Browser prerequisite missing: real UI database metadata at ${fixturePath}.`,
    );
  fixture = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  ) as BrowserDatabaseFixture;
  const context = await browser.newContext({
    baseURL,
    storageState: existsSync(credentialsPath)
      ? { cookies: [], origins: [] }
      : statePath,
  });
  const page = await context.newPage();
  try {
    if (existsSync(credentialsPath)) {
      const credentials = parseEnv(readFileSync(credentialsPath, "utf8"));
      const email = credentials.ROOTSET_TEST_OWNER_EMAIL;
      const password = credentials.ROOTSET_TEST_OWNER_PASSWORD;
      if (!email || !password)
        throw new Error("Isolated browser account credentials are incomplete.");
      const signedIn = await page.request.post(
        `${baseURL}/v1/auth/sign-in/email`,
        {
          headers: { Origin: new URL(baseURL).origin },
          data: { email, password },
        },
      );
      if (!signedIn.ok())
        throw new Error(
          `Isolated browser sign-in returned ${signedIn.status()}.`,
        );
      if ((await signedIn.json()).twoFactorRedirect)
        throw new Error(
          "This fixture account requires second-factor verification; prepare a separate verified account for browser interaction tests.",
        );
    }
    await assertInstallationContext(page);
    await context.storageState({ path: isolatedStatePath });
    chmodSync(isolatedStatePath, 0o600);
    await page.waitForTimeout(60_000 - (Date.now() % 60_000) + 100);
    const client = api(page);
    originalPreferences = await client.operation<Preferences>(
      "getPreferences",
      {},
    );
    const database = await client.operation<{ name: string }>("getDatabase", {
      orgId: fixture.orgId,
      databaseId: fixture.databaseId,
    });
    databaseName = database.name;
    schema = await client.operation<TableSchemaResult>("createTable", {
      orgId: fixture.orgId,
      databaseId: fixture.databaseId,
      name: tableName,
      fields: cellBrowserFields,
    });
    const unique = await client.operation<{ jobId?: string }>(
      "createUniqueRule",
      {
        ...target(),
        expectedSchemaVersion: schema.table.schemaVersion,
        fieldIds: [field("NAME").id],
      },
    );
    if (unique.jobId) await awaitJob(page, unique.jobId);
    schema = await client.operation<TableSchemaResult>(
      "getTableSchema",
      target(),
    );
    const createRow = async (values: Record<string, JsonValue>) =>
      (
        await client.operation<{ row: Row }>("createRow", {
          ...target(),
          expectedSchemaVersion: schema.table.schemaVersion,
          values,
        })
      ).row;
    editableRow = await createRow(cellBrowserValues);
    duplicateRow = await createRow({
      ...cellBrowserValues,
      NAME: "Taken",
      INTEGER: 2,
    });
    wideRow = await createRow({
      ...cellBrowserValues,
      NAME: "Wide",
      INTEGER: 3,
      JSON: { large: "x".repeat(60_000), nested: { present: true } },
    });
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ page }) => {
  const pause = previousTestStart + 20_000 - Date.now();
  if (pause > 0) await page.waitForTimeout(pause);
  previousTestStart = Date.now();
  await assertInstallationContext(page);
  const client = api(page);
  const current = await readRow(page);
  await client.operation("updateRow", {
    ...target(),
    rowId: editableRow.id,
    expectedVersion: current.version,
    expectedSchemaVersion: schema.table.schemaVersion,
    values: cellBrowserValues,
  });
  await setPreferences(page, {
    timezone: "UTC",
    locale: "en-GB",
    dateFormat: "year-month-day",
    timeFormat: "24-hour",
  });
  await client.operation("updateViewPreferences", {
    tableId: schema.table.id,
    preferences: {
      columnOrder: schema.fields.map((candidate) => candidate.id),
      columnWidths: {},
      frozenColumns: 0,
      hiddenColumns: [],
    },
  });
  await showTable(page);
});

test.afterAll(async ({ browser }) => {
  if (!originalPreferences) {
    rmSync(isolatedStatePath, { force: true });
    return;
  }
  const context = await browser.newContext({
    baseURL,
    storageState: isolatedStatePath,
  });
  const page = await context.newPage();
  try {
    await assertInstallationContext(page);
    await setPreferences(page, originalPreferences);
  } finally {
    await context.close();
    rmSync(isolatedStatePath, { force: true });
  }
});

test("eight single-tap editors commit actual typed canonical values", async ({
  page,
}) => {
  annotate("UI-04", "FLD-15");
  await fillAndSave(page, "NAME", "😀é\nkept", true);
  await fillAndSave(page, "INTEGER", "17", true);
  await fillAndSave(page, "FLOAT", "-1.25");
  const booleanDialog = await openEditor(page, "BOOLEAN");
  await setCheckbox(booleanDialog, /^BOOLEAN:/, true);
  await booleanDialog.getByRole("button", { name: "Save value" }).click();
  await expect(booleanDialog).not.toBeVisible();
  await fillAndSave(page, "DATE", "2024-02-29");
  await fillAndSave(page, "TIME", "08:09:10.125");
  await fillAndSave(page, "DATETIME", "2026-10-03T14:20:01.25");
  await expect(page.getByTestId("json-cell-editor")).toHaveCount(0);
  const jsonDialog = await openEditor(page, "JSON");
  const jsonInput = jsonDialog.getByRole("textbox", {
    name: "JSON",
    exact: true,
  });
  await expect(jsonInput).toBeVisible();
  await jsonInput.fill('{"nested":null,"list":[true,0,"x"]}');
  await jsonInput.press("ControlOrMeta+Enter");
  await expect(jsonDialog).not.toBeVisible();
  const current = await readRow(page);
  expect(current.values).toEqual({
    NAME: "😀é\nkept",
    INTEGER: 17,
    FLOAT: -1.25,
    BOOLEAN: true,
    DATE: "2024-02-29",
    TIME: "08:09:10.125Z",
    DATETIME: "2026-10-03T14:20:01.250Z",
    JSON: { list: [true, 0, "x"], nested: null },
  });
  await captureEvidence(page, "eight-types-saved");
  await test.info().attach("canonical-row", {
    body: JSON.stringify(current),
    contentType: "application/json",
  });
});

test("required fields and bounds keep invalid drafts without committing", async ({
  page,
}) => {
  annotate("UI-04", "UI-06", "FLD-03", "FLD-13");
  const before = await readRow(page);
  const integerDialog = await openEditor(page, "INTEGER");
  await expect(
    integerDialog.getByRole("checkbox", { name: "Clear cell (null)" }),
  ).toHaveCount(0);
  const integerInput = integerDialog.getByLabel("INTEGER", { exact: true });
  await integerInput.fill("");
  await integerDialog.getByRole("button", { name: "Save value" }).click();
  await expect(integerDialog.getByRole("alert")).toContainText("whole number");
  await expect(integerInput).toHaveValue("");
  await integerInput.fill("1000001");
  await integerDialog.getByRole("button", { name: "Save value" }).click();
  await expect(integerDialog.getByRole("alert")).toContainText("maximum");
  await expect(integerInput).toHaveValue("1000001");
  await integerInput.press("Escape");
  const textDialog = await openEditor(page, "NAME");
  await textDialog.getByLabel("NAME", { exact: true }).fill("😀".repeat(25));
  await textDialog.getByRole("button", { name: "Save value" }).click();
  await expect(textDialog.getByRole("alert")).toContainText("character limit");
  await expect(textDialog.getByLabel("NAME", { exact: true })).toHaveValue(
    "😀".repeat(25),
  );
  await textDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await readRow(page)).version).toBe(before.version);
  await expect(
    api(page).operation("updateRow", {
      ...target(),
      rowId: before.id,
      expectedVersion: before.version,
      expectedSchemaVersion: schema.table.schemaVersion,
      values: { INTEGER: null },
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

test("server uniqueness rejection retains the typed draft and leaves history unchanged", async ({
  page,
}) => {
  annotate("UI-06", "ROW-09");
  const before = await readRow(page);
  const history = () =>
    api(page).operation<{ data: unknown[] }>("getCellHistory", {
      ...target(),
      rowId: before.id,
      fieldId: field("NAME").id,
      limit: 200,
    });
  const priorHistory = await history();
  const dialog = await openEditor(page, "NAME");
  const input = dialog.getByLabel("NAME", { exact: true });
  await input.fill(String(duplicateRow.values.NAME));
  const response = await saveResponse(page, () =>
    dialog.getByRole("button", { name: "Save value" }).click(),
  );
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe("UNIQUE_CONFLICT");
  await expect(input).toHaveValue("Taken");
  await expect(dialog.getByRole("alert")).toContainText(
    /unique|duplicate|already exists/i,
  );
  await expect(
    dialog.getByRole("button", { name: "Retry save" }),
  ).toBeEnabled();
  expect((await readRow(page)).version).toBe(before.version);
  expect((await history()).data).toEqual(priorHistory.data);
  await captureEvidence(page, "server-rejection-preserved-draft");
  await input.fill("Recovered");
  await dialog.getByRole("button", { name: "Retry save" }).click();
  await expect(dialog).not.toBeVisible();
  expect((await readRow(page)).values.NAME).toBe("Recovered");
});

test("real concurrent row changes require explicit conflict review before retry", async ({
  page,
}) => {
  annotate("UI-06", "ROW-06");
  const before = await readRow(page);
  const dialog = await openEditor(page, "NAME");
  const input = dialog.getByLabel("NAME", { exact: true });
  await input.fill("My draft");
  await api(page).operation("updateRow", {
    ...target(),
    rowId: before.id,
    expectedVersion: before.version,
    expectedSchemaVersion: schema.table.schemaVersion,
    values: { NAME: "Other editor" },
  });
  const response = await saveResponse(page, () =>
    dialog.getByRole("button", { name: "Save value" }).click(),
  );
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe("ROW_VERSION_CONFLICT");
  await expect(input).toHaveValue("My draft");
  await expect(
    dialog.getByText(/Current committed value: Other editor/),
  ).toBeVisible();
  await expect(dialog.locator("button[type=submit]")).toBeDisabled();
  await captureEvidence(page, "row-conflict-preserved-draft");
  await dialog
    .getByRole("button", {
      name: "Keep my draft and retry against the current version",
    })
    .click();
  await expect(input).toHaveValue("My draft");
  await dialog.locator("button[type=submit]").click();
  await expect(dialog).not.toBeVisible();
  expect((await readRow(page)).values.NAME).toBe("My draft");
});

test("pending real database work disables repeated save and cancel", async ({
  page,
}) => {
  annotate("UI-06");
  const connectionString = process.env.ROOTSET_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "Pending-state verification needs isolated ROOTSET_TEST_DATABASE_URL to hold a real row lock.",
    );
  const pool = new Pool({ connectionString, max: 2 });
  const lock = await pool.connect();
  let patchCount = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname.endsWith(`/rows/${editableRow.id}`)
    )
      patchCount++;
  });
  let transactionOpen = false;
  try {
    const metadata = await pool.query<{
      schema_name: string;
      physical_name: string;
    }>(
      "SELECT d.schema_name,t.physical_name FROM rootset_control.tables t JOIN rootset_control.databases d ON d.id=t.database_id WHERE t.id=$1 AND t.org_id=$2",
      [schema.table.id, fixture.orgId],
    );
    const physical = metadata.rows[0];
    if (
      !physical ||
      !/^rsd_[a-z0-9]{26}$/.test(physical.schema_name) ||
      !/^rst_[a-z0-9]{26}(_g[0-9]+)?$/.test(physical.physical_name)
    )
      throw new Error(
        "The isolated fixture has no valid runtime table mapping.",
      );
    await lock.query("BEGIN");
    transactionOpen = true;
    await lock.query("SELECT set_config('rootset.org_id',$1,true)", [
      fixture.orgId,
    ]);
    const locked = await lock.query(
      `SELECT row_id FROM "${physical.schema_name}"."${physical.physical_name}" WHERE row_id=$1 FOR UPDATE`,
      [editableRow.id],
    );
    expect(locked.rowCount).toBe(1);
    const dialog = await openEditor(page, "NAME");
    const input = dialog.getByLabel("NAME", { exact: true });
    await input.fill("After wait");
    await dialog.getByRole("button", { name: "Save value" }).click();
    await expect(dialog.locator("button[type=submit]")).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByRole("status")).toHaveText("Saving this value…");
    await expect
      .poll(
        async () =>
          (
            await pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
              [`%${physical.physical_name}%`],
            )
          ).rows[0]!.count,
      )
      .toBeGreaterThan(0);
    await page.keyboard.press("ControlOrMeta+Enter");
    expect(patchCount).toBe(1);
    await captureEvidence(page, "pending-row-lock");
    await lock.query("COMMIT");
    transactionOpen = false;
    await expect(dialog).not.toBeVisible();
    expect((await readRow(page)).values.NAME).toBe("After wait");
  } finally {
    if (transactionOpen) await lock.query("ROLLBACK");
    lock.release();
    await pool.end();
  }
});

test("keyboard cancel returns grid focus and Tab/Enter navigate and commit", async ({
  page,
}) => {
  annotate("UI-04", "UI-05");
  const before = await readRow(page);
  const dialog = await openEditor(page, "NAME");
  const input = dialog.getByLabel("NAME", { exact: true });
  await input.fill("Discard me");
  await input.press("Escape");
  await expect(dialog).not.toBeVisible();
  const grid = page.getByRole("grid", { name: `${tableName} spreadsheet` });
  await expect(grid).toBeFocused();
  expect((await readRow(page)).version).toBe(before.version);
  await page.keyboard.press("Tab");
  await expect(grid).toHaveAttribute(
    "aria-activedescendant",
    `cell-${editableRow.id}-${field("INTEGER").id}`,
  );
  await page.keyboard.press("Enter");
  const integerDialog = page.getByRole("dialog", {
    name: "Edit INTEGER",
    exact: true,
  });
  await expect(integerDialog).toBeVisible();
  const integerInput = integerDialog.getByLabel("INTEGER", { exact: true });
  await integerInput.fill("29");
  await integerInput.press("Tab");
  await expect(
    integerDialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await integerInput.focus();
  await integerInput.press("Enter");
  await expect(integerDialog).not.toBeVisible();
  expect((await readRow(page)).values.INTEGER).toBe(29);
});

test("timezone preferences convert only date-times and resolve DST explicitly", async ({
  page,
}) => {
  annotate("UI-07", "FLD-09", "FLD-10");
  await setPreferences(page, {
    timezone: "Asia/Kolkata",
    locale: "en-GB",
    dateFormat: "day-month-year",
    timeFormat: "12-hour",
  });
  await showTable(page);
  const dialog = await openEditor(page, "DATETIME");
  const input = dialog.getByLabel("DATETIME", { exact: true });
  await expect(input).toHaveValue("2026-10-02T18:00:00.123");
  await input.fill("2026-10-03T01:30:00.25");
  await dialog.getByRole("button", { name: "Save value" }).click();
  await expect(dialog).not.toBeVisible();
  let current = await readRow(page);
  expect(current.values.DATETIME).toBe("2026-10-02T20:00:00.250Z");
  expect(current.values.DATE).toBe(cellBrowserValues.DATE);
  expect(current.values.TIME).toBe(cellBrowserValues.TIME);
  await expect(await cell(page, "DATE")).toHaveText("02/10/2026");
  await expect(await cell(page, "TIME")).toContainText("UTC");
  await setPreferences(page, {
    timezone: "America/New_York",
    timeFormat: "24-hour",
  });
  await showTable(page);
  const dstDialog = await openEditor(page, "DATETIME");
  const dstInput = dstDialog.getByLabel("DATETIME", { exact: true });
  await dstInput.fill("2026-03-08T02:30");
  await dstDialog.getByRole("button", { name: "Save value" }).click();
  await expect(dstDialog.getByRole("alert")).toContainText("does not exist");
  await expect(dstInput).toHaveValue("2026-03-08T02:30");
  await dstInput.fill("2026-11-01T01:30");
  await dstDialog.getByRole("button", { name: "Save value" }).click();
  await expect(dstDialog.getByRole("alert")).toContainText("occurs twice");
  await dstDialog
    .getByRole("button", { name: /This local time occurs twice/ })
    .click();
  const offsetChoice = page.getByRole("option", { name: /UTC-05:00/ });
  await expect(offsetChoice).toBeVisible();
  await captureEvidence(page, "explicit-dst-choice");
  await offsetChoice.click();
  await dstDialog.getByRole("button", { name: "Save value" }).click();
  await expect(dstDialog).not.toBeVisible();
  current = await readRow(page);
  expect(current.values.DATETIME).toBe("2026-11-01T06:30:00.000Z");
});

test("JSON is lazy, invalid drafts stay visible, and previews stay bounded", async ({
  page,
}) => {
  annotate("UI-17", "FLD-11");
  await expect(page.getByTestId("json-cell-editor")).toHaveCount(0);
  const preview = await cell(page, "JSON", wideRow.id);
  expect((await preview.innerText()).length).toBeLessThanOrEqual(160);
  expect(await preview.innerText()).toContain("…");
  const dialog = await openEditor(page, "JSON");
  const input = dialog.getByRole("textbox", { name: "JSON", exact: true });
  await expect(input).toBeVisible();
  await input.fill('{"key":1,"key":2}');
  await dialog.getByRole("button", { name: "Save value" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/duplicate/i);
  await expect(input).toHaveText('{"key":1,"key":2}');
  await captureEvidence(page, "json-validation-preserved-draft");
  await input.fill("9007199254740993");
  await dialog.getByRole("button", { name: "Save value" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/safe integer/i);
  await input.fill('{"list":[1,null,false]}');
  await dialog.getByRole("button", { name: "Save value" }).click();
  await expect(dialog).not.toBeVisible();
  expect((await readRow(page)).values.JSON).toEqual({ list: [1, null, false] });
});

test("nullable boolean false and top-level JSON null remain distinct", async ({
  page,
}) => {
  annotate("FLD-05", "FLD-11", "FLD-13");
  const booleanDialog = await openEditor(page, "BOOLEAN");
  await setCheckbox(booleanDialog, "Clear cell (null)", true);
  await booleanDialog.getByRole("button", { name: "Save value" }).click();
  await expect(booleanDialog).not.toBeVisible();
  expect((await readRow(page)).values.BOOLEAN).toBeNull();
  const populatedDialog = await openEditor(page, "BOOLEAN");
  await setCheckbox(populatedDialog, "Clear cell (null)", false);
  await expect(
    populatedDialog.getByRole("checkbox", { name: /^BOOLEAN:/ }),
  ).not.toBeChecked();
  await populatedDialog.getByRole("button", { name: "Save value" }).click();
  await expect(populatedDialog).not.toBeVisible();
  expect((await readRow(page)).values.BOOLEAN).toBe(false);
  const jsonDialog = await openEditor(page, "JSON");
  await jsonDialog
    .getByRole("textbox", { name: "JSON", exact: true })
    .fill("null");
  await jsonDialog.getByRole("button", { name: "Save value" }).click();
  await expect(jsonDialog).not.toBeVisible();
  expect((await readRow(page)).values.JSON).toBeNull();
});
