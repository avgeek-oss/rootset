import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type BrowserContext } from "@playwright/test";

const web = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const api = process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";
const state =
  process.env.ROOTSET_BROWSER_STATE_PATH ?? "/tmp/rootset-browser-state.json";
const evidence = resolve(
  process.env.ROOTSET_CONSTRAINT_EVIDENCE_DIR ?? "test-results/json-schema",
);
if (
  ![web, api].every((value) =>
    ["localhost", "127.0.0.1"].includes(new URL(value).hostname),
  )
)
  throw new Error(
    "JSON schema browser checks require a disposable loopback installation",
  );
test.use({
  baseURL: web,
  storageState: state,
  viewport: { width: 1440, height: 1000 },
});

let workspaceId: string | undefined;
async function call(
  context: BrowserContext,
  method: string,
  path: string,
  data?: unknown,
) {
  const url = new URL(`${api}/api/internal/v1${path}`);
  if (workspaceId && path.includes("/databases"))
    url.searchParams.set("workspaceId", workspaceId);
  const payload =
    data && workspaceId && path.includes("/databases")
      ? { ...data, workspaceId }
      : data;
  const response = await context.request.fetch(url.href, {
    method,
    headers: { Origin: web, "Idempotency-Key": randomUUID() },
    ...(payload ? { data: payload } : {}),
  });
  const result = await response.json();
  if (!response.ok())
    throw new Error(
      `${method} ${path}: HTTP ${response.status()} ${result.error?.message}`,
    );
  return result;
}

test("JSON schemas validate edits, preview saved rows, clear constraints and render in both themes", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await mkdir(evidence, { recursive: true });
  const orgId = (await call(context, "GET", "/context")).organisation.id;
  workspaceId = (
    await call(context, "GET", `/orgs/${orgId}/workspaces`)
  ).data.find((workspace: { isDefault: boolean }) => workspace.isDefault).id;
  const databaseId = (
    await call(context, "POST", `/orgs/${orgId}/databases`, {
      name: `JSON schema review ${randomUUID().slice(0, 6)}`,
    })
  ).id;
  const parent = `/orgs/${orgId}/databases/${databaseId}`;
  const schema = await call(context, "POST", `${parent}/tables`, {
    name: "JSON validation",
    fields: [
      { name: "CODE", type: "text" },
      { name: "DATA", type: "json" },
    ],
  });
  const path = `${parent}/tables/${schema.table.id}`;
  const row = (
    await call(context, "POST", `${path}/rows`, {
      expectedSchemaVersion: 1,
      values: {
        CODE: "example",
        DATA: { name: "Rootset", tags: ["database"], extra: true },
      },
    })
  ).row;
  const route = `/databases/${databaseId}/tables/${schema.table.id}`;
  const source =
    "z.object({\n  name: z.string().min(1),\n  tags: z.array(z.string()).max(10).optional()\n})";
  async function openField() {
    await page.goto(`${route}/settings/fields?workspaceId=${workspaceId}`);
    await page
      .getByRole("row")
      .filter({ hasText: "DATA" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    return page.getByRole("dialog", { name: "Edit DATA", exact: true });
  }
  async function save() {
    await page
      .getByRole("button", { name: "Preview and apply changes", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Apply this field change?" })
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Edit DATA", exact: true }),
    ).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (await call(context, "GET", `${path}/schema`)).fields.find(
            (field: { name: string }) => field.name === "DATA",
          ).zodSchema,
      )
      .toBeNull();
  }
  let dialog = await openField();
  await dialog
    .getByLabel("Zod schema", { exact: true })
    .fill("z.string().transform(String)");
  await dialog
    .getByLabel("Zod schema", { exact: true })
    .press("ControlOrMeta+Enter");
  await expect(dialog.getByText(/Invalid Zod schema/)).toBeVisible();
  await dialog.getByLabel("Zod schema", { exact: true }).fill(source);
  await dialog
    .getByRole("button", { name: "Preview and apply changes", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Apply this field change?" })
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        (await call(context, "GET", `${path}/schema`)).fields[1].zodSchema,
    )
    .toBe(source);
  expect((await call(context, "GET", `${path}/rows/${row.id}`)).values).toEqual(
    row.values,
  );

  await page.goto(`${route}?workspaceId=${workspaceId}`);
  const dataCell = page.locator(
    `[data-row-id="${row.id}"] > [aria-colindex="4"]`,
  );
  await dataCell.dblclick();
  const editor = page.getByRole("textbox", { name: "DATA", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill('{"name":1}');
  await editor.press("ControlOrMeta+Enter");
  await expect(page.getByText(/Field DATA at name:/).first()).toBeVisible();
  expect((await call(context, "GET", `${path}/rows/${row.id}`)).version).toBe(
    row.version,
  );
  await dataCell.dblclick();
  await expect(editor).toBeVisible();
  await editor.fill('{"name":"Edited", "tags":[], "extra":true}');
  await editor.press("ControlOrMeta+Enter");
  await expect
    .poll(
      async () =>
        (await call(context, "GET", `${path}/rows/${row.id}`)).values.DATA,
    )
    .toEqual({ name: "Edited", tags: [], extra: true });

  for (const theme of ["light", "dark"]) {
    for (const [label, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      dialog = await openField();
      const themeButton = page.getByRole("button", {
        name: `Appearance: switch to ${theme} theme`,
        exact: true,
      });
      if (await themeButton.count()) {
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await themeButton.click();
        dialog = await openField();
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(
        dialog.getByLabel("Zod schema", { exact: true }),
      ).toHaveValue(source);
      await expect
        .poll(() =>
          dialog.evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await page.screenshot({
        path: resolve(evidence, `json-schema-${theme}-${label}.png`),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  dialog = await openField();
  await dialog
    .getByLabel("Zod schema", { exact: true })
    .fill("z.strictObject({ name: z.string() })");
  await dialog
    .getByRole("button", { name: "Preview and apply changes", exact: true })
    .click();
  await expect(
    page.getByText("The field change cannot be applied.", { exact: true }),
  ).toBeVisible();
  expect(
    (await call(context, "GET", `${path}/schema`)).fields[1].zodSchema,
  ).toBe(source);
  await dialog.getByLabel("Zod schema", { exact: true }).fill("");
  await save();
  const current = await call(context, "GET", `${path}/schema`);
  await call(context, "POST", `${path}/rows`, {
    expectedSchemaVersion: current.table.schemaVersion,
    values: { CODE: "unconstrained", DATA: { arbitrary: [true, 1] } },
  });
  // Leave an active schema and original record ready for local review.
  const updated = await call(
    context,
    "PATCH",
    `${path}/fields/${schema.fields[1].id}`,
    {
      expectedSchemaVersion: current.table.schemaVersion,
      field: {
        name: "DATA",
        type: "json",
        zodSchema:
          "z.object({ name: z.string().optional(), arbitrary: z.array(z.union([z.boolean(), z.number()])).optional() })",
      },
    },
  );
  expect(updated).toBeTruthy();
  await writeFile(
    resolve(evidence, "fixture.json"),
    JSON.stringify({
      route: `${route}/settings/fields?workspaceId=${workspaceId}`,
      workspaceId,
      databaseId,
      tableId: schema.table.id,
      rowId: row.id,
    }),
  );
  expect(pageErrors).toEqual([]);
});
