import { reportError } from "./report-error.mjs";
import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: "/tmp/rootset-browser-state.json",
  baseURL: "http://localhost:4300",
});
async function call(method, path, input) {
  const response = await context.request.fetch(
    new URL(`/api/internal/v1${path}`, apiURL).href,
    {
      method,
      ...(input ? { data: input } : {}),
      headers: {
        Origin: "http://localhost:4300",
        "Idempotency-Key": randomUUID(),
      },
    },
  );
  const result = await response.json();
  if (!response.ok())
    throw new Error(
      `${method} ${path}: ${response.status()} ${result.error?.code ?? ""}: ${result.error?.message ?? ""}`,
    );
  return result;
}
try {
  const caller = await call("GET", "/me");
  const orgId = caller.organisation.id;
  const databases = await call("GET", `/orgs/${orgId}/databases`);
  const database =
    databases.data.find((candidate) => candidate.name === "UI verification") ??
    (await call("POST", `/orgs/${orgId}/databases`, {
      name: "UI verification",
    }));
  const fields = [
    {
      name: "NAME",
      type: "text",
      required: true,
      charLimit: 24,
    },
    {
      name: "INTEGER",
      type: "integer",
      min: 0,
      max: 1000000,
    },
    { name: "FLOAT", type: "float", min: -100, max: 100 },
    { name: "BOOLEAN", type: "boolean" },
    { name: "DATE", type: "date" },
    { name: "TIME", type: "time" },
    { name: "DATETIME", type: "date-time" },
    { name: "JSON", type: "json" },
  ];
  const tables = await call(
    "GET",
    `/orgs/${orgId}/databases/${database.id}/tables`,
  );
  const existing = tables.data.find(
    (candidate) => candidate.name === "Cell types",
  );
  const schema = existing
    ? await call(
        "GET",
        `/orgs/${orgId}/databases/${database.id}/tables/${existing.id}/schema`,
      )
    : await call("POST", `/orgs/${orgId}/databases/${database.id}/tables`, {
        name: "Cell types",
        fields,
      });
  const table = schema.table;
  if (!table.rowCount)
    await call(
      "POST",
      `/orgs/${orgId}/databases/${database.id}/tables/${table.id}/rows/batch`,
      {
        expectedSchemaVersion: table.schemaVersion,
        mutations: Array.from({ length: 100 }, (_, index) => ({
          type: "create",
          values: {
            NAME: `Airline ${index + 1}`,
            INTEGER: index,
            FLOAT: 3.25,
            BOOLEAN: index % 2 === 0,
            DATE: "2026-10-02",
            TIME: "12:30:00.000Z",
            DATETIME: "2026-10-02T12:30:00.000Z",
            JSON: { airline: index, nested: { active: true }, nullable: null },
          },
        })),
      },
    );
  await mkdir(new URL("../test-results/browser", import.meta.url), {
    recursive: true,
  });
  await writeFile(
    new URL("../test-results/browser/fixture.json", import.meta.url),
    JSON.stringify(
      {
        orgId,
        databaseId: database.id,
        tableId: table.id,
        tableName: table.name,
        fields: schema.fields,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      tableName: table.name,
      types: fields.map((field) => field.type),
      seededRows: 100,
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? reportError(error) : "Browser fixture failed",
  );
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
