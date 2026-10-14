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
  "../../../verification/row-comments/comment-drawer/",
  import.meta.url,
);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const email = process.env.ROOTSET_REVIEW_EMAIL ?? "row-comments@example.test",
  password =
    process.env.ROOTSET_REVIEW_PASSWORD ?? "Local comments fixture 2026!";
const errors = [];
let originalTheme;
async function expectDrawerLayout(page, rowNumber) {
  const drawer = page.getByRole("dialog", {
    name: `Row ${rowNumber} comments`,
    exact: true,
  });
  const viewport = page.viewportSize();
  await expect
    .poll(async () => {
      const bounds = await drawer.boundingBox();
      return (
        bounds &&
        Math.abs(bounds.x + bounds.width - viewport.width) < 1 &&
        bounds.y === 0 &&
        Math.abs(bounds.height - viewport.height) < 1 &&
        bounds.width === Math.min(440, viewport.width)
      );
    })
    .toBe(true);
  const close = await drawer
    .getByRole("button", { name: "Close comments", exact: true })
    .boundingBox();
  assert(close && viewport.width - (close.x + close.width) <= 24);
  return drawer;
}

async function expectPinnedComposer(page, drawer) {
  const body = drawer.locator(".row-discussion");
  const composer = drawer.locator(".row-comment-composer");
  const header = drawer.getByRole("heading");
  const composerBefore = await composer.boundingBox();
  const headerBefore = await header.boundingBox();
  await body.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  assert.deepEqual(await composer.boundingBox(), composerBefore);
  assert.deepEqual(await header.boundingBox(), headerBefore);
  await expect(
    composer.getByRole("button", { name: "Add comment", exact: true }),
  ).toBeVisible();
}

