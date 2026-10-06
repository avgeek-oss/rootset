import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool, type PoolClient } from "pg";
import { newId, RootsetError } from "@rootset/contracts";
import { Admission } from "./admission.js";

const url =
  process.env.ROOTSET_TEST_APP_DATABASE_URL ??
  process.env.ROOTSET_TEST_DATABASE_URL;
test(
  "PostgreSQL admission enforces shared concurrency, persistent rate counts and expired lease recovery",
  { skip: !url },
  async () => {
    const pool = new Pool({ connectionString: url }),
      a = new Admission(pool),
      principal = `admission-test:${newId()}`,
      ratePrincipal = `rate-test:${newId()}`;
    const releases: (() => Promise<void>)[] = [];
    try {
      for (let i = 0; i < 10; i++)
        releases.push(await a.enter(principal, true));
      await assert.rejects(
        a.enter(principal, true),
        (error) =>
          error instanceof RootsetError &&
          error.status === 429 &&
          error.code === "RATE_LIMITED",
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=$1",
              [principal],
            )
          ).rows[0].count,
        ),
        10,
      );
      await pool.query(
        "UPDATE rootset_control.api_admissions SET expires_at=now()-interval '1 second' WHERE principal=$1",
        [principal],
      );
      releases.push(await a.enter(principal, true));
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=$1",
              [principal],
            )
          ).rows[0].count,
        ),
        1,
      );
      for (let i = 0; i < 3; i++)
        await (
          await a.enter(ratePrincipal, true, true, 3)
        )();
      await assert.rejects(
        a.enter(ratePrincipal, true, true, 3),
        (error) => error instanceof RootsetError && error.status === 429,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT requests FROM rootset_control.api_rate_windows WHERE principal=$1",
            [ratePrincipal],
          )
        ).rows[0].requests,
        4,
      );
      const longPrincipal = `upload-test:${newId()}`;
      const releaseUpload = await a.enter(
        longPrincipal,
        false,
        false,
        120,
        1,
        660,
      );
      try {
        await pool.query(
          "UPDATE rootset_control.api_admissions SET expires_at=expires_at-interval '3 minutes' WHERE principal=$1",
          [longPrincipal],
        );
        await assert.rejects(
          a.enter(longPrincipal, false, false, 120, 1, 660),
          (error) => error instanceof RootsetError && error.status === 429,
        );
      } finally {
        await releaseUpload();
        await pool.query(
          "DELETE FROM rootset_control.api_rate_windows WHERE principal=$1",
          [longPrincipal],
        );
      }
    } finally {
      await Promise.all(releases.map((release) => release()));
      await pool.query(
        "DELETE FROM rootset_control.api_rate_windows WHERE principal=ANY($1::text[])",
        [[principal, ratePrincipal]],
      );
      await pool.end();
    }
  },
);

test(
  "API-08 bounded admission pool handles multi-principal/org contention, acquisition exhaustion and native lock deadlines without leaked reservations",
  { skip: !url },
  async () => {
    const pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 5_000,
      options: "-c statement_timeout=100 -c timezone=UTC",
    });
    const blockerPool = new Pool({ connectionString: url, max: 1 });
    const admission = new Admission(pool);
    const suffix = newId(),
      principals = [
        `user:${suffix}:a`,
        `user:${suffix}:b`,
        `organisation:${suffix}:a`,
        `organisation:${suffix}:b`,
      ];
    const leases: (() => Promise<void>)[] = [];
    try {
      const held: PoolClient[] = [];
      try {
        held.push(await pool.connect());
        held.push(await pool.connect());
        pool.options.connectionTimeoutMillis = 150;
        await Promise.all(
          principals.map((principal) =>
            assert.rejects(
              admission.enter(principal, true),
              (error) =>
                error instanceof RootsetError &&
                error.status === 503 &&
                error.code === "DEPENDENCY_UNAVAILABLE" &&
                (error.details as { retryAfter: number }).retryAfter === 1,
            ),
          ),
        );
      } finally {
        held.forEach((connection) => connection.release());
      }
      for (const principal of principals) {
        leases.push(await admission.enter(principal, true, false, 120, 1));
        leases.push(await admission.enter(principal, false, false, 120, 1));
      }
      await Promise.all(
        principals.map((principal) =>
          assert.rejects(
            admission.enter(principal, true, false, 120, 1),
            (error) => error instanceof RootsetError && error.status === 429,
          ),
        ),
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=ANY($1::text[])",
              [principals],
            )
          ).rows[0].count,
        ),
        8,
      );
      await Promise.all(leases.splice(0).map((release) => release()));
      const blocker = await blockerPool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,72412))",
          [principals[0]],
        );
        await assert.rejects(
          admission.enter(principals[0]!, true),
          (error) =>
            error instanceof RootsetError &&
            error.status === 503 &&
            error.code === "DEPENDENCY_UNAVAILABLE" &&
            !/statement|SELECT|57014/.test(error.message),
        );
        const unrelated = await admission.enter(principals[1]!, true);
        await unrelated();
        assert.equal(
          Number(
            (
              await pool.query(
                "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=ANY($1::text[])",
                [principals],
              )
            ).rows[0].count,
          ),
          0,
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      const recovered = await admission.enter(principals[0]!, true);
      await recovered();
      assert.equal(pool.options.max, 2);
    } finally {
      await Promise.all(leases.map((release) => release()));
      await pool.query(
        "DELETE FROM rootset_control.api_admissions WHERE principal=ANY($1::text[])",
        [principals],
      );
      await pool.query(
        "DELETE FROM rootset_control.api_rate_windows WHERE principal=ANY($1::text[])",
        [principals],
      );
      await Promise.all([pool.end(), blockerPool.end()]);
    }
  },
);
