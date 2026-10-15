import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import type { Row, TableSchemaResult } from "@rootset/contracts";

const web = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const api = process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";
const state =
  process.env.ROOTSET_BROWSER_STATE_PATH ?? "/tmp/rootset-browser-state.json";
if (
  ![web, api].every((value) =>
    ["localhost", "127.0.0.1"].includes(new URL(value).hostname),
  )
)
  throw new Error(
    "Constraint browser checks require a disposable loopback installation.",
  );
if (!existsSync(state))
  throw new Error("Prepare authenticated disposable browser storage state.");
const evidence = resolve(
  process.env.ROOTSET_CONSTRAINT_EVIDENCE_DIR ?? "test-results/constraints",
);
test.use({
  baseURL: web,
  storageState: state,
  viewport: { width: 1440, height: 1000 },
});
test.describe.configure({ mode: "serial", timeout: 60_000 });
let schema: TableSchemaResult, orgId: string, databaseId: string;
let first: Row, second: Row;
const tableName = `Constraints ${randomUUID().slice(0, 8)}`;
async function call(
  context: BrowserContext,
  method: string,
  path: string,
  data?: unknown,
) {
  const result = await context.request.fetch(`${api}/api/internal/v1${path}`, {
    method,
    headers: { Origin: web, "Idempotency-Key": randomUUID() },
    ...(data ? { data } : {}),
  });
  const value = await result.json();
  if (!result.ok())
    throw new Error(
      `${method} ${path}: ${result.status()} ${value.error?.code}`,
    );
  return value;
}
function path() {
  return `/orgs/${orgId}/databases/${databaseId}/tables/${schema.table.id}`;
}
async function settle(context: BrowserContext, value: { jobId?: string }) {
  if (!value.jobId) return;
  for (let i = 0; i < 60; i++) {
    const job = await call(
      context,
      "GET",
      `/orgs/${orgId}/jobs/${value.jobId}`,
    );
    if (job.state === "succeeded") return;
    if (["failed", "cancelled", "partially_completed"].includes(job.state))
      throw new Error(`Constraint job ${job.state}: ${job.error?.code}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Constraint fixture job did not complete.");
}
async function read(context: BrowserContext, row = first): Promise<Row> {
  return call(context, "GET", `${path()}/rows/${row.id}`);
}
async function show(page: Page) {
  await page.goto(`/databases/${databaseId}/tables/${schema.table.id}`);
  await expect(
    page.getByRole("grid", { name: `${tableName} spreadsheet` }),
  ).toBeVisible();
}
async function edit(page: Page, name: string, row = first) {
  const index = schema.fields.findIndex((field) => field.name === name);
  await page
    .locator(`[data-row-id="${row.id}"] > [aria-colindex="${index + 2}"]`)
    .dblclick();
  const control = page.getByLabel(name, { exact: true });
  await expect(control).toBeVisible();
  return control;
}
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: state });
  try {
    orgId = (await call(context, "GET", "/context")).organisation.id;
    databaseId = (
      await call(context, "POST", `/orgs/${orgId}/databases`, {
        name: tableName,
      })
    ).id;
    schema = await call(
      context,
      "POST",
      `/orgs/${orgId}/databases/${databaseId}/tables`,
      {
        name: tableName,
        fields: [
          { name: "CODE", type: "text", charLimit: 20 },
          {
            name: "STATUS",
            type: "text",
            allowedValues: ["active", "ceased", "NULL"],
            default: "ceased",
          },
          {
            name: "REQUIRED_STATUS",
            type: "text",
            required: true,
            allowedValues: ["active", "ceased"],
            default: "ceased",
          },
        ],
      },
    );
    const rule = await call(context, "POST", `${path()}/unique-rules`, {
      expectedSchemaVersion: 1,
      fieldIds: [schema.fields[0]!.id],
      where: { field: schema.fields[1]!.id, op: "eq", value: "active" },
    });
    await settle(context, rule);
    schema = await call(context, "GET", `${path()}/schema`);
    first = (
      await call(context, "POST", `${path()}/rows`, {
        expectedSchemaVersion: schema.table.schemaVersion,
        values: { CODE: "shared", STATUS: "ceased" },
      })
    ).row;
    second = (
      await call(context, "POST", `${path()}/rows`, {
        expectedSchemaVersion: schema.table.schemaVersion,
        values: { CODE: "shared", STATUS: "active" },
      })
    ).row;
  } finally {
    await context.close();
  }
});
test.afterAll(async ({ browser }) => {
  if (!schema) return;
  const context = await browser.newContext({ storageState: state });
  try {
    await settle(
      context,
      await call(context, "DELETE", path(), {
        expectedSchemaVersion: (await call(context, "GET", `${path()}/schema`))
          .table.schemaVersion,
      }),
    );
  } finally {
    await context.close();
  }
});

test("dropdown edits keep NULL, literal choices and required fields distinct", async ({
  page,
  context,
}) => {
  await show(page);
  const optional = await edit(page, "STATUS");
  await expect(optional.locator("option")).toHaveText([
    "NULL",
    "active",
    "ceased",
    '"NULL"',
  ]);
  await optional.selectOption("choice:2");
  await optional.press("Tab");
  await expect
    .poll(async () => (await read(context)).values.STATUS)
    .toBe("NULL");
  await expect(
    page.locator(`[data-row-id="${first.id}"] > [aria-colindex="4"]`),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const required = page.getByLabel("REQUIRED_STATUS", { exact: true });
  await expect(required).toBeVisible();
  await expect(required.locator("option")).toHaveText(["active", "ceased"]);
  await required.selectOption("choice:0");
  await required.press("Escape");
  expect((await read(context)).values.REQUIRED_STATUS).toBe("ceased");
  const nullControl = await edit(page, "STATUS");
  await nullControl.selectOption("null");
  await nullControl.press("Enter");
  await expect.poll(async () => (await read(context)).values.STATUS).toBe(null);
});

test("conditional conflicts restore the committed dropdown and leaving the subset releases the code", async ({
  page,
  context,
}) => {
  await show(page);
  const before = await read(context);
  const conflict = await edit(page, "STATUS");
  await conflict.selectOption("choice:0");
  await conflict.press("Enter");
  await expect(
    page.getByText(
      "A declared unique tuple already exists among rows matched by the rule",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await read(context)).version).toBe(before.version);
  expect((await read(context)).values.STATUS).toBe(null);
  const leaving = await edit(page, "STATUS", second);
  await leaving.selectOption("choice:1");
  await leaving.press("Enter");
  await expect
    .poll(async () => (await read(context, second)).values.STATUS)
    .toBe("ceased");
  const entering = await edit(page, "STATUS");
  await entering.selectOption("choice:0");
  await entering.press("Enter");
  await expect
    .poll(async () => (await read(context)).values.STATUS)
    .toBe("active");
});

test("field choices and condition configuration render at desktop and mobile sizes in both themes", async ({
  page,
}) => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(evidence, { recursive: true });
  for (const theme of ["light", "dark"]) {
    for (const [label, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(
        `/databases/${databaseId}/tables/${schema.table.id}/settings/rules`,
      );
      await expect(
        page.getByText('STATUS is "active"', { exact: true }),
      ).toBeVisible();
      const themeButton = page.getByRole("button", {
        name: `Appearance: switch to ${theme} theme`,
        exact: true,
      });
      if (await themeButton.count()) await themeButton.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      await page
        .getByRole("button", { name: "Create unique rule", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create unique rule",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Apply to", exact: false })
        .click();
      await page
        .getByRole("option", { name: "Rows matching a condition", exact: true })
        .click();
      await expect(
        dialog.getByText("Condition field", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("Condition value", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      await page.screenshot({
        path: `${evidence}/${label}-${theme}-conditional-rule.png`,
      });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.goto(
        `/databases/${databaseId}/tables/${schema.table.id}/settings/fields`,
      );
      await page
        .getByRole("row")
        .filter({ hasText: "REQUIRED_STATUS" })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      const fieldDialog = page.getByRole("dialog", {
        name: "Edit REQUIRED_STATUS",
        exact: true,
      });
      await expect(
        fieldDialog.getByLabel("Choices", { exact: true }),
      ).toHaveValue("active");
      await expect(
        fieldDialog.getByLabel("Choice 2", { exact: true }),
      ).toHaveValue("ceased");
      await expect
        .poll(() =>
          fieldDialog.evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      await page.screenshot({
        path: `${evidence}/${label}-${theme}-allowed-values.png`,
      });
      await fieldDialog
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
    }
  }
});

test("field and rule forms publish constraints through the existing UI", async ({
  page,
  context,
}) => {
  await page.goto(
    `/databases/${databaseId}/tables/${schema.table.id}/settings/fields`,
  );
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add field", exact: true });
  await dialog.getByLabel("Column name", { exact: true }).fill("NEW_STATE");
  await dialog.getByRole("button", { name: /Allowed values/ }).click();
  await page
    .getByRole("option", { name: "Only these choices", exact: true })
    .click();
  await dialog.getByLabel("Choices", { exact: true }).fill("draft");
  await dialog.getByRole("button", { name: "Add choice", exact: true }).click();
  await dialog.getByLabel("Choice 2", { exact: true }).fill("published");
  await dialog.getByText("Required", { exact: true }).click();
  await expect(
    dialog.getByRole("switch", { name: "Required", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: /Default for new rows/ }).click();
  await page
    .getByRole("option", { name: "A literal value", exact: true })
    .click();
  await dialog.getByRole("button", { name: /Default value/ }).click();
  await page.getByRole("option", { name: "draft", exact: true }).click();
  await dialog.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () =>
      (await call(context, "GET", `${path()}/schema`)).fields.map(
        (field: { name: string }) => field.name,
      ),
    )
    .toContain("NEW_STATE");
  schema = await call(context, "GET", `${path()}/schema`);
  expect(
    schema.fields.find((field) => field.name === "NEW_STATE"),
  ).toMatchObject({ allowedValues: ["draft", "published"] });
  expect((await read(context)).values.NEW_STATE).toBe("draft");
  await page.goto(
    `/databases/${databaseId}/tables/${schema.table.id}/settings/rules`,
  );
  await page
    .getByRole("button", { name: "Create unique rule", exact: true })
    .click();
  const rule = page.getByRole("dialog", {
    name: "Create unique rule",
    exact: true,
  });
  await rule.getByRole("button", { name: /Apply to/ }).click();
  await page
    .getByRole("option", { name: "Rows matching a condition", exact: true })
    .click();
  await rule.getByRole("button", { name: /Condition field/ }).click();
  await page.getByRole("option", { name: "STATUS", exact: true }).click();
  await rule.getByLabel("Condition value", { exact: true }).fill("ceased");
  await rule.getByRole("button", { name: /Fields/ }).click();
  await page
    .getByRole("listbox", { name: /^Fields/ })
    .getByRole("option", { name: "CODE", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await rule
    .getByRole("button", { name: "Create unique rule", exact: true })
    .click();
  await expect(rule).not.toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText('STATUS is "ceased"', { exact: true }),
  ).toBeVisible();
});

test("field drag handles support keyboard reordering and cancellation", async ({
  page,
  context,
}) => {
  schema = await call(context, "GET", `${path()}/schema`);
  const original = schema.fields.map((field) => field.id);
  const moved = schema.fields[0]!;
  await page.goto(
    `/databases/${databaseId}/tables/${schema.table.id}/settings/fields`,
  );
  const handle = page.getByRole("button", {
    name: `Reorder ${moved.name}`,
    exact: true,
  });
  const row = page.getByRole("row").filter({ has: handle });
  await row.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", {
      name: `Insert between ${moved.name} and ${schema.fields[1]!.name}`,
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  expect(
    (await call(context, "GET", `${path()}/schema`)).fields.map(
      (field: { id: string }) => field.id,
    ),
  ).toEqual(original);
  await row.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      (await call(context, "GET", `${path()}/schema`)).fields.map(
        (field: { id: string }) => field.id,
      ),
    )
    .toEqual([original[1], original[0], ...original.slice(2)]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Reorder / }).first(),
  ).toHaveAccessibleName(`Reorder ${schema.fields[1]!.name}`);
});
