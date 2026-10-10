import { reportError } from "./report-error.mjs";
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";

const root = new URL("../../../", import.meta.url);
const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";
const webURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const config = parseEnv(await readFile(new URL(".env.test", root), "utf8"));
const credentialsFile = new URL("../.env.browser-test", import.meta.url);
let credentials;
try {
  credentials = parseEnv(await readFile(credentialsFile, "utf8"));
} catch {
  credentials = {
    ROOTSET_TEST_OWNER_EMAIL: "rootset-ui-owner@example.test",
    ROOTSET_TEST_OWNER_PASSWORD: `Rootset verification ${randomBytes(24).toString("base64url")}`,
  };
  await writeFile(
    credentialsFile,
    Object.entries(credentials)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    { mode: 0o600 },
  );
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(reportError(error)));
await mkdir(new URL("../test-results/browser", import.meta.url), {
  recursive: true,
});
try {
  const setup = await fetch(`${apiURL}/v1/setup`).then((response) =>
    response.json(),
  );
  await page.goto(webURL);
  if (!setup.claimed) {
    await page.getByRole("heading", { name: "Set up Rootset" }).waitFor();
    await page.screenshot({
      path: new URL(
        "../test-results/browser/setup-desktop.png",
        import.meta.url,
      ).pathname,
    });
    await page
      .getByLabel("Installation setup secret", { exact: true })
      .fill(config.ROOTSET_SECRET);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByLabel("Team name", { exact: true })
      .fill("Rootset UI verification");
    await page
      .getByLabel("Your Name", { exact: true })
      .fill("UI verification admin");
    await page
      .getByLabel("Email", { exact: true })
      .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
    await page
      .getByLabel("Password", { exact: true })
      .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("button", { name: "Complete Setup", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Your account is ready", exact: true })
      .waitFor();
    if (
      await page
        .getByRole("heading", { name: "Verify your email", exact: true })
        .count()
    )
      throw new Error(
        "The installation administrator should be verified automatically",
      );
    await page
      .getByRole("button", { name: "Continue to sign in", exact: true })
      .click();
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    if (new URL(page.url()).pathname !== "/login")
      throw new Error(
        "Continue to sign in should navigate to /login without a reload",
      );
  } else {
    await page.goto(new URL("/login", webURL).href);
  }
  await page
    .getByLabel("Email", { exact: true })
    .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
  await page
    .getByLabel("Password", { exact: true })
    .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create database", exact: true })
    .waitFor({ timeout: 15000 });
  await context.storageState({ path: "/tmp/rootset-browser-state.json" });
  await page.screenshot({
    path: new URL("../test-results/browser/empty-desktop.png", import.meta.url)
      .pathname,
  });
  if (runtimeErrors.length)
    throw new Error(`Browser runtime errors: ${runtimeErrors.join("; ")}`);
  console.log(
    JSON.stringify({
      ok: true,
      statePath: "/tmp/rootset-browser-state.json",
      evidence: ["setup-desktop.png", "empty-desktop.png"],
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? reportError(error) : "Browser bootstrap failed",
  );
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
