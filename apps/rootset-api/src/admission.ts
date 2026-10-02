import type { Pool } from "pg";
import { newId, RootsetError, limits } from "@rootset/contracts";

export class Admission {
  constructor(private pool: Pool) {}
  async enter(
    principal: string,
    readOnly: boolean,
    preAuth = false,
    requestLimit = preAuth ? 30 : limits.principalRequestsPerMinute,
    concurrencyLimit: number = readOnly
      ? limits.concurrentReads
      : limits.concurrentMutations,
    leaseSeconds = 120,
  ): Promise<() => Promise<void>> {
    if (
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 900
    )
      throw new RangeError(
        "Admission lease must be between 1 and 900 seconds.",
      );
    const db = await this.pool.connect(),
      id = newId();
    let committed = false;
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,72412))",
        [principal],
      );
      await db.query(
        "DELETE FROM rootset_control.api_admissions WHERE principal=$1 AND expires_at<=now()",
        [principal],
      );
      const window = Math.floor(Date.now() / 60_000);
      await db.query(
        "DELETE FROM rootset_control.api_rate_windows WHERE principal=$1 AND window_start<$2",
        [principal, window - 5],
      );
      const count = (
        await db.query(
          "INSERT INTO rootset_control.api_rate_windows(principal,window_start,requests) VALUES($1,$2,1) ON CONFLICT(principal,window_start) DO UPDATE SET requests=rootset_control.api_rate_windows.requests+1 RETURNING requests",
          [principal, window],
        )
      ).rows[0].requests as number;
      if (count > requestLimit) {
        await db.query("COMMIT");
        committed = true;
        throw new RootsetError(
          "RATE_LIMITED",
          "Request rate limit reached.",
          429,
          { retryAfter: 60 },
        );
      }
      if (!preAuth) {
        const live = Number(
          (
            await db.query(
              "SELECT count(*) FROM rootset_control.api_admissions WHERE principal=$1 AND read_only=$2",
              [principal, readOnly],
            )
          ).rows[0].count,
        );
        if (live >= concurrencyLimit) {
          await db.query("COMMIT");
          committed = true;
          throw new RootsetError(
            "RATE_LIMITED",
            "Concurrent operation limit reached.",
            429,
            { retryAfter: 1 },
          );
        }
        await db.query(
          "INSERT INTO rootset_control.api_admissions(id,principal,read_only,expires_at) VALUES($1,$2,$3,now()+make_interval(secs=>$4))",
          [id, principal, readOnly, leaseSeconds],
        );
      }
      await db.query("COMMIT");
      committed = true;
      return async () => {
        if (!preAuth)
          await this.pool.query(
            "DELETE FROM rootset_control.api_admissions WHERE id=$1",
            [id],
          );
      };
    } catch (error) {
      if (!committed) await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
}
