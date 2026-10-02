import { reportError } from "./report-error.mjs";
import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const execute = promisify(execFile);
const engine = process.env.ROOTSET_TEST_BROWSER ?? "chromium";
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const duration = Number(process.env.ROOTSET_SCROLL_DURATION_MS ?? 300_000);
const output = new URL("../test-results/browser/", import.meta.url);
const credentials = parseEnv(
  await readFile(new URL("../.env.browser-test", import.meta.url), "utf8"),
);
const server = await { chromium, webkit }[engine].launchServer();
const browser = await { chromium, webkit }[engine].connect(server.wsEndpoint());
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const samples = [],
  errors = [];
page.on("pageerror", (error) => errors.push(reportError(error)));
page.on("response", (response) => {
  if (response.url().includes("/windows/query") && response.status() >= 400)
    errors.push(`Grid window HTTP ${response.status()}`);
});
async function rss() {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss="]);
  const processes = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const pids = new Set([server.process().pid]);
  for (let round = 0; round < 10; round++)
    for (const [pid, parent] of processes) if (pids.has(parent)) pids.add(pid);
  return (
    processes.reduce((sum, [pid, , kb]) => sum + (pids.has(pid) ? kb : 0), 0) *
    1024
  );
}
const report = {
  browser: engine,
  durationMs: duration,
  profile: {
    os: process.platform,
    browserProcesses:
      "Root process and current descendants RSS; no forced garbage collection",
    viewport: "1440x1000",
    source: "real Next.js app and PostgreSQL five-million/200-field fixture",
  },
  errors,
  samples,
};
await mkdir(output, { recursive: true });
try {
  const login = await context.request.post("/v1/auth/sign-in/email", {
    data: {
      email: credentials.ROOTSET_TEST_OWNER_EMAIL,
      password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
    },
    headers: { Origin: new URL(baseURL).origin },
  });
  if (!login.ok()) throw new Error(`QA sign-in failed (${login.status()}).`);
  const selected = await context.request.post("/v1/auth/organisation", {
    data: { orgId: "01M3YBJF63FQKFPQSK568N7A1D" },
    headers: { Origin: new URL(baseURL).origin },
  });
  if (!selected.ok())
    throw new Error(`QA org selection failed (${selected.status()}).`);
  const start = performance.now();
  await page.goto(baseURL);
  await expect(
    page.getByRole("grid", { name: "Five million typed rows spreadsheet" }),
  ).toBeVisible();
  await expect(page.getByRole("gridcell").first()).not.toHaveText("Loading…");
  report.firstUsableViewportMs = performance.now() - start;
  expect(report.firstUsableViewportMs).toBeLessThanOrEqual(2500);
  await page.waitForTimeout(5000);
  report.baselineRss = await rss();
  await page.evaluate(() => {
    window.__rootsetFrameTimes = [];
    window.__rootsetScrollActive = true;
    let previous = performance.now(),
      offset = 0,
      direction = 1;
    const tick = (now) => {
      if (!window.__rootsetScrollActive) return;
      window.__rootsetFrameTimes.push(now - previous);
      previous = now;
      const grid = document.querySelector(".grid-viewport");
      if (grid) {
        offset += direction * 28;
        const maximum = Math.max(0, grid.scrollHeight - grid.clientHeight);
        if (offset > maximum) {
          offset = maximum;
          direction = -1;
        }
        if (offset < 0) {
          offset = 0;
          direction = 1;
        }
        grid.scrollTop = offset;
        grid.scrollLeft =
          ((now % 6000) / 6000) *
          Math.max(0, grid.scrollWidth - grid.clientWidth);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const scrollStarted = performance.now();
  for (let index = 0; performance.now() - scrollStarted < duration; index++) {
    const mode = ["Middle row window", "Last row window", "First row window"][
      index % 3
    ];
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.waitForTimeout(10_000);
    const state = await page.locator(".grid-viewport").evaluate((grid) => ({
      rows: grid.querySelectorAll(".grid-row").length,
      columns: grid.querySelectorAll(".column-header").length,
      cacheWindows: Number(grid.dataset.cacheWindows),
      cacheBytes: Number(grid.dataset.cacheBytes),
      height: grid.scrollHeight,
    }));
    const memory = await rss();
    samples.push({
      elapsedMs: performance.now() - scrollStarted,
      rss: memory,
      ...state,
    });
    expect(state.rows).toBeLessThan(32);
    expect(state.columns).toBeLessThan(12);
    expect(state.cacheWindows).toBeLessThanOrEqual(5);
    expect(state.cacheBytes).toBeLessThanOrEqual(33554432);
    expect(state.height).toBeLessThan(10_000);
  }
  const frames = await page.evaluate(() => {
    window.__rootsetScrollActive = false;
    return window.__rootsetFrameTimes;
  });
  const sorted = frames.slice().sort((a, b) => a - b);
  const quantile = (value) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
  report.frames = {
    count: frames.length,
    medianMs: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: Math.max(...frames),
    medianFPS: 1000 / quantile(0.5),
    freezesOver1s: frames.filter((frame) => frame >= 1000).length,
  };
  report.memoryIncreaseBytes = samples.at(-1).rss - report.baselineRss;
  report.peakIncreaseBytes =
    Math.max(...samples.map((sample) => sample.rss)) - report.baselineRss;
  expect(report.frames.medianFPS).toBeGreaterThanOrEqual(50);
  expect(report.frames.p95Ms).toBeLessThanOrEqual(32);
  expect(report.frames.freezesOver1s).toBe(0);
  expect(report.memoryIncreaseBytes).toBeLessThanOrEqual(150 * 1024 * 1024);
  expect(errors).toEqual([]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = reportError(error);
} finally {
  await writeFile(
    new URL(`${engine}-five-minute-scroll.json`, output),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      browser: engine,
      status: report.status,
      frames: report.frames,
      baselineRss: report.baselineRss,
      memoryIncreaseBytes: report.memoryIncreaseBytes,
      firstUsableViewportMs: report.firstUsableViewportMs,
      error: report.error,
    }),
  );
  await context.close();
  await browser.close();
  await server.close();
  if (report.status !== "passed") process.exitCode = 1;
}
