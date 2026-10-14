import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { Pool } from "pg";

const api = process.env.ROOTSET_API_URL;
const web = process.env.ROOTSET_WEB_URL;
assert(
  api && web && process.env.ROOTSET_SECRET,
  "Load a disposable .env.test first",
);
for (const value of [api, web])
  assert(
    ["localhost", "127.0.0.1"].includes(new URL(value).hostname),
    "Only disposable loopback fixtures are allowed",
  );
const destination = new URL(
  "../../../verification/row-comments/",
  import.meta.url,
);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const email = "row-comments@example.test",
  password = "Local comments fixture 2026!";
const errors = [];
async function request(path, method = "GET", body) {
  const idempotencyKey = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await context.request.fetch(`${api}${path}`, {
      method,
      ...(body === undefined ? {} : { data: body }),
      headers: { Origin: web, "Idempotency-Key": idempotencyKey },
    });
    if (response.status() === 429 && attempt < 2) {
      const result = await response.json();
      const seconds = Number(result.error?.details?.retryAfter ?? 60);
      assert(
        seconds > 0 && seconds <= 60,
        "Expected a bounded rate-limit retry",
      );
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }
    assert(
      response.ok(),
      `${path}: ${response.status()} ${await response.text()}`,
    );
    return response.json();
  }
}
try {
  const setup = await request("/v1/setup");
  if (!setup.claimed)
    await request("/v1/setup", "POST", {
      bootstrapSecret: process.env.ROOTSET_SECRET,
      name: "Alex Morgan",
      email,
      password,
      organisationName: "Fleet operations demo",
    });
  await request("/v1/auth/sign-in/email", "POST", { email, password });
  const me = await request("/api/internal/v1/context");
  const orgId = me.organisation.id;
  const orgPath = `/api/internal/v1/orgs/${orgId}`;
  const database = await request(`${orgPath}/databases`, "POST", {
    name: `Fleet review ${new Date().toISOString().slice(11, 19)}`,
  });
  const dbPath = `${orgPath}/databases/${database.id}`;
  const schema = await request(`${dbPath}/tables`, "POST", {
    name: "Aircraft register",
    fields: [
      { name: "REGISTRATION", type: "text", charLimit: 40 },
      { name: "AIRCRAFT", type: "text", charLimit: 120 },
      { name: "BASE", type: "text", charLimit: 40 },
      { name: "STATUS", type: "text", charLimit: 80 },
      { name: "REVIEWED", type: "date" },
    ],
  });
  const table = schema.table;
  const tablePath = `${dbPath}/tables/${table.id}`;
  const added = await request(`${tablePath}/rows/batch`, "POST", {
    expectedSchemaVersion: table.schemaVersion,
    mutations: Array.from({ length: 260 }, (_, index) => ({
      type: "create",
      values: {
        REGISTRATION: `VT-${String(index + 1).padStart(3, "0")}`,
        AIRCRAFT: [
          "Airbus A320neo",
          "Boeing 737 MAX 8",
          "ATR 72-600",
          "Airbus A350-900",
        ][index % 4],
        BASE: ["Bengaluru", "Delhi", "Mumbai", "Hyderabad"][index % 4],
        STATUS: index % 7 === 0 ? "Review due" : "Verified",
        REVIEWED: "2026-10-14",
      },
    })),
  });
  const rows = added.results.map((result) => result.row);
  for (const body of [
    "The registration and operator match the latest fleet list.",
    "Please confirm the base before closing this review.",
    "Plain text stays plain: <strong>no HTML</strong>.",
  ])
    await request(`${tablePath}/rows/${rows[0].id}/comments`, "POST", { body });
  for (let index = 0; index < 51; index++)
    await request(`${tablePath}/rows/${rows[1].id}/comments`, "POST", {
      body: `Review note ${index + 1}: checked against the operations register.`,
    });
  const url = `${web}/databases/${database.id}/tables/${table.id}`;
  await writeFile(
    new URL("fixture.json", destination),
    JSON.stringify(
      {
        orgId,
        databaseId: database.id,
        tableId: table.id,
        rowIds: rows.map((row) => row.id),
        url,
        email,
        password,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await context.storageState({
    path: new URL("session.json", destination).pathname,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  page.on("request", (req) => {
    if (/\/comments(?:\?|\/|$)/.test(req.url()))
      requests.push({
        url: req.url(),
        method: req.method(),
        body: req.postDataJSON(),
      });
  });
  await page.goto(url);
  const trigger = page.getByRole("button", {
    name: "Row 1 comments, 3",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  const registration = page.getByRole("gridcell", {
    name: "VT-001",
    exact: true,
  });
  await registration.click();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("VT-001\n");
  await registration.dblclick();
  await page
    .getByRole("group", { name: "Edit REGISTRATION", exact: true })
    .getByRole("textbox")
    .fill("VT-EDITED");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("gridcell", { name: "VT-EDITED", exact: true }),
  ).toBeVisible();
  assert.equal(
    (await request(`${tablePath}/rows/${rows[0].id}`)).values.REGISTRATION,
    "VT-EDITED",
  );
  assert(
    requests
      .filter((req) => req.url.includes("/comments/counts"))
      .every((req) => req.body.rowIds.length <= 200),
  );
  assert.equal(
    requests.filter(
      (req) => req.method === "GET" && req.url.includes("/comments"),
    ).length,
    0,
    "Bodies stay lazy until opening a discussion",
  );
  await page.screenshot({
    animations: "disabled",
    path: new URL("grid-light.png", destination).pathname,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Row 1 comments" }) });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Plain text stays plain: <strong>no HTML</strong>.", {
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(await dialog.locator("strong").count(), 0);
  await page.screenshot({
    animations: "disabled",
    path: new URL("discussion-light.png", destination).pathname,
  });
  await dialog
    .getByLabel("Add a comment", { exact: true })
    .fill("Keyboard verification comment");
  await page.keyboard.press("Control+Enter");
  await expect(
    dialog.getByText("Keyboard verification comment", { exact: true }),
  ).toBeVisible();
  const created = dialog
    .getByRole("article")
    .filter({ hasText: "Keyboard verification comment" });
  await created
    .getByRole("button", { name: "Delete comment by Alex Morgan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await expect(
    dialog.getByText("Keyboard verification comment", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Close dialog", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // A failed request preserves the draft and reuses the same retry key.
  await trigger.click();
  await page.route("**/comments", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Fixture failure. Retry the comment.",
            },
          }),
        })
      : route.continue(),
  );
  await dialog
    .getByLabel("Add a comment", { exact: true })
    .fill("Preserved draft");
  await dialog
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Fixture failure");
  await expect(dialog.getByLabel("Add a comment", { exact: true })).toHaveValue(
    "Preserved draft",
  );
  await page.unroute("**/comments");
  await dialog
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(
    dialog.getByText("Preserved draft", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close dialog", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Row 2 comments, 51", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Next comments", exact: true })
    .click();
  await expect(
    page.getByText("Review note 51: checked against the operations register.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Comments on this page", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Close dialog", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const nativeURL = new URL(process.env.ROOTSET_TEST_DATABASE_URL);
  assert(
    ["localhost", "127.0.0.1"].includes(nativeURL.hostname) &&
      nativeURL.port === "55468" &&
      nativeURL.pathname === "/rootset",
    "Use the dedicated comment fixture database",
  );
  const pool = new Pool({ connectionString: nativeURL.toString() });
  try {
    await pool.query(
      "UPDATE rootset_control.memberships SET role='viewer',version=version+1 WHERE org_id=$1 AND user_id=$2",
      [orgId, me.principal.userId],
    );
    await page.reload();
    await page.getByRole("button", { name: /^Row 1 comments,/ }).click();
    await expect(
      page.getByText("Preserved draft", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Add a comment", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", {
        name: "Delete comment by Alex Morgan",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await pool.query(
      "UPDATE rootset_control.memberships SET role='admin',version=version+1 WHERE org_id=$1 AND user_id=$2",
      [orgId, me.principal.userId],
    );
    await pool.end();
  }
  await context.close();

  for (const colorScheme of ["light", "dark"]) {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme,
      storageState: new URL("session.json", destination).pathname,
    });
    const phone = await mobile.newPage();
    phone.on("pageerror", (error) => errors.push(error.message));
    await phone.goto(url);
    await phone.getByRole("button", { name: /^Row 1 comments,/ }).tap();
    await expect(
      phone.getByRole("heading", { name: "Row 1 comments" }),
    ).toBeVisible();
    await expect(
      phone.getByLabel("Add a comment", { exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByText("Preserved draft", { exact: true }),
    ).toBeVisible();
    const bounds = await phone
      .getByRole("dialog")
      .filter({ has: phone.getByRole("heading", { name: "Row 1 comments" }) })
      .boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
    await phone.screenshot({
      animations: "disabled",
      path: new URL(`discussion-mobile-${colorScheme}.png`, destination)
        .pathname,
    });
    await mobile.close();
  }
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    storageState: new URL("session.json", destination).pathname,
  });
  const dark = await desktop.newPage();
  await dark.goto(url);
  await dark.getByRole("button", { name: /^Row 1 comments,/ }).click();
  await expect(
    dark.getByRole("heading", { name: "Row 1 comments" }),
  ).toBeVisible();
  await expect(
    dark.getByText("Preserved draft", { exact: true }),
  ).toBeVisible();
  await dark.screenshot({
    animations: "disabled",
    path: new URL("discussion-dark.png", destination).pathname,
  });
  await desktop.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      url,
      rows: 260,
      checks: [
        "bounded lazy counts",
        "clipboard and inline editing",
        "keyboard opening and focus return",
        "plain text",
        "create/delete",
        "draft retry",
        "pagination",
        "viewer permissions",
        "touch",
        "desktop/mobile light/dark",
      ],
      screenshots: destination.pathname,
    }),
  );
} finally {
  await browser.close();
}
