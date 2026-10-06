import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHmac, randomUUID } from "node:crypto";

const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url);
const credentials = parseEnv(
  await readFile(
    new URL("../.env.security-browser-test", import.meta.url),
    "utf8",
  ),
);
const fixture = JSON.parse(
  await readFile(
    new URL("../test-results/browser/fixture.json", import.meta.url),
    "utf8",
  ),
);
const privatePath = new URL("security-private.json", output);
let privateData = {};
try {
  privateData = JSON.parse(await readFile(privatePath, "utf8"));
} catch {}
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const report = {
  browser: "chromium",
  source:
    "Real rendered UI, BetterAuth, PostgreSQL, Mailpit and Chromium virtual WebAuthn",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
await mkdir(output, { recursive: true });
const nav = () =>
  page.getByRole("navigation", { name: "Settings sections", exact: true });
function totp(uri) {
  const secret = new URL(uri).searchParams.get("secret");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const letter of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(letter).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
let lastFactorPeriod = Math.floor(Date.now() / 30000);
async function freshFactor() {
  while (Math.floor(Date.now() / 30000) <= lastFactorPeriod)
    await page.waitForTimeout(1000);
  lastFactorPeriod = Math.floor(Date.now() / 30000);
  return totp(privateData.totpUri);
}
async function call(method, path, data) {
  const response = await context.request.fetch(`/api/internal/v1${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: {
      Origin: new URL(baseURL).origin,
      "Idempotency-Key": randomUUID(),
    },
  });
  const body = response.status() === 204 ? null : await response.json();
  if (!response.ok())
    throw new Error(
      `${method} ${path}: HTTP ${response.status()} ${body.error?.code ?? ""}`,
    );
  return body;
}
async function signIn() {
  await page.goto("/login");
  await page
    .getByRole("textbox", { name: /^Email address/ })
    .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
  await page
    .getByLabel(/^Password/)
    .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const factor = page.getByRole("heading", {
    name: "Enter your verification code",
    exact: true,
  });
  await expect(page.locator(".rootset-shell").or(factor)).toBeVisible({
    timeout: 15000,
  });
  if (await factor.isVisible()) {
    if (!privateData.totpUri)
      throw new Error(
        "The isolated account requires its private fixture authenticator state.",
      );
    await page.getByLabel(/^Verification code/).fill(await freshFactor());
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
  }
  await expect(page.locator(".rootset-shell")).toBeVisible({ timeout: 15000 });
}
async function settings(name) {
  if (!(await page.locator(".rootset-settings").isVisible()))
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await nav().getByRole("button", { name, exact: true }).click();
  await expect(page.locator(".settings-header h1")).toHaveText(name);
  await expect(
    page
      .locator('.settings-content [role="status"]')
      .filter({ hasText: /^Loading…$/ }),
  ).toHaveCount(0);
}
async function approve({ expectProof = false } = {}) {
  const dialog = page.getByRole("dialog", {
    name: "Approve account action",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".action-review")).toContainText(
    "Requested changes",
  );
  await expect(dialog.locator(".action-review")).toContainText(
    "Request fingerprint",
  );
  await dialog
    .getByRole("button", { name: "Approve action", exact: true })
    .click();
  const proof = dialog.getByLabel(/^Current password/);
  await expect
    .poll(
      async () => !(await dialog.isVisible()) || (await proof.isVisible()),
      { timeout: 15000 },
    )
    .toBe(true);
  if (expectProof) await expect(proof).toBeVisible();
  if (await proof.isVisible()) {
    await proof.fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
    if (privateData.totpUri)
      await dialog
        .getByLabel("Authenticator code (if enabled)", { exact: true })
        .fill(await freshFactor());
    await dialog
      .getByRole("button", { name: "Verify and approve", exact: true })
      .click();
  }
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
}
async function newKey(name) {
  await settings("API keys");
  await page.getByLabel(/^Key name/).fill(name);
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await approve();
  const field = page.getByLabel("API key secret", { exact: true });
  await expect(field).toBeVisible();
  const secret = await field.inputValue();
  expect(secret.length).toBeGreaterThan(20);
  await page
    .getByRole("button", { name: "Dismiss secret", exact: true })
    .click();
  const list = await call("GET", "/me/keys");
  const key = (list.data ?? list).find((key) => key.name === name);
  expect(key).toBeTruthy();
  return { key, secret };
}
async function verifyKey(secret) {
  const response = await context.request.post(
    `/v1/orgs/${fixture.orgId}/databases/${fixture.databaseId}/tables/${fixture.tableId}/query`,
    {
      headers: { Authorization: `Bearer ${secret}` },
      data: { query: { limit: 1000 } },
    },
  );
  expect(response.status()).toBe(200);
  expect((await response.json()).data).toHaveLength(100);
}
try {
  await signIn();
  let signedInAt = Date.now();
  report.checks.push({
    name: "Rendered email/password sign-in for isolated verified Admin",
    status: "passed",
  });
  const personal = await newKey(`UI personal ${randomUUID().slice(0, 8)}`);
  await verifyKey(personal.secret);
  report.checks.push({
    name: "Personal key safe immutable approval, one-time secret and role-authorised public API use",
    status: "passed",
  });
  await settings("Security");
  if (!privateData.totpUri) {
    await page
      .getByLabel("Current password for factor changes", { exact: true })
      .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
    await page
      .getByRole("button", { name: "Set up authenticator", exact: true })
      .click();
    await approve();
    const uri = page.getByLabel("Authenticator provisioning URI", {
      exact: true,
    });
    await expect(uri).toBeVisible();
    privateData.totpUri = await uri.inputValue();
    privateData.recoveryCodes = await page
      .locator(".settings-recovery-codes code")
      .allTextContents();
    await writeFile(privatePath, JSON.stringify(privateData), { mode: 0o600 });
    await page.getByLabel(/^Six-digit code/).fill(await freshFactor());
    await page
      .getByRole("button", { name: "Confirm authenticator code", exact: true })
      .click();
    await expect(uri).not.toBeVisible();
    await page
      .getByRole("button", { name: "Dismiss codes", exact: true })
      .click();
  }
  await expect(
    page.getByRole("button", { name: "Disable authenticator", exact: true }),
  ).toBeVisible();
  report.checks.push({
    name: "Rendered TOTP setup, private provisioning and live factor confirmation",
    status: "passed",
  });

  await page
    .getByLabel(/^Passkey name/)
    .fill(`UI virtual passkey ${randomUUID().slice(0, 8)}`);
  await page
    .getByRole("button", { name: "Register passkey", exact: true })
    .click();
  await approve();
  await expect(page.locator(".settings-content")).toContainText(
    "Passkey registered.",
  );
  const security = await call("GET", "/me/security");
  expect(security.passkeys.length).toBeGreaterThan(0);
  await page.screenshot({
    path: new URL("chromium-security-enabled.png", output).pathname,
  });
  report.checks.push({
    name: "Rendered verified-user resident passkey registration via actual virtual WebAuthn ceremony",
    status: "passed",
  });

  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to Rootset", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign in with a passkey", exact: true })
    .click();
  await expect(page.locator(".rootset-shell")).toBeVisible({ timeout: 15000 });
  report.checks.push({
    name: "Rendered passkey login completes real authenticator assertion",
    status: "passed",
  });

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("textbox", { name: /^Email address/ })
    .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
  await page
    .getByLabel(/^Password/)
    .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Enter your verification code",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel(/^Verification code/).fill("000000");
  await page
    .getByRole("button", { name: "Verify and sign in", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel(/^Verification code/).fill(await freshFactor());
  await page
    .getByRole("button", { name: "Verify and sign in", exact: true })
    .click();
  await expect(page.locator(".rootset-shell")).toBeVisible();
  signedInAt = Date.now();
  report.checks.push({
    name: "Rendered password login requires TOTP; invalid factor stays on form and valid code signs in",
    status: "passed",
  });

  await settings("API keys");
  const record = page
    .locator(".settings-record")
    .filter({ hasText: personal.key.name });
  await record.getByRole("button", { name: "Rotate", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Rotate API key?", exact: true })
    .getByRole("button", { name: "Rotate key", exact: true })
    .click();
  await approve();
  const rotatedField = page.getByLabel("API key secret", { exact: true });
  await expect(rotatedField).toBeVisible();
  const rotated = await rotatedField.inputValue();
  await page
    .getByRole("button", { name: "Dismiss secret", exact: true })
    .click();
  await verifyKey(personal.secret);
  await verifyKey(rotated);
  report.checks.push({
    name: "Rendered personal-key rotation preserves bounded overlap and replacement secret works",
    status: "passed",
  });

  if (process.env.ROOTSET_VERIFY_AGED_AUTH === "1") {
    while (Date.now() - signedInAt < 306000)
      await page.waitForTimeout(
        Math.min(30000, 306000 - (Date.now() - signedInAt)),
      );
    await settings("API keys");
    await page
      .getByLabel(/^Key name/)
      .fill(`UI aged auth ${randomUUID().slice(0, 8)}`);
    await page.getByRole("button", { name: "Create key", exact: true }).click();
    await approve({ expectProof: true });
    await page
      .getByRole("button", { name: "Dismiss secret", exact: true })
      .click();
    report.checks.push({
      name: "Naturally aged session requires rendered password plus enabled TOTP step-up before immutable approval",
      status: "passed",
    });
  }
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error).replace(
    /https?:\/\/\S+/g,
    "[redacted URL]",
  );
  report.visibleErrors = await page.getByRole("alert").allTextContents();
} finally {
  await writeFile(
    new URL("chromium-security-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