async function expectStableSorting(page, tableId, colorScheme) {
  const grid = page.getByRole("grid", {
    name: "Aircraft register spreadsheet",
  });
  const header = grid.getByRole("columnheader", {
    name: "AIRCRAFT",
    exact: true,
  });
  const container = page.locator(".grid-container");
  await expect(container).toHaveAttribute("aria-busy", "false");
  const bounds = await grid.boundingBox();
  for (const direction of ["ascending", "descending", null]) {
    let intercepted = false;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/tables/${tableId}/windows/query`,
      async (route) => {
        intercepted = true;
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await header.click();
      await expect.poll(() => intercepted).toBe(true);
      await expect(container).toHaveAttribute("aria-busy", "true");
      await expect(page.getByText(/These are previous results/)).toHaveCount(0);
      assert.deepEqual(await grid.boundingBox(), bounds);
      if (direction) {
        await expect(header).toHaveAttribute("aria-sort", direction);
        const headerBounds = await header.boundingBox();
        const arrowBounds = await header
          .locator(".rdg-sort-arrow")
          .boundingBox();
        assert(
          arrowBounds &&
            Math.abs(
              arrowBounds.y +
                arrowBounds.height / 2 -
                (headerBounds.y + headerBounds.height / 2),
            ) <= 1,
        );
        if (direction === "ascending")
          await page.screenshot({
            animations: "disabled",
            path: new URL(`sorting-pending-${colorScheme}.png`, destination)
              .pathname,
          });
      } else {
        await expect(header.locator(".rdg-sort-arrow")).toHaveCount(0);
      }
    } finally {
      release();
    }
    await expect(container).toHaveAttribute("aria-busy", "false");
    assert.deepEqual(await grid.boundingBox(), bounds);
  }
}

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
  originalTheme = me.preferences.theme;
  await request("/api/internal/v1/me/preferences", "PATCH", {
    theme: "system",
  });
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
    name: "Row 1 comments, has comments",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  const rowNumberCell = page.getByRole("gridcell").filter({ has: trigger });
  await expect(rowNumberCell.locator(".row-number-content > span")).toHaveText(
    "1",
  );
  await expect(rowNumberCell).toHaveAttribute("aria-colindex", "1");
  const filledIcon = await trigger.locator("svg").evaluate((icon) => ({
    color: getComputedStyle(icon).color,
    fill: getComputedStyle(icon).fill,
  }));
  assert.equal(filledIcon.fill, filledIcon.color);
  const mutedIcon = page
    .getByRole("button", { name: "Row 3 comments, no comments", exact: true })
    .locator("svg");
  await expect(mutedIcon).toHaveCSS("fill", "none");
  assert.notEqual(
    await mutedIcon.evaluate((icon) => getComputedStyle(icon).color),
    filledIcon.color,
  );
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
  assert.equal(
    requests.filter((req) => req.url.includes("/comments/counts")).length,
    0,
  );
  await expect(trigger).toHaveAttribute("data-has-comments", "true");
  await page.keyboard.press("Control+z");
  await expect(
    page.getByRole("gridcell", { name: "VT-001", exact: true }),
  ).toBeVisible();
  await expect(trigger).toHaveAttribute("data-has-comments", "true");
  const grid = page.getByRole("grid", {
    name: "Aircraft register spreadsheet",
  });
  for (const close of await page.locator('[data-slot="toast-close"]').all())
    await close.click();
  await expect(page.locator('[data-slot="toast-close"]')).toHaveCount(0);
  await expect(grid).toHaveAttribute("aria-colcount", "6");
  await expect
    .poll(async () => {
      await grid.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return page
        .getByRole("button", {
          name: "Row 260 comments, no comments",
          exact: true,
        })
        .isVisible();
    })
    .toBe(true);
  await grid.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(trigger).toBeVisible();
  assert.equal(
    requests.filter((req) => req.url.includes("/comments/counts")).length,
    0,
  );
  assert.equal(
    requests.filter(
      (req) => req.method === "GET" && req.url.includes("/comments"),
    ).length,
    0,
    "Bodies stay lazy until opening a discussion",
  );
  await expectStableSorting(page, table.id, "light");
  await page.screenshot({
    animations: "disabled",
    path: new URL("grid-light.png", destination).pathname,
  });
  await page.clock.setFixedTime(Date.now() - 14_000);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Row 1 comments" }) });
  await expect(dialog).toBeVisible();
  await expectDrawerLayout(page, 1);
  await expect(
    dialog.getByText("Plain text stays plain: <strong>no HTML</strong>.", {
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(await dialog.locator("strong").count(), 0);
  await expect(dialog.getByLabel("Add a comment", { exact: true })).toHaveClass(
    /textarea--secondary/,
  );
  await expect(
    dialog.locator('[data-slot="avatar-fallback"]').first(),
  ).toHaveCSS("font-size", "12px");
  await page.screenshot({
    animations: "disabled",
    path: new URL("discussion-light.png", destination).pathname,
  });
  // Advance the browser clock between periodic ticks before creating a comment.
  await page.clock.setFixedTime(Date.now() + 5_000);
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
  await expect(created.locator("time")).toHaveText(/\d+ seconds? ago/);
  const originalCreatedAt = await created
    .locator("time")
    .getAttribute("datetime");
  await page.clock.setSystemTime(Date.now());
  await created
    .getByRole("button", { name: "Delete comment by Alex Morgan", exact: true })
    .click();
  await expect(
    page.getByText(
      "This permanently removes the comment’s content. The comment log will remain and cannot be removed.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: new URL("delete-confirmation.png", destination).pathname,
  });
  await page
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await expect(
    dialog.getByText("Keyboard verification comment", { exact: true }),
  ).toHaveCount(0);
  const deletedEntry = dialog
    .getByRole("article")
    .filter({ hasText: "comment deleted" });
  await expect(deletedEntry).toHaveCount(1);
  await expect(
    deletedEntry.getByText("Alex Morgan", { exact: true }),
  ).toBeVisible();
  await expect(deletedEntry.locator("time")).toHaveAttribute(
    "datetime",
    originalCreatedAt,
  );
  await expect(deletedEntry.getByRole("button")).toHaveCount(0);
  await expect(deletedEntry.locator(".row-comment-body")).toHaveCSS(
    "font-style",
    "italic",
  );
  assert.equal(
    await deletedEntry
      .locator(".row-comment-body")
      .evaluate((el) => getComputedStyle(el).color),
    await deletedEntry
      .locator("time")
      .evaluate((el) => getComputedStyle(el).color),
  );
  await page.screenshot({
    animations: "disabled",
    path: new URL("deleted-comment-light.png", destination).pathname,
  });
  await expect(
    page.getByRole("button", { name: "Close comments", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const emptyTrigger = page.getByRole("button", {
    name: "Row 3 comments, no comments",
    exact: true,
  });
  await page.clock.setFixedTime(Date.now() - 30_000);
  await emptyTrigger.click();
  const emptyDiscussion = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Row 3 comments", exact: true }),
  });
  await expect(
    emptyDiscussion.getByText("No comments yet. Start the discussion below."),
  ).toBeVisible();
  await emptyDiscussion
    .getByLabel("Add a comment", { exact: true })
    .fill("Only comment on this row");
  await emptyDiscussion
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(
    emptyDiscussion.getByText("Only comment on this row", { exact: true }),
  ).toBeVisible();
  await expect(emptyDiscussion.getByRole("article").locator("time")).toHaveText(
    "now",
  );
  await page.clock.setSystemTime(Date.now());
  await expect(
    page.getByRole("button", { name: "Close comments", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(emptyDiscussion).toHaveCount(0);
  const populatedTrigger = page.getByRole("button", {
    name: "Row 3 comments, has comments",
    exact: true,
  });
  await expect(populatedTrigger).toHaveAttribute("data-has-comments", "true");
  await populatedTrigger.click();
  await emptyDiscussion
    .getByRole("button", { name: "Delete comment by Alex Morgan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await expect(
    emptyDiscussion.getByText("comment deleted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close comments", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(emptyDiscussion).toHaveCount(0);
  await expect(populatedTrigger).toHaveAttribute("data-has-comments", "true");
  await populatedTrigger.click();
  await expect(
    emptyDiscussion.getByText("comment deleted", { exact: true }),
  ).toBeVisible();
  await expect(
    emptyDiscussion.getByText("Only comment on this row", { exact: true }),
  ).toHaveCount(0);
  await expect(
    emptyDiscussion.getByRole("article").getByRole("button"),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(emptyDiscussion).toHaveCount(0);
  assert.equal(
    requests.filter((req) => req.url.includes("/comments/counts")).length,
    0,
  );
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
    page.getByRole("button", { name: "Close comments", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Row 2 comments, has comments", exact: true })
    .click();
  const longDiscussion = await expectDrawerLayout(page, 2);
  await expect(longDiscussion.getByRole("article")).toHaveCount(50);
  await expectPinnedComposer(page, longDiscussion);
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
  await page
    .getByRole("article")
    .filter({ hasText: "Review note 51:" })
    .getByRole("button", { name: "Delete comment by Alex Morgan", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await expect(
    longDiscussion.getByText("comment deleted", { exact: true }),
  ).toBeVisible();
  await expect(longDiscussion.getByRole("article")).toHaveCount(1);
  await expect(
    longDiscussion.getByRole("article").getByRole("button"),
  ).toHaveCount(0);
  await expect(
    longDiscussion.getByText(
      "Review note 51: checked against the operations register.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Close comments", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Row 2 comments, has comments",
      exact: true,
    }),
  ).toHaveAttribute("data-has-comments", "true");
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
    // Give the remaining browser contexts a fresh quota in this disposable fixture.
    await pool.query(
      "DELETE FROM rootset_control.api_rate_windows WHERE principal=$1",
      [`user:${me.principal.userId}`],
    );
    await pool.end();
  }
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
    await expect(phone.locator("html")).toHaveClass(
      new RegExp(`\\b${colorScheme}\\b`),
    );
    await expect(
      phone.getByRole("heading", { name: "Row 1 comments" }),
    ).toBeVisible();
    await expect(
      phone.getByLabel("Add a comment", { exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByText("Preserved draft", { exact: true }),
    ).toBeVisible();
    await expect(phone.getByText("comment deleted", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await expectDrawerLayout(phone, 1);
    await expect(
      phone.getByLabel("Add a comment", { exact: true }),
    ).toHaveClass(/textarea--secondary/);
    await expect(
      phone.locator('[data-slot="avatar-fallback"]').first(),
    ).toHaveCSS("font-size", "12px");
    await phone.screenshot({
      animations: "disabled",
      path: new URL(`discussion-mobile-${colorScheme}.png`, destination)
        .pathname,
    });
    await phone
      .getByRole("button", { name: "Close comments", exact: true })
      .tap();
    await expect(phone.getByRole("dialog")).toHaveCount(0);
    await phone.getByRole("button", { name: /^Row 2 comments,/ }).tap();
    const longMobileDiscussion = await expectDrawerLayout(phone, 2);
    await expect(longMobileDiscussion.getByRole("article")).toHaveCount(50);
    const mobileBody = longMobileDiscussion.locator(".row-discussion");
    const composerBefore = await longMobileDiscussion
      .locator(".row-comment-composer")
      .boundingBox();
    const cdp = await mobile.newCDPSession(phone);
    const bodyBounds = await mobileBody.boundingBox();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: bodyBounds.x + 100, y: bodyBounds.y + 300 }],
    });
    for (let step = 1; step <= 6; step++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: bodyBounds.x + 100, y: bodyBounds.y + 300 - step * 40 },
        ],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => mobileBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    assert.deepEqual(
      await longMobileDiscussion.locator(".row-comment-composer").boundingBox(),
      composerBefore,
    );
    await cdp.detach();
    await mobile.close();
  }
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    storageState: new URL("session.json", destination).pathname,
  });
  const dark = await desktop.newPage();
  await dark.goto(url);
  await expect(
    dark.getByRole("button", { name: /^Row 1 comments,/ }),
  ).toBeVisible();
  await expectStableSorting(dark, table.id, "dark");
  await dark.getByRole("button", { name: /^Row 1 comments,/ }).click();
  await expect(dark.locator("html")).toHaveClass(/\bdark\b/);
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
  await dark
    .getByRole("button", { name: "Close comments", exact: true })
    .click();
  await expect(dark.getByRole("dialog")).toHaveCount(0);
  await dark.emulateMedia({ reducedMotion: "reduce" });
  await dark.getByRole("button", { name: /^Row 1 comments,/ }).click();
  const reducedDrawer = await expectDrawerLayout(dark, 1);
  await expect(reducedDrawer).toHaveCSS("transition-duration", "0s");
  await expect(dark.locator('[data-slot="drawer-backdrop"]')).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await desktop.close();
  assert.deepEqual(errors, []);
  assert.equal(
    requests.filter((req) => req.url.includes("/comments/counts")).length,
    0,
  );
  console.log(
    JSON.stringify({
      ok: true,
      url,
      rows: 260,
      countRequests: 0,
      commentBodyRequestsBeforeOpening: 0,
      checks: [
        "row-page presence with no count requests during scroll",
        "first comment fills the indicator and deleted entries retain it",
        "clipboard and inline editing",
        "stable grid bounds during sorting with centered ascending and descending arrows",
        "keyboard opening and focus return",
        "plain text",
        "create/delete",
        "fresh comment timestamps between clock ticks and with clock skew",
        "secondary composer and extra-small avatar initials",
        "draft retry",
        "pagination",
        "viewer permissions",
        "touch scrolling with pinned composer",
        "comments beside row numbers with muted and filled states",
        "right drawer with pinned composer and header",
        "reduced motion",
        "desktop/mobile light/dark",
      ],
      screenshots: destination.pathname,
    }),
  );
} finally {
  if (originalTheme)
    await request("/api/internal/v1/me/preferences", "PATCH", {
      theme: originalTheme,
    });
  await browser.close();
}
