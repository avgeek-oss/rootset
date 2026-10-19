import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const web = process.env.ROOTSET_DOCS_WEB_URL ?? "http://localhost:4300";
const api = process.env.ROOTSET_DOCS_API_URL ?? "http://localhost:4310";
if (
  ![web, api].every((url) =>
    ["localhost", "127.0.0.1"].includes(new URL(url).hostname),
  )
)
  throw new Error(
    "Documentation captures require a disposable localhost installation.",
  );
const credentialsPath = process.env.ROOTSET_DOCS_CREDENTIALS_FILE;
if (!credentialsPath)
  throw new Error(
    "Set ROOTSET_DOCS_CREDENTIALS_FILE to a protected fixture credential file.",
  );
const credentials = parseEnv(await readFile(credentialsPath, "utf8"));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const output = path.join(root, "docs/assets/screenshots");
await mkdir(output, { recursive: true });
async function call(method, endpoint, data) {
  const response = await context.request.fetch(
    api + "/api/internal/v1" + endpoint,
    {
      method,
      headers: { Origin: web, "Idempotency-Key": randomUUID() },
      ...(data ? { data } : {}),
    },
  );
  if (!response.ok())
    throw new Error(
      `${method} ${endpoint}: ${response.status()} ${await response.text()}`,
    );
  return response.json();
}
async function capture(name) {
  const zoom = await page.evaluate(
    () => getComputedStyle(document.documentElement).zoom,
  );
  if (!["1", "normal"].includes(zoom))
    throw new Error(`Unexpected page zoom: ${zoom}`);
  await page
    .getByRole("link", { name: "Account Settings", exact: true })
    .first()
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const captureStyle = await page.addStyleTag({
    content: "nextjs-portal { display: none !important; }",
  });
  await page.screenshot({
    path: path.join(output, name + ".png"),
    type: "png",
    animations: "disabled",
  });
  await captureStyle.evaluate((element) => element.remove());
  console.log(`Captured ${name}: 2560×1600 PNG`);
}
try {
  const login = await context.request.post(api + "/v1/auth/sign-in/email", {
    headers: { Origin: web },
    data: {
      email: credentials.ROOTSET_TEST_OWNER_EMAIL,
      password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
    },
  });
  if (!login.ok() || (await login.json()).twoFactorRedirect)
    throw new Error("Fixture sign-in failed.");
  const me = await call("GET", "/context");
  const org = me.organisation.id;
  const orgPath = `/orgs/${org}`;
  const databases = await call("GET", orgPath + "/databases");
  const db =
    databases.data.find((db) => db.name === "Product catalog") ??
    (await call("POST", orgPath + "/databases", {
      name: "Product catalog",
      description: "Sample products for the Rootset documentation.",
    }));
  const dbPath = orgPath + `/databases/${db.id}`;
  const tables = await call("GET", dbPath + "/tables");
  const existing = tables.data.find((table) => table.name === "Products");
  const schema = existing
    ? await call("GET", dbPath + `/tables/${existing.id}/schema`)
    : await call("POST", dbPath + "/tables", {
        name: "Products",
        description: "A synthetic product catalog.",
        fields: [
          { name: "NAME", type: "text", required: true, charLimit: 80 },
          { name: "SKU", type: "text", required: true, charLimit: 24 },
          { name: "STOCK", type: "integer", min: 0, max: 10000 },
          { name: "PRICE", type: "float", min: 0, max: 10000 },
          { name: "ACTIVE", type: "boolean", default: true },
          { name: "UPDATED", type: "date-time" },
          { name: "DETAILS", type: "json" },
        ],
      });
  const table = schema.table;
  const tablePath = dbPath + `/tables/${table.id}`;
  if (table.rowCount === 0) {
    const products = [
      "Field notebook",
      "Canvas tote",
      "Desk lamp",
      "Travel mug",
      "Pen set",
      "Laptop stand",
      "Wall calendar",
      "Cable organiser",
      "Coffee grinder",
      "Water bottle",
      "Reading light",
      "Tool roll",
      "Sketch pad",
      "Desk mat",
      "Storage tray",
      "Bookend",
      "Phone stand",
      "Pencil case",
      "Tea infuser",
      "Travel pouch",
      "Key holder",
      "Document sleeve",
      "Picture frame",
      "Plant pot",
    ];
    for (let i = 0; i < products.length; i++)
      await call("POST", tablePath + "/rows", {
        expectedSchemaVersion: table.schemaVersion,
        values: {
          NAME: products[i],
          SKU: `RS-${String(i + 1).padStart(4, "0")}`,
          STOCK: 12 + i * 3,
          PRICE: Math.round((9.5 + i * 2.75) * 100) / 100,
          ACTIVE: i % 5 !== 0,
          UPDATED: "2026-10-09T09:30:00.000Z",
          DETAILS: {
            category: i % 2 ? "Office" : "Everyday",
            material: i % 2 ? "Aluminium" : "Cotton",
          },
        },
      });
  }
  const href = `/databases/${db.id}/tables/${table.id}`;
  for (const theme of ["light", "dark"]) {
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    await page.goto(web + href);
    await page.getByRole("grid", { name: "Products spreadsheet" }).waitFor();
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    await page
      .getByRole("gridcell", { name: "Field notebook", exact: true })
      .waitFor();
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      await page
        .getByRole("button", {
          name: `Appearance: switch to ${theme} theme`,
          exact: true,
        })
        .click();
      await page.waitForFunction(
        (value) => document.documentElement.dataset.theme === value,
        theme,
      );
    }
    await capture("rows-" + theme);
    await page
      .getByRole("gridcell", { name: "RS-0001", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "View cell history", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    await capture("cell-history-" + theme);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: /Field for condition 1/ }).click();
    await page.getByRole("option", { name: "NAME", exact: true }).click();
    await page
      .getByRole("textbox", { name: /Value for condition 1/ })
      .fill("notebook");
    await capture("filters-" + theme);
    await page.keyboard.press("Escape");
    await page.goto(web + href + "/settings/fields");
    await page
      .getByRole("button", { name: "Add field", exact: true })
      .waitFor();
    await capture("fields-" + theme);
    await page.getByRole("button", { name: "Add field", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await capture("field-editor-" + theme);
    await page.keyboard.press("Escape");
    await page.goto(web + href + "/settings/rules");
    await page
      .getByRole("button", { name: "Create unique rule", exact: true })
      .first()
      .waitFor();
    await capture("unique-rules-" + theme);
    await page
      .getByRole("button", { name: "Create unique rule", exact: true })
      .first()
      .click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: /Fields/ }).click();
    await page.getByRole("option", { name: "SKU", exact: true }).click();
    await page.keyboard.press("Escape");
    await capture("unique-rule-editor-" + theme);
    await page.keyboard.press("Escape");
    await page.goto(web + href + "/settings/export-requests");
    await page
      .getByRole("button", { name: "Create export request", exact: true })
      .first()
      .waitFor();
    await capture("exports-" + theme);
    await page
      .getByRole("button", { name: "Create export request", exact: true })
      .first()
      .click();
    await page.getByRole("dialog").waitFor();
    await capture("export-editor-" + theme);
    await page.keyboard.press("Escape");
    await page.goto(web + `/databases/${db.id}`);
    await page
      .getByRole("button", { name: "Create Table", exact: false })
      .waitFor();
    await capture("tables-" + theme);
    await page.goto(web + "/settings/api-keys");
    await page
      .getByRole("button", { name: "Create API key", exact: false })
      .waitFor();
    await capture("api-keys-" + theme);
    await page
      .getByRole("button", { name: "Create API key", exact: true })
      .first()
      .click();
    await page.getByRole("dialog").waitFor();
    await capture("api-key-editor-" + theme);
    await page.keyboard.press("Escape");
    await page.goto(web + "/team-settings/api-keys");
    await page
      .getByRole("heading", { name: "API Keys", exact: true })
      .waitFor();
    await capture("team-api-keys-" + theme);
    await page.goto(web + "/settings/mcp");
    await page
      .getByRole("heading", { name: "MCP Guide", exact: true })
      .waitFor();
    await capture("mcp-guide-" + theme);
    await page.goto(web + "/settings/mcp-connections");
    await page
      .getByRole("heading", { name: "MCP Connections", exact: true })
      .waitFor();
    await capture("mcp-connections-" + theme);
    await page.goto(web + "/settings/profile");
    await page.getByRole("heading", { name: "Profile", exact: true }).waitFor();
    await capture("profile-" + theme);
    await page.goto(web + "/team-settings/members");
    await page.getByRole("heading", { name: "Members", exact: true }).waitFor();
    await capture("team-access-" + theme);
  }
  await writeFile(
    path.join(output, "capture.json"),
    JSON.stringify(
      {
        sourceRevision: process.env.ROOTSET_DOCS_SOURCE_REVISION,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        zoom: 1,
        format: "png",
        dataset: "Disposable synthetic Product catalog fixture",
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
