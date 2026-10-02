import { reportError } from "./report-error.mjs";
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";

const root = new URL("../../../", import.meta.url);
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
  const setup = await fetch("http://localhost:4300/v1/setup").then((response) =>
    response.json(),
  );
  await page.goto("http://localhost:4300/");
  if (!setup.claimed) {
    await page.getByRole("heading", { name: "Set up Rootset" }).waitFor();
    await page.screenshot({
      path: new URL(
        "../test-results/browser/setup-desktop.png",
        import.meta.url,
      ).pathname,
    });
    await page
      .getByLabel("Organisation name", { exact: true })
      .fill("Rootset UI verification");
    await page
      .getByLabel("Your name", { exact: true })
      .fill("UI verification owner");
    await page
      .getByLabel("Email address", { exact: true })
      .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
    await page
      .getByLabel("Password", { exact: true })
      .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
    await page
      .getByLabel("Installation setup secret", { exact: true })
      .fill(config.ROOTSET_BOOTSTRAP_SECRET);
    await page
      .getByRole("button", { name: "Create owner account", exact: true })
      .click();
    await page
      .getByText("Check your email to verify the owner account", {
        exact: false,
      })
      .waitFor({ timeout: 15000 });
  }
  let verificationUrl;
  for (let attempt = 0; attempt < 30; attempt++) {
    const mailbox = await fetch("http://localhost:59080/api/v1/messages").then(
      (response) => response.json(),
    );
    const message = mailbox.messages?.find((candidate) =>
      candidate.To?.some(
        (recipient) =>
          recipient.Address === credentials.ROOTSET_TEST_OWNER_EMAIL,
      ),
    );
    if (message) {
      const content = await fetch(
        `http://localhost:59080/api/v1/message/${message.ID}`,
      ).then((response) => response.json());
      verificationUrl = (content.HTML ?? content.Text ?? "")
        .match(/https?:\/\/[^\s"<>]+\/v1\/auth\/verify-email\?[^\s"<>]+/)?.[0]
        ?.replaceAll("&amp;", "&");
      if (verificationUrl) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (verificationUrl) await page.goto(verificationUrl);
  await page.goto("http://localhost:4300/login");
  await page
    .getByLabel("Email address", { exact: true })
    .fill(credentials.ROOTSET_TEST_OWNER_EMAIL);
  await page
    .getByLabel("Password", { exact: true })
    .fill(credentials.ROOTSET_TEST_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Create your first database", exact: true })
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
