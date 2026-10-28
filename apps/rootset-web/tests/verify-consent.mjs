import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const clientId = "rootset-browser-verification";
const redirect = "http://localhost:4311/settings/connections";
const resource = `${apiURL}/mcp`;
const output = new URL("../test-results/browser/", import.meta.url);
const fixture = JSON.parse(
  await readFile(
    new URL("../test-results/browser/fixture.json", import.meta.url),
    "utf8",
  ),
);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const report = {
  browser: "chromium",
  source:
    "Real OAuth authorize/consent/token/MCP and rendered connection revocation; loopback client callback",
  checks: [],
  pageErrors: [],
};
const callback = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><html lang="en"><title>Rootset verification client</title><body><h1>Authorization callback received</h1></body></html>',
  );
});
await new Promise((resolve, reject) => {
  callback.once("error", reject);
  callback.listen(4311, "127.0.0.1", resolve);
});
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1100, height: 900 },
});
const page = await context.newPage();
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
await mkdir(output, { recursive: true });
function authorization(state) {
  const verifier = randomBytes(40).toString("base64url"),
    url = new URL("/oauth/authorize", apiURL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
    scope: "viewer",
    state,
    organization_id: fixture.orgId,
  }).toString();
  return { url, verifier };
}
async function review(request) {
  await page.goto(request.url.href);
  await expect(
    page.getByRole("heading", { name: "Connect to Rootset", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Allow access", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".identity-panel")).toContainText(clientId);
  await expect(page.locator(".identity-panel")).toContainText(resource);
  await expect(page.locator(".identity-panel")).toContainText("read");
  await expect(page.locator(".identity-panel")).toContainText(
    "Registered by an installation administrator",
  );
}
async function rpc(accessToken, method, params) {
  const response = await context.request.post(new URL("/mcp", apiURL).href, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    data: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
  });
  if (!response.ok())
    throw new Error(`MCP ${method} HTTP ${response.status()}`);
  const text = await response.text();
  return response.headers()["content-type"]?.includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6),
      )
    : JSON.parse(text);
}
try {
  const signed = await context.request.post(
    new URL("/v1/auth/sign-in/email", apiURL).href,
    {
      headers: { Origin: new URL(baseURL).origin },
      data: {
        email: credentials.ROOTSET_TEST_OWNER_EMAIL,
        password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
      },
    },
  );
  if (!signed.ok())
    throw new Error(`Verified browser sign-in HTTP ${signed.status()}`);
  const selected = await context.request.get(
    new URL("/api/internal/v1/context", apiURL).href,
  );
  if (!selected.ok())
    throw new Error(`Automatic organisation context HTTP ${selected.status()}`);
  const denied = authorization("rendered-denial-proof");
  await review(denied);
  await page.screenshot({
    path: new URL("chromium-oauth-consent-review.png", output).pathname,
  });
  await page.getByRole("button", { name: "Deny access", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Authorization callback received" }),
  ).toBeVisible();
  let completed = new URL(page.url());
  expect(completed.searchParams.get("error")).toBe("access_denied");
  expect(completed.searchParams.get("state")).toBe("rendered-denial-proof");
  expect(completed.searchParams.has("code")).toBe(false);
  report.checks.push({
    name: "Explicit denial returns bound state and access_denied without authorization code",
    status: "passed",
  });
  const approved = authorization("rendered-approval-proof");
  await review(approved);
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Authorization callback received" }),
  ).toBeVisible();
  completed = new URL(page.url());
  const code = completed.searchParams.get("code");
  expect(Boolean(code)).toBe(true);
  expect(completed.searchParams.get("state")).toBe("rendered-approval-proof");
  const exchanged = await context.request.post(
    new URL("/oauth/token", apiURL).href,
    {
      form: {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirect,
        code,
        code_verifier: approved.verifier,
        resource,
      },
    },
  );
  expect(exchanged.status()).toBe(200);
  const tokens = await exchanged.json();
  expect(typeof tokens.access_token).toBe("string");
  report.checks.push({
    name: "Explicit consent grants requested operations and audience and PKCE exchange succeeds at actual OAuth server",
    status: "passed",
  });
  const tools = [];
  let cursor;
  do {
    const list = await rpc(
      tokens.access_token,
      "tools/list",
      cursor ? { cursor } : undefined,
    );
    tools.push(...list.result.tools);
    cursor = list.result.nextCursor;
  } while (cursor);
  expect(tools.length).toBeGreaterThan(90);
  expect(tools.some((tool) => tool.name === "rootset_query_rows")).toBe(true);
  const result = await rpc(tokens.access_token, "tools/call", {
    name: "rootset_query_rows",
    arguments: {
      orgId: fixture.orgId,
      databaseId: fixture.databaseId,
      tableId: fixture.tableId,
      query: { limit: 1000 },
    },
  });
  expect(result.result.isError ?? false).toBe(false);
  const data =
    result.result.structuredContent ??
    JSON.parse(
      result.result.content.find((content) => content.type === "text").text,
    );
  expect(data.data.length).toBe(100);
  report.checks.push({
    name: "OAuth MCP token lists tools and queries only consented real table",
    status: "passed",
    rows: data.data.length,
  });
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Connected applications", exact: true })
    .click();
  const record = page
    .locator(".settings-record")
    .filter({ hasText: clientId })
    .first();
  await expect(record).toBeVisible();
  await record.getByRole("button", { name: "Revoke", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(page.locator(".settings-content")).toContainText(
    "Application access revoked.",
  );
  const revoked = await context.request.post(new URL("/mcp", apiURL).href, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  expect(revoked.status()).toBe(401);
  await page.screenshot({
    path: new URL("chromium-oauth-connection-revoked.png", output).pathname,
  });
  report.checks.push({
    name: "Rendered connection revocation invalidates issued MCP access token",
    status: "passed",
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error).replace(
    /https?:\/\/\S+/g,
    "[redacted URL]",
  );
  report.visibleErrors = await page.getByRole("alert").allTextContents();
  report.failurePath = new URL(page.url()).pathname;
  report.visibleHeadings = await page.getByRole("heading").allTextContents();
  const errorText = await page.locator("body").textContent();
  if (errorText?.trim().startsWith('{"error":')) {
    try {
      report.transportError = JSON.parse(errorText).error;
    } catch {
      report.transportError = "Unreadable error envelope";
    }
  }
} finally {
  await writeFile(
    new URL("chromium-consent-report.json", output),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  await new Promise((resolve) => callback.close(resolve));
  if (report.status !== "passed") process.exitCode = 1;
}
