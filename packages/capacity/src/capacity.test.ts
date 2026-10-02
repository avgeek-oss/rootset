import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool, migrate, transaction, withOrg } from "@rootset/database";
import { newId, RootsetError } from "@rootset/contracts";
import {
  CapacityService,
  CapacityConfigurationSchema,
  mapCapacityError,
} from "./index";
import { reportPostgresFilesystem } from "./reporter";

try {
  process.loadEnvFile(
    fileURLToPath(new URL("../../../.env.test", import.meta.url)),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const url = process.env.ROOTSET_TEST_DATABASE_URL;

function assertPrivateCapacityError(error: unknown, code: string): boolean {
  assert.ok(error instanceof RootsetError);
  assert.equal(error.code, code);
  assert.equal(error.status, 503);
  assert.equal(error.details, undefined);
  assert.doesNotMatch(
    JSON.stringify(error),
    /installationUsedBytes|organisationUsedBytes|availableBytes|claimedBytes|minimumFreeBytes|maximumAgeSeconds|actualGrowthBytes/,
  );
  return true;
}

test("Public capacity errors discard every SQL detail, including unknown and nested measurements", () => {
  for (const detail of [
    JSON.stringify({
      installationUsedBytes: "987654321",
      organisationUsedBytes: "87654321",
      requestedBytes: "123",
      operation: "mutateRows",
      availableBytes: "12",
      claimedBytes: "11",
      minimumFreeBytes: "10",
      unknown: { password: "never-public" },
    }),
    "malformed detail",
  ])
    assertPrivateCapacityError(
      mapCapacityError({
        code: "P0001",
        message: "ROOTSET_CAPACITY:STORAGE_QUOTA_EXCEEDED",
        detail,
      }),
      "STORAGE_QUOTA_EXCEEDED",
    );
  assert.equal(mapCapacityError(null), null);
});

test("Capacity configuration preserves null limits and validates exact byte strings", () => {
  const value = CapacityConfigurationSchema.parse({});
  assert.equal(value.installationQuotaBytes, null);
  assert.equal(value.defaultOrganisationQuotaBytes, null);
  assert.equal(value.minimumFreeBytes, null);
  for (const invalid of [
    "-1",
    "1.5",
    "01",
    "1e9",
    "9223372036854775808",
    9007199254740992,
  ])
    assert.equal(
      CapacityConfigurationSchema.safeParse({ installationQuotaBytes: invalid })
        .success,
      false,
    );
  const id = newId();
  assert.equal(
    CapacityConfigurationSchema.safeParse({
      organisationOverrides: [
        { orgId: id, quotaBytes: "1" },
        { orgId: id, quotaBytes: null },
      ],
    }).success,
    false,
  );
});

test(
  "MDM92 ROW11 OPS06 PostgreSQL quota reservations, native guards, rollback, disk reports and readable existing rows",
  { skip: !url },
  async (t) => {
    const admin = new Pool({ connectionString: url, max: 4 });
    const database = `rootset_capacity_${randomBytes(6).toString("hex")}`;
    let owner: Pool | undefined,
      identity: Pool | undefined,
      app: Pool | undefined;
    try {
      await admin.query(
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rootset_capacity_reporter') THEN CREATE ROLE rootset_capacity_reporter NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
      );
      await admin.query(`CREATE DATABASE "${database}"`);
      const ownerURL = new URL(url!);
      ownerURL.pathname = `/${database}`;
      owner = new Pool({ connectionString: ownerURL.toString(), max: 8 });
      await migrate(owner);
      const poolFor = (environment: string, user: string): Pool => {
        const target = new URL(process.env[environment] ?? ownerURL.toString());
        target.pathname = `/${database}`;
        target.username = user;
        return new Pool({ connectionString: target.toString(), max: 8 });
      };
      identity = poolFor(
        "ROOTSET_TEST_IDENTITY_DATABASE_URL",
        "rootset_identity",
      );
      app = poolFor("ROOTSET_TEST_APP_DATABASE_URL", "rootset_app");
      const capacity = new CapacityService(identity);
      const orgId = newId(),
        otherOrgId = newId(),
        dbId = newId(),
        otherDbId = newId();
      const schema = `rsd_${dbId.toLowerCase()}`,
        otherSchema = `rsd_${otherDbId.toLowerCase()}`;
      for (const [org, db, namespace] of [
        [orgId, dbId, schema],
        [otherOrgId, otherDbId, otherSchema],
      ]) {
        await owner.query(
          "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Capacity verification')",
          [org],
        );
        await owner.query(
          "INSERT INTO rootset_control.databases(id,org_id,name,schema_name) VALUES($1,$2,'Capacity data',$3)",
          [db, org, namespace],
        );
        await owner.query(
          `CREATE SCHEMA "${namespace}"; CREATE TABLE "${namespace}".capacity_native(id text PRIMARY KEY,payload text NOT NULL); ALTER TABLE "${namespace}".capacity_native ENABLE ROW LEVEL SECURITY; ALTER TABLE "${namespace}".capacity_native FORCE ROW LEVEL SECURITY; CREATE POLICY org_isolation ON "${namespace}".capacity_native USING(current_setting('rootset.org_id',true)='${org}') WITH CHECK(current_setting('rootset.org_id',true)='${org}'); GRANT USAGE ON SCHEMA "${namespace}" TO rootset_app; GRANT SELECT,INSERT,UPDATE,DELETE ON "${namespace}".capacity_native TO rootset_app; CREATE TRIGGER rootset_capacity_guard BEFORE INSERT OR UPDATE OR DELETE ON "${namespace}".capacity_native FOR EACH STATEMENT EXECUTE FUNCTION rootset_control.enforce_capacity_admission('${org}')`,
        );
      }
      const configure = (patch: Parameters<CapacityService["configure"]>[1]) =>
        transaction(identity!, (c) => capacity.configure(c, patch));
      const status = () =>
        withOrg(identity!, orgId, (c) => capacity.status(c, orgId));
      await t.test(
        "Actual usage includes native allocation and retained MDM control tuples; unconfigured quota/free space are null",
        async () => {
          const result = await status();
          assert.ok(BigInt(result.installation.usedBytes) > 0n);
          assert.ok(BigInt(result.organisation!.nativeRelationBytes) > 0n);
          assert.ok(
            BigInt(result.organisation!.retainedControlTupleBytes) > 0n,
          );
          assert.equal(result.installation.quotaBytes, null);
          assert.equal(result.organisation!.quotaBytes, null);
          assert.equal(result.disk.minimumFreeBytes, null);
          assert.equal(result.disk.reportedAvailableBytes, null);
          assert.equal(result.admission.enabled, false);
          await assert.rejects(
            () => capacity.status(identity, otherOrgId),
            (error) => (error as { code: string }).code === "42501",
          );
        },
      );
      await t.test(
        "Organisation quota refuses growth before mutation while prior rows stay readable",
        async () => {
          await withOrg(app!, orgId, (c) =>
            c.query(
              `INSERT INTO "${schema}".capacity_native VALUES('prior','Readable before pressure')`,
            ),
          );
          const before = (await status()).organisation!;
          await configure({
            organisationOverrides: [
              {
                orgId,
                quotaBytes: (BigInt(before.usedBytes) + 1048576n).toString(),
              },
            ],
          });
          await assert.rejects(
            () =>
              withOrg(app!, orgId, (c) =>
                capacity.run(
                  c,
                  orgId,
                  { reserveBytes: 1048577n, operation: "mutateRows" },
                  () =>
                    c.query(
                      `INSERT INTO "${schema}".capacity_native VALUES('refused','never committed')`,
                    ),
                ),
              ),
            (error) =>
              assertPrivateCapacityError(error, "STORAGE_QUOTA_EXCEEDED"),
          );
          const rows = await withOrg(app!, orgId, (c) =>
            c.query(`SELECT * FROM "${schema}".capacity_native ORDER BY id`),
          );
          assert.deepEqual(
            rows.rows.map((row) => row.id),
            ["prior"],
          );
          assert.equal(rows.rows[0].payload, "Readable before pressure");
        },
      );
      await t.test(
        "Native DML cannot omit a reservation or skip deferred commit validation",
        async () => {
          await assert.rejects(
            () =>
              withOrg(app!, orgId, (c) =>
                c.query(
                  `INSERT INTO "${schema}".capacity_native VALUES('unreserved','denied')`,
                ),
              ),
            (error) =>
              (error as Error).message.includes("STORAGE_RESERVATION_REQUIRED"),
          );
          await assert.rejects(
            () =>
              withOrg(app!, orgId, async (c) => {
                await capacity.begin(c, orgId, {
                  reserveBytes: 0n,
                  operation: "direct-native",
                });
                await c.query(
                  `INSERT INTO "${schema}".capacity_native VALUES('overrun',$1)`,
                  [randomBytes(32768).toString("base64")],
                );
              }),
            (error) =>
              (error as Error).message.includes("STORAGE_RESERVATION_EXCEEDED"),
          );
          assert.equal(
            (
              await withOrg(app!, orgId, (c) =>
                c.query(
                  `SELECT count(*)::int count FROM "${schema}".capacity_native`,
                ),
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await owner!.query(
                "SELECT count(*)::int count FROM rootset_control.capacity_reservations",
              )
            ).rows[0].count,
            0,
          );
        },
      );
      await t.test(
        "Cross-organisation concurrent growth shares installation admission; rollback releases claims",
        async () => {
          await configure({ organisationOverrides: [] });
          const initial = BigInt(
            (await capacity.status()).installation.usedBytes,
          );
          await configure({
            installationQuotaBytes: (initial + 2097152n).toString(),
          });
          const first = await app!.connect();
          let second: Promise<string | undefined> | undefined;
          let admissionTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await first.query("BEGIN");
            await first.query("SELECT set_config('rootset.org_id',$1,true)", [
              orgId,
            ]);
            const reservation = await capacity.begin(first, orgId, {
              reserveBytes: 2097152n,
              operation: "first-org",
            });
            await first.query(
              `INSERT INTO "${schema}".capacity_native VALUES('first-org',$1)`,
              [randomBytes(131072).toString("base64")],
            );
            const startedAt = performance.now();
            second = withOrg(app!, otherOrgId, async (c) => {
              await capacity.begin(c, otherOrgId, {
                reserveBytes: 2097152n,
                operation: "second-org",
              });
              return c.query(
                `INSERT INTO "${otherSchema}".capacity_native VALUES('second-org','denied')`,
              );
            }).then(
              () => "accepted",
              (error) => (error as { code: string }).code,
            );
            const admissionBudgetMs = 2000;
            const outcome = await Promise.race([
              second,
              new Promise<never>((_resolve, reject) => {
                admissionTimeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Admission did not reject within two seconds while the first reservation remained held",
                      ),
                    ),
                  admissionBudgetMs,
                );
              }),
            ]);
            clearTimeout(admissionTimeout);
            assert.equal(outcome, "STORAGE_ADMISSION_BUSY");
            assert.ok(performance.now() - startedAt < admissionBudgetMs);
            assert.equal(
              (
                await owner!.query(
                  `SELECT count(*)::int count FROM "${otherSchema}".capacity_native WHERE id='second-org'`,
                )
              ).rows[0].count,
              0,
            );
            await capacity.finish(first, reservation);
            await first.query("COMMIT");
            await assert.rejects(
              () =>
                withOrg(app!, otherOrgId, (c) =>
                  capacity.begin(c, otherOrgId, {
                    reserveBytes: 2097152n,
                    operation: "second-org-retry",
                  }),
                ),
              (error) =>
                assertPrivateCapacityError(error, "STORAGE_QUOTA_EXCEEDED"),
            );
          } finally {
            clearTimeout(admissionTimeout);
            try {
              await first.query("ROLLBACK");
            } finally {
              first.release();
              await second;
              await configure({ installationQuotaBytes: null });
            }
          }
          await assert.rejects(
            () =>
              withOrg(app!, orgId, async (c) => {
                await capacity.begin(c, orgId, {
                  reserveBytes: 1048576n,
                  operation: "rollback",
                });
                throw new Error("simulated transaction rollback");
              }),
            /simulated transaction rollback/,
          );
          assert.equal(
            (
              await owner!.query(
                "SELECT count(*)::int count FROM rootset_control.capacity_reservations",
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await withOrg(app!, otherOrgId, (c) =>
                c.query(
                  `SELECT count(*)::int count FROM "${otherSchema}".capacity_native`,
                ),
              )
            ).rows[0].count,
            0,
          );
        },
      );
      await t.test(
        "Minimum free space fails closed only when configured; reporter role cannot read data/change policy",
        async () => {
          await configure({ minimumFreeBytes: "1048576" });
          await assert.rejects(
            () =>
              withOrg(app!, orgId, (c) =>
                capacity.begin(c, orgId, {
                  reserveBytes: 1n,
                  operation: "missing-report",
                }),
              ),
            (error) =>
              assertPrivateCapacityError(error, "STORAGE_REPORT_STALE"),
          );
          assert.equal((await status()).admission.state, "report_stale");
          await transaction(owner!, async (c) => {
            await c.query("SET LOCAL ROLE rootset_capacity_reporter");
            const checkpoint = (
              await c.query(
                "SELECT rootset_control.capacity_report_checkpoint() checkpoint",
              )
            ).rows[0].checkpoint;
            const paths = (
              await c.query(
                "SELECT * FROM rootset_control.capacity_storage_paths()",
              )
            ).rows as Array<{ name: string; path: string }>;
            assert.ok(paths.some((item) => item.name === "data"));
            assert.ok(paths.some((item) => item.name === "wal"));
            await c.query(
              "SELECT rootset_control.report_storage_capacity($1,$2)",
              [
                JSON.stringify(
                  paths.map((item) => ({
                    name: item.name,
                    availableBytes: "1048576",
                    totalBytes: "2097152",
                  })),
                ),
                JSON.stringify(checkpoint),
              ],
            );
          });
          await assert.rejects(
            () =>
              transaction(owner!, async (c) => {
                await c.query("SET LOCAL ROLE rootset_capacity_reporter");
                await c.query("SELECT * FROM rootset_control.users");
              }),
            (error) => (error as { code: string }).code === "42501",
          );
          await assert.rejects(
            () =>
              transaction(owner!, async (c) => {
                await c.query("SET LOCAL ROLE rootset_capacity_reporter");
                await c.query(
                  "SELECT rootset_control.configure_capacity('{}')",
                );
              }),
            (error) => (error as { code: string }).code === "42501",
          );
          await assert.rejects(
            () =>
              withOrg(app!, orgId, (c) =>
                capacity.begin(c, orgId, {
                  reserveBytes: 1n,
                  operation: "disk-pressure",
                }),
              ),
            (error) =>
              assertPrivateCapacityError(error, "STORAGE_DISK_PRESSURE"),
          );
          assert.equal((await status()).admission.state, "disk_pressure");
          await owner!.query(
            "UPDATE rootset_control.capacity_settings SET reported_at=now()-interval '1 minute'",
          );
          await assert.rejects(
            () =>
              withOrg(app!, orgId, (c) =>
                capacity.begin(c, orgId, {
                  reserveBytes: 1n,
                  operation: "stale",
                }),
              ),
            (error) =>
              assertPrivateCapacityError(error, "STORAGE_REPORT_STALE"),
          );
          await configure({ minimumFreeBytes: null });
          assert.equal(
            (
              await withOrg(app!, orgId, (c) =>
                capacity.begin(c, orgId, {
                  reserveBytes: 1n,
                  operation: "unconfigured",
                }),
              )
            ).enabled,
            false,
          );
          // The API host cannot substitute its own filesystem for a PostgreSQL container.
          await assert.rejects(() => reportPostgresFilesystem(owner!));
          const rows = await withOrg(app!, orgId, (c) =>
            c.query(`SELECT id FROM "${schema}".capacity_native ORDER BY id`),
          );
          assert.deepEqual(
            rows.rows.map((row) => row.id),
            ["first-org", "prior"],
          );
        },
      );
      await t.test(
        "Retained history is charged transactionally and approved deletion releases its tuple charge",
        async () => {
          const before = BigInt(
            (await status()).organisation!.retainedControlTupleBytes,
          );
          let historyId: string;
          await configure({ minimumFreeBytes: null });
          await withOrg(owner!, orgId, async (c) => {
            const result = await c.query(
              "INSERT INTO rootset_control.resource_history(org_id,database_id,resource_id,operation,after_value,actor,context) VALUES($1,$2,$2,'capacity-test',$3,'{}','{}') RETURNING id::text",
              [
                orgId,
                dbId,
                JSON.stringify({ retained: randomBytes(1000).toString("hex") }),
              ],
            );
            historyId = result.rows[0].id;
          });
          const retained = BigInt(
            (await status()).organisation!.retainedControlTupleBytes,
          );
          assert.ok(retained > before);
          await withOrg(owner!, orgId, (c) =>
            c.query(
              "UPDATE rootset_control.resource_history SET after_value=$2 WHERE id=$1",
              [
                historyId!,
                JSON.stringify({ retained: "compressible".repeat(10000) }),
              ],
            ),
          );
          const large = BigInt(
            (await status()).organisation!.retainedControlTupleBytes,
          );
          assert.ok(large > retained);
          await withOrg(owner!, orgId, (c) =>
            c.query(
              "UPDATE rootset_control.resource_history SET after_value=$2 WHERE id=$1",
              [historyId!, JSON.stringify({ retained: "tiny" })],
            ),
          );
          assert.ok(
            BigInt((await status()).organisation!.retainedControlTupleBytes) <
              large,
          );
          await withOrg(owner!, orgId, (c) =>
            c.query(
              "DELETE FROM rootset_control.resource_history WHERE id=$1",
              [historyId!],
            ),
          );
          assert.equal(
            BigInt((await status()).organisation!.retainedControlTupleBytes),
            before,
          );
        },
      );
      await t.test(
        "Filesystem report retains reservations committed after its sampling checkpoint",
        async () => {
          const checkpoint = (
            await owner!.query(
              "SELECT rootset_control.capacity_report_checkpoint() checkpoint",
            )
          ).rows[0].checkpoint;
          const paths = (
            await owner!.query(
              "SELECT * FROM rootset_control.capacity_storage_paths()",
            )
          ).rows;
          const volumes = paths.map((item) => ({
            name: item.name,
            availableBytes: "104857600",
            totalBytes: "209715200",
          }));
          await owner!.query(
            "SELECT rootset_control.report_storage_capacity($1,$2)",
            [JSON.stringify(volumes), JSON.stringify(checkpoint)],
          );
          await configure({ minimumFreeBytes: "1048576" });
          const delayed = (
            await owner!.query(
              "SELECT rootset_control.capacity_report_checkpoint() checkpoint",
            )
          ).rows[0].checkpoint;
          await withOrg(app!, orgId, async (c) => {
            const reservation = await capacity.begin(c, orgId, {
              reserveBytes: 1048576n,
              operation: "sample-race",
            });
            await c.query(
              `INSERT INTO "${schema}".capacity_native VALUES('sample-race','committed after sample')`,
            );
            await capacity.finish(c, reservation);
          });
          await owner!.query(
            "SELECT rootset_control.report_storage_capacity($1,$2)",
            [JSON.stringify(volumes), JSON.stringify(delayed)],
          );
          const disk = (await status()).disk;
          assert.equal(disk.headroomClaimsBytes, "1048576");
          assert.equal(disk.effectiveAvailableBytes, "103809024");
        },
      );
      await t.test(
        "Concurrent index admission holds a session reservation through outside-transaction build and final validation",
        async () => {
          const client = await owner!.connect();
          let signalStarted!: () => void, releaseBuild!: () => void;
          const started = new Promise<void>((resolve) => {
            signalStarted = resolve;
          });
          const release = new Promise<void>((resolve) => {
            releaseBuild = resolve;
          });
          let otherFinished = false;
          try {
            const build = capacity.withSessionAdmission(
              client,
              orgId,
              { reserveBytes: 1048576n, operation: "create-index" },
              async (validate) => {
                await client.query(
                  `CREATE INDEX CONCURRENTLY capacity_id_lookup ON "${schema}".capacity_native(id)`,
                );
                await validate();
                signalStarted();
                await release;
                return "built";
              },
            );
            await started;
            const other = withOrg(app!, otherOrgId, async (c) => {
              const reservation = await capacity.begin(c, otherOrgId, {
                reserveBytes: 1048576n,
                operation: "other-after-index",
              });
              await capacity.finish(c, reservation);
            }).then(
              () => {
                otherFinished = true;
                return "accepted";
              },
              (error) => {
                otherFinished = true;
                return (error as { code: string }).code;
              },
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(otherFinished, true);
            assert.equal(await other, "STORAGE_ADMISSION_BUSY");
            releaseBuild();
            assert.equal(await build, "built");
            assert.equal(otherFinished, true);
            await withOrg(app!, otherOrgId, async (c) => {
              const reservation = await capacity.begin(c, otherOrgId, {
                reserveBytes: 1048576n,
                operation: "other-after-index-retry",
              });
              await capacity.finish(c, reservation);
            });
          } finally {
            releaseBuild();
            client.release();
          }
          assert.equal(
            (
              await owner!.query(
                "SELECT indisvalid FROM pg_index WHERE indexrelid=$1::regclass",
                [`${schema}.capacity_id_lookup`],
              )
            ).rows[0].indisvalid,
            true,
          );
        },
      );
      await t.test(
        "Unconfigured writers stay parallel and hold a shared fence against activating limits mid-transaction",
        async () => {
          await configure({
            minimumFreeBytes: null,
            installationQuotaBytes: null,
            defaultOrganisationQuotaBytes: null,
            organisationOverrides: [],
          });
          const first = await app!.connect();
          try {
            await first.query("BEGIN");
            await first.query("SELECT set_config('rootset.org_id',$1,true)", [
              orgId,
            ]);
            assert.equal(
              (
                await capacity.begin(first, orgId, {
                  reserveBytes: 1048576n,
                  operation: "unconfigured-writer",
                })
              ).enabled,
              false,
            );
            await first.query(
              `INSERT INTO "${schema}".capacity_native VALUES('activation-fence','first parallel writer')`,
            );
            await withOrg(app!, otherOrgId, async (c) => {
              assert.equal(
                (
                  await capacity.begin(c, otherOrgId, {
                    reserveBytes: 1048576n,
                    operation: "parallel-unconfigured",
                  })
                ).enabled,
                false,
              );
              await c.query(
                `INSERT INTO "${otherSchema}".capacity_native VALUES('parallel-unconfigured','readable')`,
              );
            });
            await assert.rejects(
              () => configure({ installationQuotaBytes: "1" }),
              (error) =>
                (error as { code: string }).code === "STORAGE_ADMISSION_BUSY",
            );
            assert.equal(
              (await capacity.configuration()).installationQuotaBytes,
              null,
            );
            await first.query("COMMIT");
          } finally {
            await first.query("ROLLBACK");
            first.release();
          }
          await configure({ installationQuotaBytes: "1" });
          await assert.rejects(
            () =>
              withOrg(app!, orgId, (c) =>
                capacity.begin(c, orgId, {
                  reserveBytes: 1n,
                  operation: "after-activation",
                }),
              ),
            (error) =>
              (error as { code: string }).code === "STORAGE_QUOTA_EXCEEDED",
          );
          assert.equal(
            (
              await withOrg(app!, orgId, (c) =>
                c.query(
                  `SELECT payload FROM "${schema}".capacity_native WHERE id='activation-fence'`,
                ),
              )
            ).rows[0].payload,
            "first parallel writer",
          );
          await configure({ installationQuotaBytes: null });
        },
      );
      await t.test(
        "Real CIC waiting for an older snapshot never deadlocks a configured writer; default CIC permits parallel online edits",
        async () => {
          for (const enabled of [true, false]) {
            await configure({
              installationQuotaBytes: enabled
                ? (
                    BigInt((await capacity.status()).installation.usedBytes) +
                    16777216n
                  ).toString()
                : null,
              minimumFreeBytes: null,
            });
            const reader = await app!.connect(),
              builder = await owner!.connect();
            let build: Promise<string> | undefined;
            const indexName = enabled
              ? "capacity_snapshot_configured"
              : "capacity_snapshot_default";
            try {
              await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
              await reader.query(
                "SELECT set_config('rootset.org_id',$1,true)",
                [orgId],
              );
              await reader.query(`SELECT * FROM "${schema}".capacity_native`);
              const backend = (
                await builder.query("SELECT pg_backend_pid() pid")
              ).rows[0].pid;
              build = capacity.withSessionAdmission(
                builder,
                orgId,
                { reserveBytes: 2097152n, operation: "snapshot-cic" },
                async (validate) => {
                  await builder.query(
                    `CREATE INDEX CONCURRENTLY ${indexName} ON "${schema}".capacity_native(id)`,
                  );
                  await validate();
                  return "built";
                },
              );
              const observed = build.then(
                () => "complete",
                (error) => {
                  throw error;
                },
              );
              const deadline = Date.now() + 10000;
              let waiting = false;
              while (Date.now() < deadline) {
                const phase = (
                  await owner!.query(
                    "SELECT phase FROM pg_stat_progress_create_index WHERE pid=$1",
                    [backend],
                  )
                ).rows[0]?.phase;
                if (phase === "waiting for old snapshots") {
                  waiting = true;
                  break;
                }
                await Promise.race([
                  observed,
                  new Promise((resolve) => setTimeout(resolve, 20)),
                ]);
              }
              assert.equal(
                waiting,
                true,
                "Fixture must reach actual PostgreSQL WaitForOlderSnapshots",
              );
              const writer = () =>
                withOrg(app!, otherOrgId, async (c) => {
                  const reservation = await capacity.begin(c, otherOrgId, {
                    reserveBytes: 1048576n,
                    operation: "writer-during-cic",
                  });
                  await c.query(
                    `INSERT INTO "${otherSchema}".capacity_native VALUES($1,'committed online edit')`,
                    [enabled ? "configured-retry" : "online-default"],
                  );
                  await capacity.finish(c, reservation);
                });
              if (enabled)
                await assert.rejects(
                  writer,
                  (error) =>
                    (error as { code: string }).code ===
                    "STORAGE_ADMISSION_BUSY",
                );
              else await writer();
              // The rejected writer has no waiting statement snapshot; releasing the
              // one deliberate old reader is enough for the real index to publish.
              await reader.query("COMMIT");
              assert.equal(await build, "built");
              build = undefined;
              if (enabled) await writer();
            } finally {
              await reader.query("ROLLBACK");
              if (build) await build;
              reader.release();
              builder.release();
            }
            assert.equal(
              (
                await owner!.query(
                  "SELECT indisvalid FROM pg_index WHERE indexrelid=$1::regclass",
                  [`${schema}.${indexName}`],
                )
              ).rows[0].indisvalid,
              true,
            );
          }
        },
      );
    } finally {
      await app?.end();
      await identity?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    }
  },
);
