import { loadConfig } from "@rootset/core/config";
import { createPool } from "@rootset/database";
import { RootsetError, IdSchema } from "@rootset/contracts";
import { IdentityService } from "../packages/identity/src/index";

const [command, ...args] = process.argv.slice(2);
const reasonIndex = args.indexOf("--reason");
const reason = reasonIndex >= 0 ? args[reasonIndex + 1] : undefined;
const ids = reasonIndex >= 0 ? args.slice(0, reasonIndex) : [];
if (
  !["recover", "restore-admin"].includes(command ?? "") ||
  !reason?.trim() ||
  ids.length !== (command === "restore-admin" ? 2 : 1) ||
  args.length !== reasonIndex + 2
) {
  console.error('Usage: pnpm auth:operator recover USER_ID --reason "reason"');
  console.error(
    '       pnpm auth:operator restore-admin ORG_ID USER_ID --reason "reason"',
  );
  process.exitCode = 2;
} else {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const config = loadConfig();
    pool = createPool(config.databaseURL, 3);
    const identity = new IdentityService({
      ...config,
      pool,
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        user: config.smtp.auth?.user,
        password: config.smtp.auth?.pass,
        from: config.smtp.from,
      },
    });
    const parsed = ids.map((id) => IdSchema.parse(id));
    if (command === "recover")
      await identity.recoverUser(parsed[0]!, { reason });
    else await identity.restoreAdmin(parsed[0]!, parsed[1]!, { reason });
    console.log(
      `Rootset ${command} completed. Security notification was recorded.`,
    );
  } catch (error) {
    console.error(
      error instanceof RootsetError
        ? `${error.code}: ${error.message}`
        : "Operator action failed. Check installation configuration and the recovery notification.",
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
