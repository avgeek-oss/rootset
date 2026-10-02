import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
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
