import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "@rootset/database";

export function recoveryCodeHash(code: string): string {
  return createHash("sha256")
    .update(code.trim().replaceAll("-", "").toLowerCase())
    .digest("hex");
}
export async function replaceRecoveryCodes(
  client: Pool | PoolClient,
  userId: string,
): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"),
  );
  await client.query(
    `INSERT INTO rootset_control.auth_recovery_codes(user_id,code_hashes) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET code_hashes=EXCLUDED.code_hashes,created_at=now()`,
    [userId, codes.map(recoveryCodeHash)],
  );
  return codes;
}

export async function ensureRecoveryCodes(
  client: Pool | PoolClient,
  userId: string,
): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"),
  );
  const created = await client.query(
    `INSERT INTO rootset_control.auth_recovery_codes(user_id,code_hashes) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING RETURNING user_id`,
    [userId, codes.map(recoveryCodeHash)],
  );
  return created.rowCount ? codes : [];
}
