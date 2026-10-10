import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, transaction, withOrg } from "./index.js";

const url = process.env.ROOTSET_TEST_DATABASE_URL;
test(
  "transaction-local organisation context is cleared after commit and rollback",
  { skip: !url },
  async () => {
    const pool = createPool(url!, 1);
    try {
      await withOrg(pool, "01K6RS00000000000000000000", async (c) => {
        const r = await c.query<{ org: string }>(
          "SELECT current_setting('rootset.org_id',true) org",
        );
        assert.equal(r.rows[0]?.org, "01K6RS00000000000000000000");
      });
      assert.equal(
        (
          await pool.query<{ org: string }>(
            "SELECT current_setting('rootset.org_id',true) org",
          )
        ).rows[0]?.org ?? "",
        "",
      );
      await assert.rejects(
        withOrg(pool, "01K6RS00000000000000000000", async () => {
          throw new Error("forced rollback");
        }),
      );
      assert.equal(
        (
          await pool.query<{ org: string }>(
            "SELECT current_setting('rootset.org_id',true) org",
          )
        ).rows[0]?.org ?? "",
        "",
      );
      await transaction(pool, async (c) => {
        assert.equal((await c.query("SELECT 1 n")).rows[0]?.n, 1);
      });
    } finally {
      await pool.end();
    }
  },
);
