import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import {
  newId,
  scopeNames,
  RootsetError,
  type Actor,
} from "@rootset/contracts";
import { TableStorage } from "../../../packages/table-storage/src/index.ts";
import {
  JobsService,
  type JobsConfig,
} from "../../../packages/jobs/src/index.ts";
import { RootsetCore, type CoreOptions } from "@rootset/core";
import type { Config } from "@rootset/core/config";
import type { IdentityService } from "../../../packages/identity/src/index.ts";
import type { IsolatedDatabase } from "../../../tools/verification/isolated-database.ts";
import { MetadataPaging } from "../../../packages/core/src/paging.ts";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "@rootset/contracts";
import { loadConfig } from "@rootset/core/config";
import { createPool, migrate } from "@rootset/database";
import { nativeTestDatabaseURLs } from "./native-test-database.js";

type Input = Record<string, unknown>;
const object = (value: unknown): Input => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Input;
};
const string = (value: unknown) => {
  assert(typeof value === "string" && value.length > 0);
  return value;
};
function validateArchiveBytes(
  bytes: Buffer,
  archive: Input,
  artifact: Input,
  orgId: string,
  tableId: string,
) {
  const manifest = object(archive.manifest),
    checksum = createHash("sha256").update(bytes).digest("hex");
  assert.equal(checksum, manifest.checksum);
  assert.equal(checksum, artifact.checksum);
  assert.equal(bytes.length, Number(manifest.byteLength));
  assert.equal(bytes.length, Number(artifact.sizeBytes));
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  assert(text.endsWith("\n"));
  let cells = 0,
    rows = 0;
  for (const line of text.slice(0, -1).split("\n")) {
    const frame = object(JSON.parse(line)),
      event = object(frame.data);
    assert.equal(event.org_id, orgId);
    assert.equal(event.table_id, tableId);
    assert(["cell", "row"].includes(String(frame.recordType)));
    if (frame.recordType === "cell") cells++;
    else rows++;
  }
  assert.equal(cells, Number(archive.cell_count));
  assert.equal(rows, Number(archive.row_count));
  return { checksum, byteLength: bytes.length, cells, rows };
}

export interface NativeRegressionInput {
  fixture: IsolatedDatabase;
  config: Config;
  artifactConfig: JobsConfig["artifacts"];
  constructors: { Core: typeof RootsetCore; Jobs: typeof JobsService };
  mode: "red" | "green";
}
const denied = (code: string) => (error: unknown) =>
  error instanceof RootsetError && error.code === code;
