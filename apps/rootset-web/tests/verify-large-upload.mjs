import { reportError } from "./report-error.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Readable } from "node:stream";

const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const output = new URL("../test-results/browser/", import.meta.url);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const fixture = JSON.parse(
  await readFile(new URL("fixture.json", output), "utf8"),
);
const requestedBytes = Number(
  process.env.ROOTSET_UPLOAD_BYTES ?? 12 * 1024 * 1024 + 17,
);
if (
  !Number.isInteger(requestedBytes) ||
  requestedBytes <= 10 * 1024 * 1024 ||
  requestedBytes > 128 * 1024 * 1024
)
  throw new Error(
    "Upload verification size must be above10MiB and at most128MiB.",
  );
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL });
const page = await context.newPage();
const report = {
  browser: "chromium",
  source:
    "Actual browser fetch directly to the public API, PostgreSQL-bound artifact and installation object storage",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(reportError(error)));
await mkdir(output, { recursive: true });
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
  await context.request.get(new URL("/api/internal/v1/context", apiURL).href);
  await page.goto(baseURL);
  await expect(page.locator(".rootset-shell")).toBeVisible();
  const result = await page.evaluate(
    async ({ orgId, databaseId, tableId, byteLength, apiURL }) => {
      const bytes = new Uint8Array(byteLength);
      bytes.fill(32);
      bytes.set(
        new TextEncoder().encode('{"NAME":"Upload checksum fixture"}\n'),
      );
      const checksum = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const preparedResponse = await fetch(
        `${apiURL}/api/internal/v1/orgs/${orgId}/databases/${databaseId}/tables/${tableId}/imports/uploads`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ format: "jsonl", byteLength, checksum }),
        },
      );
      const prepared = await preparedResponse.json();
      if (!preparedResponse.ok)
        throw new Error(
          `Upload preparation HTTP${preparedResponse.status}: ${prepared.error?.code}`,
        );
      const destination = new URL(prepared.uploadUrl, apiURL);
      if (destination.origin !== apiURL)
        throw new Error("The prepared upload did not use the API origin.");
      const uploaded = await fetch(destination, {
        method: prepared.method,
        headers: prepared.headers,
        body: new Blob([bytes]),
        credentials: "include",
      });
      const uploadResult = await uploaded.json();
      if (!uploaded.ok)
        throw new Error(
          `Streaming upload HTTP${uploaded.status}: ${uploadResult.error?.code}`,
        );
      const artifactResponse = await fetch(
        `${apiURL}/api/internal/v1/orgs/${orgId}/artifacts/${prepared.artifactId}`,
        { credentials: "include" },
      );
      const artifact = await artifactResponse.json();
      if (!artifactResponse.ok)
        throw new Error(
          `Artifact read HTTP${artifactResponse.status}: ${artifact.error?.code}`,
        );
      if (!artifact.downloadUrl)
        throw new Error("Uploaded artifact has no ready download URL.");
      const downloaded = await fetch(
        `${apiURL}/api/internal/v1/orgs/${orgId}/artifacts/${prepared.artifactId}/download`,
        { credentials: "include" },
      );
      if (!downloaded.ok)
        throw new Error(`Artifact download HTTP${downloaded.status}`);
      const downloadedBytes = await downloaded.arrayBuffer();
      const readbackChecksum = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", downloadedBytes)),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return {
        byteLength,
        uploadedBytes: uploadResult.byteLength,
        downloadedBytes: downloadedBytes.byteLength,
        checksum,
        storedChecksum: uploadResult.checksum,
        readbackChecksum,
        artifactId: prepared.artifactId,
        uploadOrigin: destination.origin,
      };
    },
    { ...fixture, byteLength: requestedBytes, apiURL },
  );
  expect(result.byteLength).toBeGreaterThan(10 * 1024 * 1024);
  expect(result.uploadedBytes).toBe(result.byteLength);
  expect(result.downloadedBytes).toBe(result.byteLength);
  expect(result.storedChecksum).toBe(result.checksum);
  expect(result.readbackChecksum).toBe(result.checksum);
  report.checks.push({
    name: `${result.byteLength.toLocaleString()}-byte API-origin browser upload and authenticated download preserve exact length and SHA256`,
    status: "passed",
    ...result,
  });
  const acceptedBatch = await page.evaluate(
    async ({ orgId, databaseId, apiURL }) => {
      const base = `${apiURL}/api/internal/v1/orgs/${orgId}/databases/${databaseId}`;
      const created = await fetch(`${base}/tables`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          name: `Request budget verification ${crypto.randomUUID().slice(0, 8)}`,
          fields: [{ label: "Payload", apiKey: "PAYLOAD", type: "json" }],
        }),
      });
      if (!created.ok)
        throw new Error(`Budget fixture table HTTP${created.status}`);
      const schema = await created.json();
      const rowValue = "x".repeat(Math.ceil((4 * 1024 * 1024) / 100));
      const body = JSON.stringify({
        expectedSchemaVersion: schema.table.schemaVersion,
        mutations: Array.from({ length: 100 }, (_, index) => ({
          type: "create",
          values: { PAYLOAD: { index, value: rowValue } },
        })),
      });
      const committed = await fetch(
        `${base}/tables/${schema.table.id}/rows/batch`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body,
        },
      );
      const result = await committed.json();
      if (!committed.ok)
        throw new Error(
          `4MiB batch HTTP${committed.status}: ${result.error?.code}`,
        );
      const last = result.results.at(-1);
      const readback = await fetch(
        `${base}/tables/${schema.table.id}/rows/${last.rowId}`,
        { credentials: "include" },
      );
      if (!readback.ok)
        throw new Error(`Budget row readback HTTP${readback.status}`);
      const value = await readback.json();
      return {
        requestBytes: new TextEncoder().encode(body).byteLength,
        committedRows: result.results.length,
        readbackCellBytes: value.values.PAYLOAD.value.length,
        expectedCellBytes: rowValue.length,
        tableId: schema.table.id,
        statusCode: committed.status,
      };
    },
    { ...fixture, apiURL },
  );
  expect(acceptedBatch.requestBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(acceptedBatch.requestBytes).toBeLessThan(8 * 1024 * 1024);
  expect(acceptedBatch.committedRows).toBe(100);
  expect(acceptedBatch.readbackCellBytes).toBe(acceptedBatch.expectedCellBytes);
  report.checks.push({
    name: "Legal4MiB ordinary browser batch reaches the API, commits100 bounded JSON rows and returns exact cell readback",
    status: "passed",
    ...acceptedBatch,
  });
  const refusalStarted = performance.now();
  const rejected = await context.request.post(
    new URL(
      `/api/internal/v1/orgs/${fixture.orgId}/databases/${fixture.databaseId}/tables/${fixture.tableId}/query`,
      apiURL,
    ).href,
    {
      headers: { Origin: baseURL, "Content-Type": "application/json" },
      data: JSON.stringify({
        query: { limit: 1000 },
        oversized: "x".repeat(9 * 1024 * 1024),
      }),
    },
  );
  expect(rejected.status()).toBe(413);
  const refusalMs = performance.now() - refusalStarted;
  expect(refusalMs).toBeLessThan(10000);
  report.checks.push({
    name: "Declared9MiB ordinary JSON is refused promptly by the8MiB API budget",
    status: "passed",
    statusCode: rejected.status(),
    refusalMs,
  });
  const state = await context.storageState();
  const cookie = state.cookies
    .filter((value) => value.domain === new URL(apiURL).hostname)
    .map((value) => `${value.name}=${value.value}`)
    .join("; ");
  const prefix = JSON.stringify({ query: { limit: 1000 } });
  const chunked = await fetch(
    new URL(
      `/api/internal/v1/orgs/${fixture.orgId}/databases/${fixture.databaseId}/tables/${fixture.tableId}/query`,
      apiURL,
    ),
    {
      method: "POST",
      headers: {
        Origin: baseURL,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: Readable.from([
        prefix,
        " ".repeat(8 * 1024 * 1024 + 64 - Buffer.byteLength(prefix)),
      ]),
      duplex: "half",
      signal: AbortSignal.timeout(20000),
    },
  );
  expect(chunked.status).toBe(413);
  report.checks.push({
    name: "Unknown-length chunked JSON containing a valid prefix is refused above8MiB",
    status: "passed",
    statusCode: chunked.status,
  });
  expect(report.pageErrors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
} finally {
  await writeFile(
    new URL(
      process.env.ROOTSET_UPLOAD_BYTES
        ? `chromium-large-upload-${requestedBytes}-report.json`
        : "chromium-large-upload-report.json",
      output,
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await context.close();
  await browser.close();
  if (report.status !== "passed") process.exitCode = 1;
}
