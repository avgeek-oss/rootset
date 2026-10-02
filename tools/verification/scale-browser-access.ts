import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { newId } from "@rootset/contracts";
import { closePools, testPools } from "./environment.js";
import { loadScaleFixture } from "./scale-fixture.js";

// This fixture-only membership grant lets an already verified browser account review
// the isolated performance organisation. It does not establish product invitation coverage.
export async function grantScaleBrowserAccess(
  scaleManifest: string,
  browserManifest: string,
  requestedEmail?: string,
): Promise<void> {
  const scale = await loadScaleFixture(scaleManifest);
  const browser = JSON.parse(await readFile(browserManifest, "utf8")) as {
    orgId: string;
  };
  const pools = testPools();
  const database = new URL(pools.owner.options.connectionString!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(database.hostname));
  const connection = await pools.owner.connect();
  try {
    await connection.query("BEGIN");
    const source = await connection.query<{ user_id: string }>(
      `SELECT m.user_id FROM rootset_control.memberships m
       JOIN rootset_control.users u ON u.id=m.user_id
       JOIN rootset_control.organisations o ON o.id=m.org_id
       WHERE m.org_id=$1 AND m.role=ANY($2::text[]) AND m.state='active'
         AND u.email_verified AND NOT u.disabled AND o.state='active'
         AND ($3::text IS NULL OR lower(u.email)=lower($3))`,
      [
        browser.orgId,
        requestedEmail ? ["owner", "admin"] : ["owner"],
        requestedEmail ?? null,
      ],
    );
    assert.equal(
      source.rowCount,
      1,
      "The browser fixture must have exactly one verified matching owner/admin.",
    );
    const fixtureOwner = await connection.query(
      `SELECT m.id FROM rootset_control.memberships m
       JOIN rootset_control.organisations o ON o.id=m.org_id
       JOIN rootset_control.databases d ON d.org_id=m.org_id
       WHERE m.org_id=$1 AND m.user_id=$2 AND m.role='owner'
         AND o.name='Five-million-row verification fixture' AND d.id=$3
         AND d.name='Acceptance scale fixture'`,
      [scale.orgId, scale.userId, scale.databaseId],
    );
    assert.equal(
      fixtureOwner.rowCount,
      1,
      "Only the dedicated scale fixture organisation may be changed.",
    );
    const userId = source.rows[0]!.user_id;
    const role = requestedEmail ? "admin" : "owner";
    await connection.query(
      `INSERT INTO rootset_control.memberships(id,org_id,user_id,role,state)
       VALUES($1,$2,$3,$4,'active') ON CONFLICT(org_id,user_id)
       DO UPDATE SET role=EXCLUDED.role,state='active',version=memberships.version+1`,
      [newId(), scale.orgId, userId, role],
    );
    await connection.query("COMMIT");
    const record = {
      kind: "scale-browser-fixture-access",
      grantedAt: new Date().toISOString(),
      sourceBrowserOrgId: browser.orgId,
      userId,
      role,
      orgId: scale.orgId,
      databaseId: scale.databaseId,
      tableId: scale.tableId,
      wideTableId: scale.wideTableId,
      scope:
        "Explicit local QA fixture setup; invitation and authentication product paths are verified separately.",
    };
    await writeFile(
      join(
        dirname(resolve(scaleManifest)),
        requestedEmail
          ? `browser-access-${userId}.json`
          : "browser-access.json",
      ),
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(record) + "\n");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
    await closePools(pools);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  assert.ok(
    process.argv[2] && process.argv[3],
    "Pass scale and browser fixture manifest paths.",
  );
  await grantScaleBrowserAccess(
    process.argv[2]!,
    process.argv[3]!,
    process.argv[4],
  );
}