async function finite<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(label + " deadline; producer join not established"),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Root executes this on its fresh isolated55467 PostgreSQL/provider fixture.
// Auth is deliberately controlled component state, separate from the genuine
// installed session/personal/OAuth addon. No native history/tombstone is seeded.
export async function runNativeRetainedArchiveRegression(
  input: NativeRegressionInput,
  signal: AbortSignal,
) {
  const { fixture: db, config, constructors, mode } = input;
  assert(/^rootset_verify_[a-z0-9]+$/.test(db.name));
  const rolePools = [db.owner, db.app, db.ddl, db.identity],
    variables = [
      "ROOTSET_TEST_DATABASE_URL",
      "ROOTSET_TEST_APP_DATABASE_URL",
      "ROOTSET_TEST_DDL_DATABASE_URL",
      "ROOTSET_TEST_IDENTITY_DATABASE_URL",
    ];
  const environment: Record<string, string | undefined> = {
    CI: process.env.CI,
  };
  rolePools.forEach((pool, i) => {
    assert(pool.options.connectionString);
    environment[variables[i]!] = pool.options.connectionString;
  });
  const bound = nativeTestDatabaseURLs(environment);
  assert(bound.every((url) => url.pathname === "/" + db.name));
  assert.equal(
    Number(
      (
        await db.owner.query(
          "SELECT count(*)::text AS n FROM rootset_control.organisations",
        )
      ).rows[0].n,
    ),
    0,
    "Component fixture must be fresh, not inherited AF accounts/schema",
  );
  const owner: Actor = {
    kind: "operator",
    id: newId(),
    orgId: newId(),
    role: "owner",
    scopes: [...scopeNames],
    targets: [],
    unrestricted: true,
    operator: false,
  };
  const current = new Map<string, Actor>(),
    revoked = new Set<string>();
  current.set(owner.id, owner);
  const identity = {
    async refreshActor(incoming: Actor) {
      if (revoked.has(incoming.id))
        throw new RootsetError(
          "UNAUTHENTICATED",
          "Controlled component actor is revoked",
          401,
        );
      const actual = current.get(incoming.id);
      assert(actual && actual.orgId === incoming.orgId);
      return actual;
    },
  } as unknown as IdentityService;
  const storage = new TableStorage({
    pool: db.app,
    ddlPool: db.ddl,
    cursorSecret: randomBytes(32).toString("hex"),
  });
  const jobs: JobsService = new constructors.Jobs({
    pool: db.app,
    ddlPool: db.ddl,
    storage,
    config: {
      idempotencySecret: randomBytes(32).toString("hex"),
      metadataPaging: new MetadataPaging(randomBytes(32).toString("hex")),
      artifacts: input.artifactConfig,
      organisationIds: async () => [owner.orgId],
    },
    authorise: (actor, operation, target) =>
      core!.authorise(actor, operation, { ...target }),
  });
  const unusedInstallation = {
    execute() {
      throw new Error("Installation component is outside this regression");
    },
  } as unknown as CoreOptions["installation"];
  const core = new constructors.Core({
    storage,
    jobs,
    identity,
    pool: db.app,
    identityPool: db.identity,
    config,
    installation: unusedInstallation,
  });
  const receipts: Input[] = [];
  async function record(value: Input) {
    receipts.push({
      ...value,
      mode,
      controlledAuthComponentOnly: true,
      genuineInstalledAuthorityProof: false,
    });
  }
  try {
    await db.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
      [owner.orgId, "Retained archive component " + newId()],
    );
    const foreignActor: Actor = { ...owner, id: newId(), orgId: newId() };
    current.set(foreignActor.id, foreignActor);
    await db.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)",
      [foreignActor.orgId, "Unrelated retained component " + newId()],
    );
    const foreignDatabase = await storage.createDatabase(foreignActor, {
      name: "Unrelated native database",
      idempotencyKey: newId(),
    });
    const foreignTable = await storage.createTable(
      foreignActor,
      foreignDatabase.id,
      { name: "Unrelated native table", fields: [], idempotencyKey: newId() },
    );
    const unrelatedDatabase = await storage.createDatabase(owner, {
      name: "Unrelated own database",
      idempotencyKey: newId(),
    });
    const unrelatedTable = await storage.createTable(
      owner,
      unrelatedDatabase.id,
      { name: "Unrelated own table", fields: [], idempotencyKey: newId() },
    );
    async function terminal(id: string) {
      const deadline = performance.now() + 60_000;
      for (;;) {
        signal.throwIfAborted();
        assert(
          performance.now() < deadline,
          "Actual archive job exceeded60s component budget",
        );
        await jobs.runOnce(owner.orgId);
        const job = object(await jobs.execute("getJob", owner, { id }));
        if (!["queued", "running"].includes(String(job.state))) {
          assert.equal(job.state, "succeeded");
          return object(job.result);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (const branch of ["table", "database"] as const) {
      signal.throwIfAborted();
      const database = await storage.createDatabase(owner, {
        name: "Retained " + branch,
        idempotencyKey: newId(),
      });
      const table = await storage.createTable(owner, database.id, {
        name: "Retained events",
        fields: [
          { apiKey: "TEXT", label: "Text", type: "text", charLimit: 128 },
          { apiKey: "DATA", label: "Data", type: "json" },
        ],
        idempotencyKey: newId(),
      });
      for (const n of [1, 2, 3])
        await storage.createRow(
          owner,
          table.id,
          {
            TEXT: "original " + n,
            DATA: { literal: { tableId: table.id }, ordinal: n },
          },
          { idempotencyKey: newId() },
        );
      const target = {
        orgId: owner.orgId,
        databaseId: database.id,
        tableId: table.id,
      };
      const counts = (
        await db.owner.query(
          "SELECT (SELECT count(*)::text FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2) AS cells,(SELECT count(*)::text FROM rootset_control.row_events WHERE org_id=$1 AND table_id=$2) AS rows,to_char((date_trunc('milliseconds',max(changed_at))+interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS cutoff FROM (SELECT changed_at FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2 UNION ALL SELECT changed_at FROM rootset_control.row_events WHERE org_id=$1 AND table_id=$2) events",
          [owner.orgId, table.id],
        )
      ).rows[0];
      assert.equal(counts.cells, "6");
      assert.equal(counts.rows, "3");
      assert(counts.cutoff);
      const pastDeadline = performance.now() + 1000;
      for (;;) {
        const actual = (
          await db.owner.query(
            "SELECT $1::timestamptz<clock_timestamp() AS past",
            [counts.cutoff],
          )
        ).rows[0].past;
        if (actual && Date.parse(counts.cutoff) < Date.now()) break;
        assert(performance.now() < pastDeadline);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const admitted = object(
        await jobs.execute(
          "archiveHistory",
          owner,
          { ...target, before: counts.cutoff },
          { idempotencyKey: newId() },
        ),
      );
      const result = await terminal(string(admitted.jobId)),
        archiveId = string(result.archiveId);
      const native = object(
        (
          await db.owner.query(
            "SELECT id,table_id,job_id,artifact_id,state,cell_count::text,row_count::text,manifest,verified_at FROM rootset_control.history_archives WHERE org_id=$1 AND id=$2",
            [owner.orgId, archiveId],
          )
        ).rows[0],
      );
      assert.equal(native.state, "succeeded");
      assert(native.verified_at);
      assert.equal(native.cell_count, "6");
      assert.equal(native.row_count, "3");
      const actors = [
        owner,
        ...(["admin", "editor", "viewer"] as const).map((role) => ({
          ...owner,
          id: newId(),
          role,
          unrestricted: false,
          targets: [
            {
              databaseId: database.id,
              tableId: table.id,
              level: "manage" as const,
            },
          ],
        })),
      ];
      const inheritance: Actor[] = [
        { ...actors[2]!, id: newId(), targets: [{ level: "manage" }] },
        {
          ...actors[2]!,
          id: newId(),
          targets: [{ tableId: table.id, level: "manage" }],
        },
      ];
      for (const actor of [...actors, ...inheritance])
        current.set(actor.id, actor);
      const reader = {
        ...actors[3]!,
        id: newId(),
        targets: [
          {
            databaseId: database.id,
            tableId: table.id,
            level: "read" as const,
          },
        ],
      };
      current.set(reader.id, reader);
      const fresh = async (actor: Actor, id: string, body: Input) =>
        core!.execute(id, actor, body, {
          surface: "rest",
          idempotencyKey: newId(),
        });
      const baselineArtifact = object(
        await fresh(owner, "getArtifact", {
          orgId: owner.orgId,
          id: native.artifact_id,
        }),
      );
      async function allow(actor: Actor, label: string) {
        const get = object(
          await fresh(actor, "getHistoryArchive", { ...target, id: archiveId }),
        );
        assert.equal(get.id, archiveId);
        assert.equal(get.artifactId, native.artifact_id);
        const list = object(await fresh(actor, "listHistoryArchives", target));
        assert(Array.isArray(list.data));
        assert(list.data.map(object).some((r) => r.id === archiveId));
        const artifact = object(
          await fresh(actor, "getArtifact", {
            orgId: owner.orgId,
            id: native.artifact_id,
          }),
        );
        assert.deepEqual(artifact, baselineArtifact);
        const download = await jobs.downloadArtifact(
          await identity.refreshActor(actor),
          string(native.artifact_id),
        );
        assert(download.byteLength <= 8 * 1024 * 1024);
        const chunks: Buffer[] = [];
        let bytes = 0;
        const closed = finished(download.stream, { cleanup: true });
        void closed.catch(() => undefined);
        const consumerTask = (async () => {
          for await (const chunk of download.stream) {
            signal.throwIfAborted();
            const b = Buffer.from(chunk);
            bytes += b.length;
            assert(bytes <= download.byteLength);
            chunks.push(b);
          }
        })();
        const consumerSettled = consumerTask.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
        const stop = () =>
          download.stream.destroy(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Component consumer aborted"),
          );
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        let primary: unknown;
        try {
          await finite(
            consumerTask,
            30_000,
            "actual product archive plaintext",
          );
        } catch (error) {
          primary = error;
          download.stream.destroy(
            error instanceof Error
              ? error
              : new Error("Component consumer failed"),
          );
        }
        const closedSettled = closed.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
        const cleanup = await Promise.allSettled([
          finite(closedSettled, 5000, "actual product stream closure"),
          finite(consumerSettled, 5000, "actual product consumer settlement"),
        ]);
        signal.removeEventListener("abort", stop);
        const failures = cleanup
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (primary || failures.length)
          throw new AggregateError(
            [primary, ...failures].filter(Boolean),
            "Actual component product stream/consumer must be joined before next request or provider teardown",
          );
        const streamClosure = await closedSettled;
        assert(
          streamClosure.ok,
          "Product stream closure settled with a failed result",
        );
        const consumption = await consumerSettled;
        assert(consumption.ok, "Product consumer settled with a failed result");
        const content = Buffer.concat(chunks, bytes),
          values = validateArchiveBytes(
            content,
            native,
            artifact,
            owner.orgId,
            table.id,
          );
        await record({
          branch,
          phase: label,
          actorRole: actor.role,
          archiveId,
          ...values,
          actualNodeStreamEOFAndClose: true,
          asynchronousProductSpoolCleanupNotJoinedByThisReceipt: true,
        });
      }
      await allow(reader, "active-read-grant-positive");
      if (branch === "table")
        await storage.deleteTable(owner, table.id, {
          expectedSchemaVersion: table.schemaVersion,
          idempotencyKey: newId(),
        });
      else
        await storage.deleteDatabase(owner, database.id, {
          idempotencyKey: newId(),
        });
      const retained = (
        await db.owner.query(
          "SELECT t.state AS table_state,d.state AS database_state FROM rootset_control.tables t JOIN rootset_control.databases d ON d.id=t.database_id AND d.org_id=t.org_id WHERE t.org_id=$1 AND t.id=$2",
          [owner.orgId, table.id],
        )
      ).rows[0];
      assert.equal(retained.table_state, "deleted");
      assert.equal(
        retained.database_state,
        branch === "table" ? "active" : "deleted",
      );
      const frozen = async () => {
        const history = (
          await db.owner.query(
            "SELECT md5(row_to_json(a)::text) AS digest FROM rootset_control.history_archives a WHERE org_id=$1 AND id=$2",
            [owner.orgId, archiveId],
          )
        ).rows[0];
        const counts = (
          await db.owner.query(
            "SELECT (SELECT count(*)::text FROM rootset_control.jobs WHERE org_id=$1) AS jobs,(SELECT count(*)::text FROM rootset_control.cell_changes WHERE org_id=$1 AND table_id=$2) AS cells,(SELECT count(*)::text FROM rootset_control.row_events WHERE org_id=$1 AND table_id=$2) AS events",
            [owner.orgId, table.id],
          )
        ).rows[0];
        return { history, counts };
      };
      const before = await frozen();
      if (mode === "red") {
        for (const id of [
          "getHistoryArchive",
          "listHistoryArchives",
          "getArtifact",
        ]) {
          await assert.rejects(
            fresh(
              owner,
              id,
              id === "getArtifact"
                ? { orgId: owner.orgId, id: native.artifact_id }
                : {
                    ...target,
                    ...(id === "getHistoryArchive" ? { id: archiveId } : {}),
                  },
            ),
            denied("RESOURCE_NOT_FOUND"),
          );
        }
        await assert.rejects(
          jobs.downloadArtifact(owner, string(native.artifact_id)),
          denied("RESOURCE_NOT_FOUND"),
        );
        await record({
          branch,
          phase: "actual-baseline-tombstone-read-refusal",
          archiveId,
          retainedArtifactSha256: baselineArtifact.checksum,
          redDemonstrated: true,
        });
      } else {
        for (const actor of [...actors, ...inheritance])
          await allow(actor, "retained-explicit-management-positive");
        const standalone = new constructors.Jobs({
          pool: db.app,
          ddlPool: db.ddl,
          storage,
          config: jobs.config,
        });
        try {
          for (const actor of inheritance)
            for (const operation of [
              "getHistoryArchive",
              "listHistoryArchives",
            ]) {
              const actual = object(
                await standalone.execute(
                  operation,
                  actor,
                  {
                    ...target,
                    ...(operation === "getHistoryArchive"
                      ? { id: archiveId }
                      : {}),
                  },
                  { idempotencyKey: newId() },
                ),
              );
              if (operation === "getHistoryArchive")
                assert.equal(actual.id, archiveId);
              else {
                assert(Array.isArray(actual.data));
                assert(
                  actual.data.map(object).some((row) => row.id === archiveId),
                );
              }
            }
          await record({
            branch,
            phase: "actual-standalone-org-wide-table-only-positive",
            archiveId,
            configuredCallbackAbsent: true,
            controlledCurrentActorSupplied: true,
          });
        } finally {
          standalone.artifacts.client.destroy();
        }
        for (const actor of [
          { ...actors[2]!, id: newId(), unrestricted: true, targets: [] },
          {
            ...owner,
            id: newId(),
            unrestricted: false,
            targets: [
              {
                databaseId: database.id,
                tableId: table.id,
                level: "read" as const,
              },
            ],
          },
          {
            ...actors[2]!,
            id: newId(),
            targets: [{ databaseId: newId(), level: "manage" as const }],
          },
          {
            ...actors[2]!,
            id: newId(),
            targets: [{ tableId: newId(), level: "manage" as const }],
          },
          reader,
          { ...actors[2]!, id: newId(), targets: [] },
        ]) {
          current.set(actor.id, actor);
          for (const id of [
            "getHistoryArchive",
            "listHistoryArchives",
            "getArtifact",
          ])
            await assert.rejects(
              fresh(
                actor,
                id,
                id === "getArtifact"
                  ? { orgId: owner.orgId, id: native.artifact_id }
                  : {
                      ...target,
                      ...(id === "getHistoryArchive" ? { id: archiveId } : {}),
                    },
              ),
              denied("RESOURCE_NOT_FOUND"),
            );
          await assert.rejects(
            jobs.downloadArtifact(actor, string(native.artifact_id)),
            denied("RESOURCE_NOT_FOUND"),
          );
        }
        const old = actors[2]!;
        current.set(old.id, {
          ...old,
          targets: [
            { databaseId: database.id, tableId: table.id, level: "read" },
          ],
        });
        await assert.rejects(
          fresh(old, "getHistoryArchive", { ...target, id: archiveId }),
          denied("RESOURCE_NOT_FOUND"),
        );
        current.set(old.id, old);
        revoked.add(old.id);
        await assert.rejects(
          fresh(old, "getHistoryArchive", { ...target, id: archiveId }),
          denied("UNAUTHENTICATED"),
        );
        revoked.delete(old.id);
        const noScope = { ...owner, id: newId(), scopes: ["rows:read"] };
        current.set(noScope.id, noScope);
        await assert.rejects(
          fresh(noScope, "getHistoryArchive", { ...target, id: archiveId }),
          denied("INSUFFICIENT_SCOPE"),
        );
        for (const wrong of [
          { ...target, databaseId: unrelatedDatabase.id },
          { ...target, tableId: unrelatedTable.id },
          {
            orgId: foreignActor.orgId,
            databaseId: foreignDatabase.id,
            tableId: foreignTable.id,
          },
        ])
          await assert.rejects(
            fresh(owner, "getHistoryArchive", { ...wrong, id: archiveId }),
            denied("RESOURCE_NOT_FOUND"),
          );
        for (const [id, body] of [
          ["getHistoryRetentionPolicy", target],
          ["archiveHistory", { ...target, before: counts.cutoff }],
          [
            "updateTable",
            {
              ...target,
              expectedSchemaVersion: table.schemaVersion,
              name: "Denied",
            },
          ],
        ] as const)
          await assert.rejects(
            core.authorise(owner, id, body),
            denied("RESOURCE_NOT_FOUND"),
          );
        await record({
          branch,
          phase: "actual-native-negative-guards",
          noManageAndReadDenied: true,
          revokedOriginalControlledActorDenied: true,
          noScopeDenied: true,
          wrongParentTargetOrgDenied: true,
          activeOnlyMutationAndPolicyDenied: true,
        });
      }
      assert.deepEqual(
        await frozen(),
        before,
        "Read/permission regression must not mutate native retained catalog, hot history or job count",
      );
    }
    return {
      kind: "rootset-native-retained-archive-regression-v1",
      mode,
      receipts,
      controlledAuthComponentOnly: true,
      actualArchiveWorkerNativeCatalogAndProductProviderPlaintext: true,
      genuineInstalledAuthorityProof: false,
      gateAcceptance: false,
    };
  } finally {
    try {
      // Only this fresh component organisation's actual owned object records
      // are removed. This fixture teardown is separate from product retention.
      const artifacts = (
        await db.owner.query(
          "SELECT * FROM rootset_control.artifacts WHERE org_id=$1",
          [owner.orgId],
        )
      ).rows;
      for (const artifact of artifacts) {
        assert(
          String(artifact.object_key).startsWith(`rootset/${owner.orgId}/`),
        );
        await jobs.artifacts.remove(owner, artifact);
      }
    } finally {
      jobs.artifacts.client.destroy();
    }
  }
}

test(
  "retained archive reads preserve current management authority after real table and database tombstones",
  {
    timeout: 120_000,
    skip:
      process.env.ROOTSET_RETAINED_ARCHIVE_COMPONENT !== "1" &&
      process.env.CI !== "true",
  },
  async (t) => {
    // The caller supplies only admitted role URLs; there is no environment-file
    // loader and no inherited fixture/database/provider data fallback.
    const urls = nativeTestDatabaseURLs(process.env),
      config = loadConfig();
    const name = `rootset_verify_${newId().toLowerCase()}`,
      admin = createPool(urls[0]!.toString(), 1),
      pools: ReturnType<typeof createPool>[] = [];
    let created = false,
      closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await Promise.all(pools.map((pool) => pool.end()));
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    };
    let fixture: IsolatedDatabase;
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      for (const url of urls) {
        const target = new URL(url);
        target.pathname = "/" + name;
        pools.push(createPool(target.toString(), 4));
      }
      const [owner, app, ddl, identity] = pools;
      assert(owner && app && ddl && identity);
      fixture = {
        name,
        owner,
        app,
        ddl,
        identity,
        appliedMigrations: await migrate(owner),
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
    try {
      const result = await runNativeRetainedArchiveRegression(
        {
          fixture,
          config,
          constructors: { Core: RootsetCore, Jobs: JobsService },
          mode: "green",
          artifactConfig: {
            ...config.artifacts,
            forcePathStyle: true,
            encryptionKeys: config.encryptionKeys,
            activeKeyId: config.activeEncryptionKeyId,
          },
        },
        AbortSignal.timeout(120_000),
      );
      assert.equal(result.mode, "green");
      assert(result.receipts.length > 0);
      t.diagnostic(
        "Actual PostgreSQL/catalog/archive-worker/provider and Core/Jobs/artifact permission paths; controlled current actors, separate from genuine installed session/key/OAuth verification.",
      );
      assert(canonicalJson(result).length > 0);
    } finally {
      await fixture.close();
    }
  },
);
