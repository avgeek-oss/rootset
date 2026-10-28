import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { newId } from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { migrate } from "./index.js";

test(
  "scope upgrade revokes granular grants and pending approvals without widening them",
  { skip: !process.env.ROOTSET_TEST_DATABASE_URL },
  async () => {
    const previous = await mkdtemp(join(tmpdir(), "rootset-role-scopes-"));
    await cp(
      fileURLToPath(new URL("../migrations/", import.meta.url)),
      previous,
      { recursive: true },
    );
    await rm(join(previous, "0018_broad_authorization_scopes.sql"));
    const db = await isolatedDatabase({ migrationDirectory: previous });
    try {
      const userId = newId(),
        orgId = newId(),
        legacyId = newId(),
        currentId = newId(),
        requestId = newId();
      const actor = {
        kind: "oauth",
        id: userId,
        userId,
        orgId,
        role: "viewer",
        scopes: ["viewer"],
      };
      for (const [id, scopes] of [
        [legacyId, ["rows:read"]],
        [currentId, ["viewer"]],
      ] as const)
        await db.owner.query(
          "INSERT INTO rootset_control.oauth_grants(id,client_id,user_id,org_id,resource,scopes,actor) VALUES($1,'client',$2,$3,'http://localhost/mcp',$4,$5)",
          [id, userId, orgId, scopes, actor],
        );
      await db.owner.query(
        "INSERT INTO rootset_control.oauth_requests(id,client_id,redirect_uri,resource,scopes,org_id,user_id,challenge,expires_at) VALUES($1,'client','http://localhost/callback','http://localhost/mcp',ARRAY['rows:read'],$2,$3,'challenge',now()+interval '5 minutes')",
        [requestId, orgId, userId],
      );
      const before = (
        await db.owner.query(
          "SELECT * FROM rootset_control.oauth_grants WHERE id=$1",
          [currentId],
        )
      ).rows;
      assert.deepEqual(await migrate(db.owner), [
        "0018_broad_authorization_scopes.sql",
      ]);
      assert.deepEqual(await migrate(db.owner), []);
      assert(
        (
          await db.owner.query(
            "SELECT revoked_at FROM rootset_control.oauth_grants WHERE id=$1",
            [legacyId],
          )
        ).rows[0].revoked_at,
      );
      assert.deepEqual(
        (
          await db.owner.query(
            "SELECT * FROM rootset_control.oauth_grants WHERE id=$1",
            [currentId],
          )
        ).rows,
        before,
      );
      assert.equal(
        (
          await db.owner.query(
            "SELECT status FROM rootset_control.oauth_requests WHERE id=$1",
            [requestId],
          )
        ).rows[0].status,
        "denied",
      );
    } finally {
      await db.close();
      await rm(previous, { recursive: true, force: true });
    }
  },
);
