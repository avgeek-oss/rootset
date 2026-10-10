import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { closePools, testPools } from "./environment.js";
import { loadScaleFixture } from "./scale-fixture.js";

/** Checks an existing verified Admin in the same installation. Authentication is tested separately. */
export async function verifyScaleBrowserAccess(
  scaleManifest: string,
  browserManifest: string,
  requestedEmail?: string,
): Promise<void> {
  const scale = await loadScaleFixture(scaleManifest);
  const browser = JSON.parse(await readFile(browserManifest, "utf8")) as {
    orgId: string;
  };
  assert.equal(
    browser.orgId,
    scale.orgId,
    "Browser and scale fixtures must use the sole organisation in this installation.",
  );
  const pools = testPools();
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(pools.owner.options.connectionString!).hostname,
    ),
  );
  try {
    const result = await pools.owner.query<{ user_id: string }>(
      `SELECT m.user_id FROM rootset_control.memberships m
       JOIN rootset_control.users u ON u.id=m.user_id
       JOIN rootset_control.organisations o ON o.id=m.org_id
       WHERE m.org_id=$1 AND m.role='admin' AND u.email_verified
         AND ($2::text IS NULL OR lower(u.email)=lower($2))`,
      [scale.orgId, requestedEmail ?? null],
    );
    assert.equal(
      result.rowCount,
      1,
      "Provide the email of exactly one verified Admin in the current browser installation.",
    );
    const data = await pools.owner.query(
      "SELECT id FROM rootset_control.databases WHERE id=$1 AND org_id=$2 AND name='Acceptance scale fixture'",
      [scale.databaseId, scale.orgId],
    );
    assert.equal(
      data.rowCount,
      1,
      "The manifest must identify the dedicated scale dataset.",
    );
    const record = {
      kind: "scale-browser-fixture-access",
      checkedAt: new Date().toISOString(),
      userId: result.rows[0]!.user_id,
      role: "admin",
      orgId: scale.orgId,
      databaseId: scale.databaseId,
      tableId: scale.tableId,
      wideTableId: scale.wideTableId,
      acceptance: false,
      scope:
        "Existing fixture authority only; authentication and product invitations require separate results.",
    };
    await writeFile(
      join(
        dirname(resolve(scaleManifest)),
        `browser-access-${record.userId}-${Date.now()}.json`,
      ),
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    process.stdout.write(JSON.stringify(record) + "\n");
  } finally {
    await closePools(pools);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  assert.ok(
    process.argv[2] && process.argv[3],
    "Pass current scale and browser fixture manifests, with an optional Admin email.",
  );
  await verifyScaleBrowserAccess(
    process.argv[2]!,
    process.argv[3]!,
    process.argv[4],
  );
}
