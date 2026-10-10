import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const orgId = "01M3YBJF63FQKFPQSK568N7A1D",
  databaseId = "01M3YBJF72543P36XD1F8H4NZT",
  tableId = "01M3YBJF7RQTTAFG160ST17VWR";
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const output = new URL("../test-results/browser/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL });
const page = await context.newPage();
try {
  const signed = await context.request.post(
    new URL("/v1/auth/sign-in/email", apiURL).href,
    {
      headers: { Origin: baseURL },
      data: {
        email: credentials.ROOTSET_TEST_OWNER_EMAIL,
        password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
      },
    },
  );
  expect(signed.ok()).toBe(true);
  await page.goto(`/settings/keys?organisationId=${orgId}`);
  await expect(page.locator(".settings-header h1")).toHaveText("API keys");
  await page
    .getByLabel(/^Key name/)
    .fill("Local five-million-row HTTP verification");
  await page
    .getByLabel(/^Expires on/)
    .fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const secret = page.getByLabel("API key secret", { exact: true });
  await expect(secret).toBeVisible();
  const value = await secret.inputValue();
  await writeFile(
    new URL("scale-key-private.json", output),
    JSON.stringify({
      apiKey: value,
      orgId,
      databaseId,
      tableId,
      source:
        "Actual rendered personal-key creation with session authentication",
    }),
    { mode: 0o600 },
  );
  await page
    .getByRole("button", { name: "Dismiss secret", exact: true })
    .click();
  console.log(
    JSON.stringify({
      status: "passed",
      protectedPath: new URL("scale-key-private.json", output).pathname,
    }),
  );
} finally {
  await context.close();
  await browser.close();
}
