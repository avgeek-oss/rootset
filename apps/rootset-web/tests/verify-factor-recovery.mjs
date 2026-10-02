import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHmac } from "node:crypto";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url),
  privatePath = new URL("security-private.json", output);
const credentials = parseEnv(
  await readFile(
    new URL("../.env.security-browser-test", import.meta.url),
    "utf8",
  ),
);
const privateData = JSON.parse(await readFile(privatePath, "utf8"));
const browser = await chromium.launch(),
  context = await browser.newContext({ baseURL }),
  page = await context.newPage();
const report = {
  browser: "chromium",
  source:
    "Actual rendered recovery-code rotation, one-use login, passkey removal and factor disable for isolated Admin",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
function totp(uri) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const secret = new URL(uri).searchParams.get("secret");
  const bits = [...secret.replace(/=+$/, "").toUpperCase()]
    .map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest(),
    offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
async function credentialsForm() {
  await page.goto("/login");
  await page
    .getByRole("textbox", { name: /^Email address/ })
    .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
  await page
    .getByLabel(/^Password/)
    .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function security() {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Security", exact: true })
    .click();
  await page
    .getByLabel("Current password for factor changes", { exact: true })
    .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
}
async function approve() {
  const dialog = page.getByRole("dialog", {
    name: "Approve account action",
    exact: true,
  });
  await expect(dialog.locator(".action-review")).toContainText(
    "Requested changes",
  );
  await dialog
    .getByRole("button", { name: "Approve action", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
async function logout() {
  if (await page.locator(".rootset-settings").isVisible())
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/login", { waitUntil: "load" });
  await expect(
    page.getByRole("heading", { name: "Sign in to Rootset", exact: true }),
  ).toBeVisible();
}
async function recovery(code) {
  await credentialsForm();
  await page
    .getByRole("button", { name: "Use a recovery code", exact: true })
    .click();
  await page.getByLabel(/^Recovery code/).fill(code);
  await page
    .getByRole("button", { name: "Verify and sign in", exact: true })
    .click();
}
await mkdir(output, { recursive: true });
try {
  if (!privateData.totpUri)
    throw new Error("Run the isolated TOTP enrollment proof first.");
  const period = Math.floor(Date.now() / 30000);
  while (Math.floor(Date.now() / 30000) <= period)
    await page.waitForTimeout(1000);
  await credentialsForm();
  await page.getByLabel(/^Verification code/).fill(totp(privateData.totpUri));
  await page
    .getByRole("button", { name: "Verify and sign in", exact: true })
    .click();
  await expect(page.locator(".rootset-shell")).toBeVisible();
  await security();
  await page
    .getByRole("button", { name: "Generate replacement codes", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Replace recovery codes?", exact: true })
    .getByRole("button", { name: "Replace codes", exact: true })
    .click();
  await approve();
  const codes = await page
    .locator(".settings-recovery-codes code")
    .allTextContents();
  expect(codes.length).toBeGreaterThanOrEqual(2);
  privateData.recoveryCodes = codes;
  await writeFile(privatePath, JSON.stringify(privateData), { mode: 0o600 });
  await page
    .getByRole("button", { name: "Dismiss codes", exact: true })
    .click();
  report.checks.push({
    name: "Rendered recovery-code replacement is approved and one-time codes are privately saved then dismissed",
    status: "passed",
  });
  const passkeys = await (
    await context.request.get("/api/internal/v1/me/security")
  ).json();
  if (passkeys.passkeys.length) {
    await page
      .locator(".settings-record")
      .filter({
        has: page.getByRole("button", { name: "Remove", exact: true }),
      })
      .first()
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Remove passkey?", exact: true })
      .getByRole("button", { name: "Remove passkey", exact: true })
      .click();
    await approve();
    await expect(page.locator(".settings-content")).toContainText(
      "Passkey removed.",
    );
    expect(
      (await (await context.request.get("/api/internal/v1/me/security")).json())
        .passkeys.length,
    ).toBe(passkeys.passkeys.length - 1);
    report.checks.push({
      name: "Rendered approved passkey removal deletes the selected persisted credential",
      status: "passed",
    });
  }
  await logout();
  await recovery(codes[0]);
  await expect(page.locator(".rootset-shell")).toBeVisible();
  await logout();
  await recovery(codes[0]);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
  await expect(page.locator(".rootset-shell")).not.toBeVisible();
  await page.getByLabel(/^Recovery code/).fill(codes[1]);
  await page
    .getByRole("button", { name: "Verify and sign in", exact: true })
    .click();
  await expect(page.locator(".rootset-shell")).toBeVisible();
  report.checks.push({
    name: "Real rendered recovery login accepts an unused code once, rejects replay and accepts a different unused code",
    status: "passed",
  });
  await security();
  await page
    .getByRole("button", { name: "Disable authenticator", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "Disable two-factor authentication?",
      exact: true,
    })
    .getByRole("button", { name: "Disable factor", exact: true })
    .click();
  await approve();
  await expect(
    page.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeVisible();
  const state = await (
    await context.request.get("/api/internal/v1/me/security")
  ).json();
  expect(state.twoFactorEnabled).toBe(false);
  delete privateData.totpUri;
  delete privateData.recoveryCodes;
  await writeFile(privatePath, JSON.stringify(privateData), { mode: 0o600 });
  await logout();
  await credentialsForm();
  await expect(page.locator(".rootset-shell")).toBeVisible();
  report.checks.push({
    name: "Approved factor disable changes persisted state and rendered password login no longer asks for a code",
    status: "passed",
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
} finally {
  await writeFile(
    new URL("chromium-factor-recovery-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
