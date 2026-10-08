import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRuntime } from "@rootset/core/runtime";
import {
  getOperation,
  limits,
  newId,
  type QueryResult,
  type Row,
  type Actor,
} from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import { fieldColumn } from "../../packages/table-storage/src/query.js";
import { openScaleTarget } from "./scale-profile-target.js";
import { sourceProvenance } from "./source-provenance.js";
import { root } from "./environment.js";

const run = promisify(execFile);
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "ASSERTION_OR_TRANSPORT";
function summary(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    requests: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}

export async function runHttpProfile(
  manifest: string,
  port: number,
  container: string,
  baseURL: string,
  scenario: string,
) {
  const base = new URL(baseURL);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(base.hostname) &&
      base.protocol === "http:",
  );
  const target = await openScaleTarget(manifest, port, container);
  const secretPath = join(
    root,
    "apps/rootset-web/test-results/browser/scale-key-private.json",
  );
  const key = JSON.parse(await readFile(secretPath, "utf8")) as {
    apiKey: string;
    orgId: string;
    databaseId: string;
    tableId: string;
  };
  assert.equal(key.orgId, target.fixture.orgId);
  assert.equal(key.tableId, target.fixture.tableId);
  const ids = {
    orgId: key.orgId,
    databaseId: key.databaseId,
    tableId: key.tableId,
  };
  const filename = join(
    target.directory,
    `http-profile-${port}-${scenario}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`,
  );
  const report: Record<string, unknown> = {
    kind: "actual-http-scale-profile",
    startedAt: new Date().toISOString(),
    sourceAtStart: await sourceProvenance(),
    container,
    port,
    baseURL: base.origin,
    scenario,
    acceptance: false,
    scope:
      "Actual shipped HTTP API with actual scoped key/current membership and PostgreSQL5M fixture. PostgreSQL-buffer coldness is measured separately from unproven OS-cache coldness. Original55448/55460 are unchanged.",
    results: [],
  };
  const results = report.results as Record<string, unknown>[];
  const call = async (
    id: string,
    input: Record<string, unknown>,
    options: {
      expectedStatus?: number;
      idempotencyKey?: string;
      secret?: string;
    } = {},
  ) => {
    const operation = getOperation(id),
      body = { ...input };
    let path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = body[name];
      assert.equal(typeof value, "string");
      delete body[name];
      return encodeURIComponent(String(value));
    });
    if (operation.httpMethod === "GET") {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(body))
        if (value !== undefined)
          params.set(
            name,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
      if (params.size) path += `?${params}`;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.secret ?? key.apiKey}`,
    };
    if (operation.httpMethod !== "GET")
      headers["Content-Type"] = "application/json";
    if (operation.idempotencyRequired)
      headers["Idempotency-Key"] = options.idempotencyKey ?? newId();
    if (id === "updateRow" || id === "deleteRow")
      headers["If-Match"] = `"${input.rowId}:${input.expectedVersion}"`;
    const response = await fetch(new URL(path, base), {
      method: operation.httpMethod,
      headers,
      body: operation.httpMethod === "GET" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(16000),
    });
    const encoded = await response.text();
    assert.ok(
      Buffer.byteLength(encoded) <= limits.restResultBytes,
      "Complete HTTP result must respect8MiB budget.",
    );
    const decoded = JSON.parse(encoded);
    if (
      response.status !== (options.expectedStatus ?? operation.successStatus)
    ) {
      const code = decoded?.error?.code ?? "HTTP_STATUS_MISMATCH";
      throw Object.assign(new Error("Typed HTTP profile request failed."), {
        code,
        status: response.status,
      });
    }
    return {
      value: operation.outputSchema.parse(decoded),
      requestId: response.headers.get("X-Request-Id"),
      encodedBytes: Buffer.byteLength(encoded),
      status: response.status,
    };
  };
  const measure = async (
    id: string,
    request: (index: number) => Promise<unknown>,
    threshold?: number,
    beforeEach?: (index: number) => Promise<void>,
  ) => {
    const durations: number[] = [],
      errors: Record<string, number> = {};
    for (let index = 0; index < 1000; index++) {
      if (beforeEach) await beforeEach(index);
      const start = performance.now();
      try {
        await request(index);
      } catch (error) {
        errors[errorCode(error)] = (errors[errorCode(error)] ?? 0) + 1;
      }
      durations.push(performance.now() - start);
      if ((index + 1) % 100 === 0)
        console.log(
          JSON.stringify({ scenario: id, requests: index + 1, errors }),
        );
    }
    const stats = summary(durations);
    const result = {
      id,
      ...stats,
      errors,
      ...(threshold
        ? {
            targetP95Ms: threshold,
            measuredTargetMet:
              (stats.p95Ms ?? Infinity) <= threshold &&
              Object.keys(errors).length === 0,
          }
        : {}),
    };
    results.push(result);
    await writeFile(filename, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    return result;
  };
  try {
    const table = await target.storage.getTable(
      target.actor,
      target.fixture.tableId,
    );
    assert.equal(table.rowCount, 5000000);
    assert.equal(table.fields.length, 24);
    const resources: Record<string, unknown>[] = [];
    const containerNames = JSON.parse(
      (
        await run("docker", [
          "network",
          "inspect",
          "rootset-performance",
          "--format",
          "{{json .Containers}}",
        ])
      ).stdout,
    ) as Record<string, { Name: string }>;
    for (const { Name } of Object.values(containerNames)) {
      const inspected = JSON.parse(
        (
          await run("docker", [
            "inspect",
            "--format",
            "{{json .HostConfig}}",
            Name,
          ])
        ).stdout,
      ) as { Memory: number; MemorySwap: number; NanoCpus: number };
      resources.push({
        name: Name,
        memoryBytes: inspected.Memory,
        memorySwapBytes: inspected.MemorySwap,
        nanoCpus: inspected.NanoCpus,
      });
    }
    report.containerBudgets = resources;
    const approvedLimits = new Map([
      [container, 4 * 1024 ** 3],
      ["rootset-performance-api-1", 1024 ** 3],
      ["rootset-performance-worker-1", 2 * 1024 ** 3],
      ["rootset-performance-web-1", 1024 ** 3],
    ]);
    for (const [name, budget] of approvedLimits) {
      const actual = resources.find((item) => item.name === name);
      assert.ok(actual, `Required capped service ${name} is absent.`);
      assert.equal(
        actual.memoryBytes,
        budget,
        "Runtime cgroup allocation must match.",
      );
      assert.equal(
        actual.memorySwapBytes,
        budget,
        "Runtime must not borrow unreported swap memory.",
      );
    }
    report.totalApplicationMemoryLimitBytes = [
      ...approvedLimits.values(),
    ].reduce((sum, value) => sum + value, 0);
    report.baselineDatabase = (
      await target.pools.identity.query(
        "SELECT rootset_control.operator_metrics() AS metrics",
      )
    ).rows[0]?.metrics;
    const integer = table.fields.find((field) => field.name === "INTEGER_A")!;
    report.indexedPlan = (
      await withOrg(target.pools.api, target.actor.orgId, (client) =>
        client.query(
          `EXPLAIN (FORMAT JSON) SELECT * FROM ${q(table.schemaName)}.${q(table.physicalName)} WHERE ${q(fieldColumn(integer))}>=$1 ORDER BY ${q(fieldColumn(integer))},row_id LIMIT 200`,
          [2500000],
        ),
      )
    ).rows;
    const indexed = async (index: number, count = 200) => {
      const response = await call("queryRows", {
        ...ids,
        query: {
          where: { field: "INTEGER_A", op: "gte", value: 2500000 + index * 10 },
          orderBy: [{ field: "INTEGER_A", direction: "asc" }],
          limit: count,
        },
      });
      const result = response.value as QueryResult;
      if (count < 25000) assert.equal(result.data.length, count);
      else {
        assert.ok(result.data.length > 0 && result.data.length < 25000);
        assert.equal(result.page.stopReason, "byte_limit");
        assert.ok(result.page.nextCursor);
      }
    };
    if (scenario === "cold") {
      const relations = (
        await target.pools.owner.query<{ oid: number; filenode: number }>(
          "SELECT oid,pg_relation_filenode(oid) AS filenode FROM pg_class WHERE oid=$1::regclass OR oid IN (SELECT indexrelid FROM pg_index WHERE indrelid=$1::regclass)",
          [`${table.schemaName}.${table.physicalName}`],
        )
      ).rows;
      report.coldScope = {
        postgresqlBuffers:
          "Every request evicts native table and its indexes and verifieszero resident target buffers before timing.",
        osPageCache: "unproven/warm; no OS cache drop claimed",
        relations: relations.length,
      };
      let cleared = 0;
      await measure(
        "HTTP-COLD-INDEXED-200",
        (index) => indexed(index),
        1500,
        async () => {
          for (const relation of relations)
            await target.pools.owner.query(
              "SELECT * FROM pg_buffercache_evict_relation($1::regclass)",
              [String(relation.oid)],
            );
          const remaining = (
            await target.pools.owner.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM pg_buffercache WHERE reldatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relfilenode=ANY($1::oid[])",
              [relations.map((relation) => relation.filenode)],
            )
          ).rows[0]!.count;
          assert.equal(
            remaining,
            0,
            "Cold PostgreSQL request requires all relevant table/index buffers evicted.",
          );
          cleared++;
        },
      );
      report.coldBuffersVerifiedRequests = cleared;
    } else if (scenario === "warm") {
      await measure("HTTP-WARM-INDEXED-200", (index) => indexed(index), 500);
      await measure(
        "HTTP-WARM-RESULT-5000",
        (index) => indexed(index, 5000),
        2000,
      );
      await measure("HTTP-WARM-RESULT-25000-BYTE-CAPPED", (index) =>
        indexed(index, 25000),
      );
      await measure(
        "HTTP-WARM-CELL-HISTORY-200",
        async (index) => {
          const rowId = ((index % 1000) + 1)
            .toString(16)
            .toUpperCase()
            .padStart(26, "0");
          const response = await call("getCellHistory", {
            ...ids,
            rowId,
            fieldId: integer.id,
            limit: 200,
          });
          assert.equal(
            (response.value as { data: unknown[] }).data.length,
            200,
          );
        },
        500,
      );
    } else if (scenario === "scans") {
      const scans: {
        name: string;
        field: string;
        op: string;
        hit: unknown;
        miss: unknown;
      }[] = [
        {
          name: "TEXT",
          field: "TEXT_A",
          op: "contains",
          hit: "C",
          miss: "missing-needle",
        },
        {
          name: "JSON",
          field: "JSON_A",
          op: "jsonContains",
          hit: { g: 0 },
          miss: { g: 99999 },
        },
        { name: "RANGE", field: "INTEGER_B", op: "lt", hit: 1000, miss: -1 },
      ];
      report.scanDistribution = {
        requestsPerType: 1000,
        matchingEarlyPages: 990,
        noMatchWholeTableScans: 10,
        hardTimeoutMs: 10000,
        foregroundProbes:
          "One independent indexed200HTTPrequest during every scan; every probe must return complete typed result.",
      };
      for (const scan of scans) {
        const foreground: number[] = [],
          failures: Record<string, number> = {},
          timeouts: number[] = [];
        const field = table.fields.find((item) => item.name === scan.field)!;
        const clause =
          scan.op === "contains"
            ? `${q(fieldColumn(field))} LIKE $1`
            : scan.op === "jsonContains"
              ? `${q(fieldColumn(field))} @> $1::jsonb`
              : `${q(fieldColumn(field))}<$1`;
        results.push({
          id: `HTTP-SCAN-${scan.name}-PLAN`,
          plan: (
            await withOrg(target.pools.api, target.actor.orgId, (client) =>
              client.query(
                `EXPLAIN (FORMAT JSON) SELECT * FROM ${q(table.schemaName)}.${q(table.physicalName)} WHERE ${clause} ORDER BY row_id LIMIT 200`,
                [
                  scan.op === "contains"
                    ? `%${scan.miss}%`
                    : scan.op === "jsonContains"
                      ? JSON.stringify(scan.miss)
                      : scan.miss,
                ],
              ),
            )
          ).rows,
        });
        await measure(`HTTP-SCAN-${scan.name}-MIXED`, async (index) => {
          const noMatch = index % 100 === 99,
            start = performance.now();
          const query = call("queryRows", {
            ...ids,
            query: {
              where: {
                field: scan.field,
                op: scan.op,
                value: noMatch ? scan.miss : scan.hit,
              },
              limit: 200,
            },
          });
          const foregroundStart = performance.now();
          const probe = indexed(index).then(
            () => {
              foreground.push(performance.now() - foregroundStart);
            },
            (error) => {
              failures[errorCode(error)] =
                (failures[errorCode(error)] ?? 0) + 1;
            },
          );
          try {
            const response = await query;
            assert.equal(
              (response.value as QueryResult).data.length,
              noMatch ? 0 : 200,
            );
          } catch (error) {
            if (noMatch && errorCode(error) === "QUERY_TIMEOUT") {
              timeouts.push(performance.now() - start);
              assert.ok(
                timeouts.at(-1)! < 11500,
                "Expensive scan cancellation exceeded bounded transport overhead.",
              );
            } else throw error;
          } finally {
            await probe;
          }
        });
        assert.equal(
          Object.keys(failures).length,
          0,
          "Foreground must remain usable during scans.",
        );
        results.push({
          id: `HTTP-SCAN-${scan.name}-FOREGROUND`,
          ...summary(foreground),
          errors: failures,
          actionableTimeouts: summary(timeouts),
        });
      }
    } else if (scenario === "edit10") {
      const page = (await call("queryRows", { ...ids, query: { limit: 10 } }))
        .value as QueryResult;
      const before = page.data;
      assert.equal(before.length, 10);
      const baseline = (
        await target.pools.owner.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2 AND field_id=$3 AND row_id=ANY($4::varchar[])",
          [ids.orgId, ids.tableId, integer.id, before.map((row) => row.id)],
        )
      ).rows[0]!.count;
      const timings: number[] = [],
        mutationIds: string[] = [],
        errors: Record<string, number> = {};
      await Promise.all(
        before.map(async (row) => {
          let current = row;
          for (let index = 0; index < 100; index++) {
            const started = performance.now();
            try {
              const response = await call("updateRow", {
                ...ids,
                rowId: current.id,
                expectedVersion: current.version,
                expectedSchemaVersion: table.schemaVersion,
                values: { INTEGER_A: Number(current.values.INTEGER_A) + 1 },
              });
              const result = response.value as { row: Row; mutationId: string };
              current = result.row;
              mutationIds.push(result.mutationId);
            } catch (error) {
              errors[errorCode(error)] = (errors[errorCode(error)] ?? 0) + 1;
            }
            timings.push(performance.now() - started);
          }
        }),
      );
      assert.equal(Object.keys(errors).length, 0);
      assert.equal(new Set(mutationIds).size, 1000);
      for (const previous of before) {
        const response = await call("getRow", { ...ids, rowId: previous.id });
        const current = response.value as Row;
        assert.equal(BigInt(current.version), BigInt(previous.version) + 100n);
      }
      const history = (
        await target.pools.owner.query<{ count: string; mutations: string }>(
          "SELECT count(*)::text AS count,count(DISTINCT mutation_id) FILTER(WHERE mutation_id=ANY($5::varchar[]))::text AS mutations FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2 AND field_id=$3 AND row_id=ANY($4::varchar[])",
          [
            ids.orgId,
            ids.tableId,
            integer.id,
            before.map((row) => row.id),
            mutationIds,
          ],
        )
      ).rows[0]!;
      assert.equal(BigInt(history.count), BigInt(baseline) + 1000n);
      assert.equal(history.mutations, "1000");
      const stats = summary(timings);
      results.push({
        id: "HTTP-EDIT-TEN-CLIENTS",
        clients: 10,
        ...stats,
        errors,
        uniqueMutations: 1000,
        committedHistoryEvents: 1000,
        targetP95Ms: 500,
        measuredTargetMet: (stats.p95Ms ?? Infinity) <= 500,
      });
    } else if (scenario === "background") {
      const qaOrgId = ids.orgId,
        userId = newId(),
        sessionId = newId();
      await target.pools.owner.query(
        "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Background performance fixture',$2,true)",
        [userId, `${userId.toLowerCase()}@rootset.example.test`],
      );
      await target.pools.owner.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')",
        [newId(), qaOrgId, userId],
      );
      await target.pools.owner.query(
        "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 day',now())",
        [sessionId, userId, newId()],
      );
      const qaActor: Actor = {
        kind: "session",
        id: sessionId,
        userId,
        orgId: qaOrgId,
        role: "admin",
        scopes: [],
        authenticatedAt: Date.now(),
      };
      report.backgroundSetup = {
        orgId: qaOrgId,
        subject:
          "Explicit local verified identity/session QA fixture, excluded from authentication issuance and browser proof.",
        dataRows: 10000,
        types: 8,
        foregroundRows: 5000000,
        scope:
          "Background work on a separate10,000-row eight-type dataset overlaps indexed reads of the actual5M table; this does not claim5M-row conversion/backup throughput.",
      };
      const setupRuntime = await createRuntime({
        ...target.config,
        baseURL: base.origin,
        databaseURL: target.pools.api.options.connectionString!,
      });
      let adminSecret: string, adminKeyId: string;
      try {
        const issued = getOperation("createPersonalKey").outputSchema.parse(
          await setupRuntime.core.execute(
            "createPersonalKey",
            qaActor,
            {
              orgId: qaOrgId,
              name: "Background performance fixture",
            },
            { surface: "browser", idempotencyKey: newId(), requestId: newId() },
          ),
        ) as { secret: string; key: { id: string } };
        adminSecret = issued.secret;
        adminKeyId = issued.key.id;
      } finally {
        await setupRuntime.close();
      }
      const adminCall = (operation: string, input: Record<string, unknown>) =>
        call(operation, input, { secret: adminSecret });
      try {
        const database = (
          await adminCall("createDatabase", {
            orgId: qaOrgId,
            name: "Background work",
          })
        ).value as { id: string };
        const created = (
          await adminCall("createTable", {
            orgId: qaOrgId,
            databaseId: database.id,
            name: "Eight typed fields",
            fields: [
              { name: "CODE", type: "text", charLimit: 64 },
              { name: "AMOUNT", type: "integer" },
              { name: "FLOAT", type: "float" },
              { name: "FLAG", type: "boolean" },
              { name: "DATE", type: "date" },
              { name: "TIME", type: "time" },
              { name: "STAMP", type: "date-time" },
              { name: "JSON", type: "json" },
            ],
          })
        ).value as {
          table: { id: string; schemaVersion: number };
          fields: { id: string; name: string }[];
        };
        const bg = {
          orgId: qaOrgId,
          databaseId: database.id,
          tableId: created.table.id,
        };
        const payload = Buffer.from(
          Array.from({ length: 10000 }, (_, index) =>
            JSON.stringify({
              CODE: String(index).padStart(6, "0"),
              AMOUNT: index,
              FLOAT: index / 10,
              FLAG: index % 2 === 0,
              DATE: "2026-10-02",
              TIME: "12:34:56Z",
              STAMP: "2026-10-02T12:34:56Z",
              JSON: { group: index % 4, nested: [null, index] },
            }),
          ).join("\n") + "\n",
        );
        const upload = (
          await adminCall("prepareImportUpload", {
            ...bg,
            format: "jsonl",
            byteLength: payload.length,
            checksum: createHash("sha256").update(payload).digest("hex"),
          })
        ).value as {
          artifactId: string;
          uploadUrl: string;
          headers: Record<string, string>;
        };
        const uploadURL = new URL(upload.uploadUrl);
        uploadURL.host = base.host;
        uploadURL.protocol = base.protocol;
        const receipt = await fetch(uploadURL, {
          method: "PUT",
          headers: {
            ...upload.headers,
            Authorization: `Bearer ${adminSecret}`,
          },
          body: payload,
        });
        assert.equal(receipt.status, 200);
        await receipt.arrayBuffer();
        const resources = async () => ({
          database: (
            await target.pools.identity.query(
              "SELECT rootset_control.operator_metrics() AS metrics",
            )
          ).rows[0]!.metrics,
          containers: (
            await run("docker", [
              "stats",
              "--no-stream",
              "--format",
              "{{json .}}",
              ...Object.values(containerNames).map((entry) => entry.Name),
            ])
          ).stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        });
        const phase = async (
          name: string,
          operation: string,
          input: Record<string, unknown>,
        ) => {
          const before = await resources(),
            started = performance.now();
          const admitted = (await adminCall(operation, input)).value as {
            jobId: string;
          };
          assert.equal(typeof admitted.jobId, "string");
          const active: number[] = [],
            complete: number[] = [],
            activeErrors: Record<string, number> = {},
            completeErrors: Record<string, number> = {};
          let state:
            { state: string; result: unknown; error?: unknown } | undefined;
          await measure(
            `HTTP-FOREGROUND-${name}`,
            async (index) => {
              if (index % 20 === 0)
                state = (
                  await adminCall("getJob", {
                    orgId: qaOrgId,
                    id: admitted.jobId,
                  })
                ).value as typeof state;
              const began = performance.now();
              const observedActive =
                state && ["queued", "running"].includes(state.state);
              try {
                await indexed(index);
              } catch (error) {
                const errors = observedActive ? activeErrors : completeErrors;
                errors[errorCode(error)] = (errors[errorCode(error)] ?? 0) + 1;
                throw error;
              } finally {
                (observedActive ? active : complete).push(
                  performance.now() - began,
                );
              }
            },
            500,
          );
          for (let attempt = 0; attempt < 300; attempt++) {
            state = (
              await adminCall("getJob", { orgId: qaOrgId, id: admitted.jobId })
            ).value as typeof state;
            if (
              state &&
              [
                "succeeded",
                "failed",
                "cancelled",
                "partially_completed",
              ].includes(state.state)
            )
              break;
            await indexed(attempt);
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          assert.equal(
            state?.state,
            "succeeded",
            "Actual background job must reach domain-verified success.",
          );
          results.push({
            id: `BACKGROUND-${name}`,
            jobId: admitted.jobId,
            elapsedMs: performance.now() - started,
            foregroundDuringObservedQueuedOrRunning: {
              ...summary(active),
              errors: activeErrors,
              targetP95Ms: 500,
              measuredTargetMet:
                active.length > 0 &&
                (summary(active).p95Ms ?? Infinity) <= 500 &&
                Object.keys(activeErrors).length === 0,
              minimumScenarioRequests: 1000,
              minimumActiveSampleCountMet: active.length >= 1000,
            },
            foregroundAfterObservedTerminal: {
              ...summary(complete),
              errors: completeErrors,
            },
            overlapClassification:
              "Authenticated job state is observed every20requests. Active samples use the latest queued/running observation; completion may occur between polls. Post-terminal samples do not count as concurrent background evidence.",
            observedJob: state,
            resourcesBefore: before,
            resourcesAfter: await resources(),
          });
          assert.ok(
            active.length > 0,
            "Foreground read must actually overlap queued/running work.",
          );
          return state!;
        };
        await phase("IMPORT", "importRows", {
          ...bg,
          expectedSchemaVersion: 1,
          artifactId: upload.artifactId,
          format: "jsonl",
          mapping: Object.fromEntries(
            created.fields.map((field) => [field.name, field.name]),
          ),
          mode: "create",
          batchSize: 100,
        });
        const readSchema = async () =>
          (await adminCall("getTableSchema", bg)).value as typeof created;
        let current = await readSchema();
        const amount = current.fields.find((field) => field.name === "AMOUNT")!;
        await phase("INDEX", "createIndex", {
          ...bg,
          expectedSchemaVersion: current.table.schemaVersion,
          fieldIds: [amount.id],
          kind: "btree",
        });
        current = await readSchema();
        const code = current.fields.find((field) => field.name === "CODE")!;
        await phase("RULE", "createUniqueRule", {
          ...bg,
          expectedSchemaVersion: current.table.schemaVersion,
          fieldIds: [code.id],
        });
        current = await readSchema();
        const float = current.fields.find((field) => field.name === "FLOAT")!;
        await phase("CONVERSION", "applySchemaChange", {
          ...bg,
          expectedSchemaVersion: current.table.schemaVersion,
          change: {
            kind: "update_field",
            fieldId: float.id,
            changes: { type: "text", charLimit: 64 },
            conversion: "explicit",
          },
        });
        await phase("BACKUP-AND-VERIFICATION", "createBackup", {
          orgId: qaOrgId,
          databaseId: database.id,
        });
        const verification = (
          await target.pools.owner.query(
            "SELECT state,verified_at,cleanup_error FROM rootset_control.backups WHERE org_id=$1 AND database_id=$2 ORDER BY created_at DESC LIMIT 1",
            [qaOrgId, database.id],
          )
        ).rows[0]!;
        assert.equal(verification.state, "succeeded");
        assert.ok(verification.verified_at);
        assert.equal(verification.cleanup_error, null);
        const count = (await adminCall("getTableStatistics", bg)).value;
        report.backgroundFinalStatistics = count;
      } finally {
        await target.pools.owner.query(
          "UPDATE rootset_control.api_keys SET revoked_at=now() WHERE id=$1 AND org_id=$2",
          [adminKeyId!, qaOrgId],
        );
      }
    } else if (scenario === "fullscale") {
      const principalId = /^rst_([0-7][0-9A-HJKMNP-TV-Z]{25})_/.exec(
        key.apiKey,
      )?.[1];
      assert.ok(principalId);
      const subject = (
        await target.pools.owner.query(
          "SELECT k.user_id,m.role,u.email_verified FROM rootset_control.api_keys k JOIN rootset_control.memberships m ON m.user_id=k.user_id AND m.org_id=k.org_id JOIN rootset_control.users u ON u.id=k.user_id WHERE k.id=$1 AND k.org_id=$2 AND k.revoked_at IS NULL",
          [principalId, ids.orgId],
        )
      ).rows[0]!;
      assert.ok(subject && subject.role === "admin" && subject.email_verified);
      const sessionId = newId();
      await target.pools.owner.query(
        "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 day',now())",
        [sessionId, subject.user_id, newId()],
      );
      const qaActor: Actor = {
        kind: "session",
        id: sessionId,
        userId: subject.user_id,
        orgId: ids.orgId,
        role: "admin",
        scopes: [],
        authenticatedAt: Date.now(),
      };
      report.fullScaleSetup = {
        rows: 5000000,
        historyEventsAtStart: (
          await target.pools.owner.query(
            "SELECT events::text AS count FROM rootset_control.history_metrics WHERE table_id=$1",
            [ids.tableId],
          )
        ).rows[0]?.count,
        credentialSetup:
          "Explicit trusted local QA session for existing verified current Admin, issuing personal key inheriting Admin authority through actual Core service. Excluded from authentication issuance/step-up/browser proof.",
        targetOnly: true,
      };
      const setupRuntime = await createRuntime({
        ...target.config,
        baseURL: base.origin,
        databaseURL: target.pools.api.options.connectionString!,
      });
      let adminSecret: string, adminKeyId: string;
      try {
        const issued = getOperation("createPersonalKey").outputSchema.parse(
          await setupRuntime.core.execute(
            "createPersonalKey",
            qaActor,
            {
              orgId: ids.orgId,
              name: "Full-scale background performance fixture",
            },
            { surface: "browser", idempotencyKey: newId(), requestId: newId() },
          ),
        ) as { secret: string; key: { id: string } };
        adminSecret = issued.secret;
        adminKeyId = issued.key.id;
      } finally {
        await setupRuntime.close();
      }
      const adminCall = (operation: string, input: Record<string, unknown>) =>
        call(operation, input, { secret: adminSecret });
      const resourceSample = async () => ({
        at: new Date().toISOString(),
        database: (
          await target.pools.identity.query(
            "SELECT rootset_control.operator_metrics() AS metrics",
          )
        ).rows[0]!.metrics,
        disk: (
          await run("docker", [
            "exec",
            container,
            "df",
            "-B1",
            "/recovery/cluster",
          ])
        ).stdout.trim(),
        containers: (
          await run("docker", [
            "stats",
            "--no-stream",
            "--format",
            "{{json .}}",
            ...Object.values(containerNames).map((entry) => entry.Name),
          ])
        ).stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      });
      const phase = async (
        name: string,
        operation: string,
        input: Record<string, unknown>,
      ) => {
        const began = performance.now(),
          before = await resourceSample();
        const admitted = (await adminCall(operation, input)).value as {
          jobId: string;
        };
        assert.equal(typeof admitted.jobId, "string");
        const durations: number[] = [],
          errors: Record<string, number> = {},
          active: number[] = [],
          complete: number[] = [],
          activeErrors: Record<string, number> = {},
          completeErrors: Record<string, number> = {},
          samples: unknown[] = [before];
        let state:
          { state: string; result: unknown; error?: unknown } | undefined;
        for (let index = 0; index < 72000; index++) {
          if (index % 10 === 0)
            state = (
              await adminCall("getJob", {
                orgId: ids.orgId,
                id: admitted.jobId,
              })
            ).value as typeof state;
          const start = performance.now();
          const observedActive =
            state && ["queued", "running"].includes(state.state);
          try {
            await indexed(index % 1000);
          } catch (error) {
            errors[errorCode(error)] = (errors[errorCode(error)] ?? 0) + 1;
            const phaseErrors = observedActive ? activeErrors : completeErrors;
            phaseErrors[errorCode(error)] =
              (phaseErrors[errorCode(error)] ?? 0) + 1;
          }
          const duration = performance.now() - start;
          durations.push(duration);
          (observedActive ? active : complete).push(duration);
          if (index % 100 === 0) {
            samples.push(await resourceSample());
            console.log(
              JSON.stringify({
                scenario: name,
                requests: index + 1,
                state: state?.state,
                errors,
              }),
            );
            report.activeFullScalePhase = {
              name,
              jobId: admitted.jobId,
              requests: index + 1,
              state: state?.state,
              errors,
              observedActiveRequests: active.length,
              observedTerminalRequests: complete.length,
            };
            await writeFile(filename, JSON.stringify(report, null, 2) + "\n", {
              mode: 0o600,
            });
          }
          if (
            durations.length >= 1000 &&
            state &&
            [
              "succeeded",
              "failed",
              "cancelled",
              "partially_completed",
            ].includes(state.state)
          )
            break;
          if (performance.now() - began > 7200000) break;
          if (durations.length >= 1000)
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const observed = {
          id: `FULL-SCALE-${name}`,
          jobId: admitted.jobId,
          elapsedMs: performance.now() - began,
          foregroundOverall: summary(durations),
          foregroundDuringObservedQueuedOrRunning: {
            ...summary(active),
            errors: activeErrors,
            targetP95Ms: 500,
            measuredTargetMet:
              active.length > 0 &&
              (summary(active).p95Ms ?? Infinity) <= 500 &&
              Object.keys(activeErrors).length === 0,
            minimumScenarioRequests: 1000,
            minimumActiveSampleCountMet: active.length >= 1000,
          },
          foregroundAfterObservedTerminal: {
            ...summary(complete),
            errors: completeErrors,
          },
          overlapClassification:
            "Authenticated job state is observed every10requests. Active samples use the latest queued/running observation; completion may occur between polls. Post-terminal samples do not count as concurrent background evidence.",
          errors,
          terminalJob: state,
          resourceSamples: samples,
        };
        results.push(observed);
        await writeFile(filename, JSON.stringify(report, null, 2) + "\n", {
          mode: 0o600,
        });
        assert.equal(
          Object.keys(errors).length,
          0,
          "Foreground reads must remain usable during full-scale work.",
        );
        assert.equal(
          state?.state,
          "succeeded",
          "Full-scale background operation must reach actual domain-verified success.",
        );
        return state!;
      };
      try {
        let current = (await adminCall("getTableSchema", ids)).value as {
          table: { schemaVersion: number };
          fields: { id: string; name: string }[];
        };
        const secondInteger = current.fields.find(
          (field) => field.name === "INTEGER_B",
        )!;
        await phase("INDEX", "createIndex", {
          ...ids,
          expectedSchemaVersion: current.table.schemaVersion,
          fieldIds: [secondInteger.id],
          kind: "btree",
        });
        current = (await adminCall("getTableSchema", ids))
          .value as typeof current;
        const integerField = current.fields.find(
            (field) => field.name === "INTEGER_A",
          )!,
          textField = current.fields.find((field) => field.name === "TEXT_A")!;
        await phase("RULE", "createUniqueRule", {
          ...ids,
          expectedSchemaVersion: current.table.schemaVersion,
          fieldIds: [integerField.id, textField.id],
        });
        current = (await adminCall("getTableSchema", ids))
          .value as typeof current;
        const float = current.fields.find((field) => field.name === "FLOAT_C")!;
        await phase("CONVERSION", "applySchemaChange", {
          ...ids,
          expectedSchemaVersion: current.table.schemaVersion,
          change: {
            kind: "update_field",
            fieldId: float.id,
            changes: { type: "text", charLimit: 64 },
            conversion: "explicit",
          },
        });
        const backup = await phase(
          "BACKUP-AND-ISOLATED-VERIFICATION",
          "createBackup",
          { orgId: ids.orgId, databaseId: ids.databaseId },
        );
        const verified = (
          await target.pools.owner.query(
            "SELECT state,verified_at,cleanup_error,manifest FROM rootset_control.backups WHERE org_id=$1 AND database_id=$2 ORDER BY created_at DESC LIMIT 1",
            [ids.orgId, ids.databaseId],
          )
        ).rows[0]!;
        assert.equal(verified.state, "succeeded");
        assert.ok(verified.verified_at);
        assert.equal(verified.cleanup_error, null);
        report.fullScaleVerifiedBackup = {
          result: backup.result,
          verifiedAt: verified.verified_at,
          manifest: verified.manifest,
        };
      } finally {
        await target.pools.owner.query(
          "UPDATE rootset_control.api_keys SET revoked_at=now() WHERE id=$1 AND org_id=$2",
          [adminKeyId!, ids.orgId],
        );
        await target.pools.owner.query(
          "DELETE FROM rootset_control.sessions WHERE id=$1",
          [sessionId],
        );
      }
    } else if (scenario === "restart") {
      const apiContainer = "rootset-performance-api-1",
        workerContainer = "rootset-performance-worker-1";
      const resources = () =>
        run("docker", [
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          container,
          apiContainer,
          workerContainer,
          "rootset-performance-web-1",
        ]).then((result) =>
          result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      const before = await resources();
      const timings: number[] = [],
        errors: Record<string, number> = {},
        recoveries: Record<string, unknown>[] = [];
      for (let index = 0; index < 1000; index++) {
        const restartName =
          index === 200
            ? apiContainer
            : index === 400
              ? workerContainer
              : index === 600
                ? container
                : undefined;
        if (restartName) {
          const began = performance.now();
          await run("docker", ["restart", "--time", "10", restartName]);
          let successful = false,
            failures = 0;
          for (let attempt = 0; attempt < 60; attempt++) {
            try {
              await indexed(index);
              successful = true;
              break;
            } catch {
              failures++;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
          recoveries.push({
            container: restartName,
            recovered: successful,
            elapsedMs: performance.now() - began,
            observedUnavailableAttempts: failures,
          });
          assert.ok(
            successful,
            "Restarted actual service must recover authorized reads.",
          );
        }
        const began = performance.now();
        try {
          await indexed(index);
        } catch (error) {
          errors[errorCode(error)] = (errors[errorCode(error)] ?? 0) + 1;
        }
        timings.push(performance.now() - began);
        if ((index + 1) % 100 === 0)
          console.log(
            JSON.stringify({
              scenario: "restart",
              requests: index + 1,
              errors,
            }),
          );
      }
      assert.equal(Object.keys(errors).length, 0);
      results.push({
        id: "HTTP-ACTUAL-SERVICE-RESTARTS",
        ...summary(timings),
        errors,
        recoveries,
        resourcesBefore: before,
        resourcesAfter: await resources(),
        scope:
          "Actual capped API, worker and PostgreSQL process restarts;1000 foreground reads span this finite rehearsal. It does not establish an indefinite soak or all job crash boundaries.",
      });
      const page = (await call("queryRows", { ...ids, query: { limit: 1 } }))
        .value as QueryResult;
      const previous = page.data[0]!;
      const idempotencyKey = newId(),
        values = { INTEGER_A: Number(previous.values.INTEGER_A) + 1 };
      const input = {
        ...ids,
        rowId: previous.id,
        expectedVersion: previous.version,
        expectedSchemaVersion: table.schemaVersion,
        values,
      };
      const operation = getOperation("updateRow");
      const path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
        encodeURIComponent(String(input[name as keyof typeof input])),
      );
      const body = JSON.stringify({
        expectedVersion: input.expectedVersion,
        expectedSchemaVersion: input.expectedSchemaVersion,
        values,
      });
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest(new URL(path, base), {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${key.apiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "Idempotency-Key": idempotencyKey,
            "If-Match": `"${previous.id}:${previous.version}"`,
          },
        });
        request.once("error", () => resolve());
        request.once("response", (response) => {
          response.destroy();
          resolve();
        });
        request.once("finish", () => setTimeout(() => request.destroy(), 1));
        request.setTimeout(16000, () => {
          request.destroy();
          reject(new Error("Lost-response fixture timeout."));
        });
        request.end(body);
      });
      const reconciled = (await call("updateRow", input, { idempotencyKey }))
        .value as { row: Row; mutationId: string };
      assert.equal(
        BigInt(reconciled.row.version),
        BigInt(previous.version) + 1n,
      );
      assert.equal(reconciled.row.values.INTEGER_A, values.INTEGER_A);
      assert.equal(
        (
          await target.pools.owner.query(
            "SELECT count(*)::integer AS count FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2 AND row_id=$3 AND field_id=$4 AND new_version=$5 AND mutation_id=$6",
            [
              ids.orgId,
              ids.tableId,
              previous.id,
              integer.id,
              reconciled.row.version,
              reconciled.mutationId,
            ],
          )
        ).rows[0]!.count,
        1,
      );
      results.push({
        id: "HTTP-NETWORK-RESPONSE-LOSS",
        socketClosedAfterRequestFinish: true,
        replayVersion: reconciled.row.version,
        mutationId: reconciled.mutationId,
        matchingCommittedCellEvents: 1,
        scope:
          "Real client socket close around request completion; replay reconciles either absent or committed initial attempt to one revision/event. Initial outcome is deliberately unknown.",
      });
    } else if (scenario === "network") {
      const pg: number[] = [],
        http: number[] = [];
      for (let index = 0; index < 1000; index++) {
        let start = performance.now();
        await target.pools.api.query("SELECT 1");
        pg.push(performance.now() - start);
        start = performance.now();
        const response = await fetch(new URL("/health/live", base), {
          signal: AbortSignal.timeout(2000),
        });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        http.push(performance.now() - start);
      }
      results.push(
        {
          id: "NODE-TO-POSTGRES-ROUNDTRIP",
          ...summary(pg),
          scope:
            "Host benchmark process to loopbackPostgreSQL; API-container network segment is separately required.",
        },
        {
          id: "CLIENT-TO-SHIPPED-API-ROUNDTRIP",
          ...summary(http),
          scope:
            "Host HTTPclient to actual shipped route through capped web/API server, application processing included.",
        },
      );
      const containerProbe = `const net=await import('node:net'); const {performance}=await import('node:perf_hooks'); const u=new URL(process.env.ROOTSET_DATABASE_URL); const values=[]; for(let i=0;i<1000;i++){const start=performance.now(); await new Promise((resolve,reject)=>{const socket=net.createConnection({host:u.hostname,port:Number(u.port||5432)});socket.setTimeout(2000,()=>socket.destroy(new Error('Timeout')));socket.once('error',reject);socket.once('connect',()=>{values.push(performance.now()-start);socket.destroy();resolve();});});} values.sort((a,b)=>a-b);const at=p=>values[Math.ceil(values.length*p)-1];process.stdout.write(JSON.stringify({requests:values.length,p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:values.at(-1)}));`;
      const apiToPostgres = JSON.parse(
        (
          await run("docker", [
            "exec",
            "rootset-performance-api-1",
            "node",
            "--input-type=module",
            "-e",
            containerProbe,
          ])
        ).stdout,
      );
      assert.ok(apiToPostgres.p95Ms <= 10);
      assert.ok((summary(http).p95Ms ?? Infinity) <= 50);
      results.push({
        id: "API-CONTAINER-TO-POSTGRES-TCP-ROUNDTRIP",
        ...apiToPostgres,
        scope:
          "Actual shipped API-container network namespace to configured PostgreSQL endpoint; sequential TCP handshakes measure network path, not authenticated SQL processing. SQL query timings are separate.",
      });
    } else
      throw new Error(
        "Choose cold, warm, scans, edit10, background, fullscale, restart or network.",
      );
    report.result = "finished";
  } catch (error) {
    report.result = "failed";
    report.error = {
      code: errorCode(error),
      name: error instanceof Error ? error.name : "Unknown",
    };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.sourceAtEnd = await sourceProvenance();
    report.finalDatabase =
      (
        await target.pools.identity
          .query("SELECT rootset_control.operator_metrics() AS metrics")
          .catch(() => ({ rows: [] }))
      ).rows[0]?.metrics ?? null;
    await writeFile(filename, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    await target.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const [manifest, port, container, baseURL, scenario] = process.argv.slice(2);
  if (!manifest || !port || !container || !baseURL || !scenario)
    throw new Error(
      "Pass manifest, isolated target port/container, actual HTTPbaseURL and scenario.",
    );
  try {
    await runHttpProfile(manifest, Number(port), container, baseURL, scenario);
  } catch (error) {
    console.error(
      JSON.stringify({
        result: "failed",
        code: errorCode(error),
        name: error instanceof Error ? error.name : "Unknown",
      }),
    );
    process.exitCode = 1;
  }
}
