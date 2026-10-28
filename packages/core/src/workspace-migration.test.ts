import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, cp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { migrate } from "@rootset/database";
import { newId } from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";

test("workspace upgrade buckets existing databases into Default and revokes every legacy team key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rootset-workspace-upgrade-"));
  const migrations = resolve(import.meta.dirname, "../../database/migrations");
  let fixture: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
  try {
    for (const file of await readdir(migrations))
      if (file.endsWith(".sql") && file < "0015_")
        await cp(join(migrations, file), join(directory, file));
    fixture = await isolatedDatabase({ migrationDirectory: directory });
    const orgId = newId(),
      databaseId = newId(),
      keyId = newId(),
      userId = newId();
    await fixture.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Existing installation')",
      [orgId],
    );
    await fixture.owner.query(
      "INSERT INTO rootset_control.databases(id,org_id,name,schema_name) VALUES($1,$2,'Existing database',$3)",
      [databaseId, orgId, `rsd_${databaseId.toLowerCase()}`],
    );
    await fixture.owner.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Existing member','existing@example.test',true)",
      [userId],
    );
    await fixture.owner.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')",
      [newId(), orgId, userId],
    );
    await fixture.owner.query(
      "INSERT INTO rootset_control.api_keys(id,org_id,scope,access,include_admin,name,secret_hash,prefix) VALUES($1,$2,'team','edit',true,'Old team key','hash','rst_old')",
      [keyId, orgId],
    );
    assert.deepEqual(await migrate(fixture.owner), [
      "0015_workspaces.sql",
      "0016_remove_audit_logs.sql",
    ]);
    const workspace = (
      await fixture.owner.query(
        "SELECT w.*,d.workspace_id FROM rootset_control.workspaces w JOIN rootset_control.databases d ON d.workspace_id=w.id WHERE d.id=$1",
        [databaseId],
      )
    ).rows[0];
    assert.equal(workspace.id, orgId);
    assert.equal(workspace.name, "Default");
    assert.equal(workspace.is_default, true);
    assert.equal(
      (
        await fixture.owner.query(
          "SELECT count(*)::int count FROM rootset_control.memberships WHERE user_id=$1",
          [userId],
        )
      ).rows[0].count,
      1,
    );
    assert.ok(
      (
        await fixture.owner.query(
          "SELECT revoked_at FROM rootset_control.api_keys WHERE id=$1",
          [keyId],
        )
      ).rows[0].revoked_at,
    );
    assert.deepEqual(await migrate(fixture.owner), []);
  } finally {
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
