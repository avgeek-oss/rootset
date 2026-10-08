import { createPool, migrate } from "@rootset/database";
const connectionString = process.env.ROOTSET_DATABASE_URL;
if (!connectionString || !/^postgres(ql)?:\/\//.test(connectionString))
  throw new Error("ROOTSET_DATABASE_URL is required for migrations");
const pool = createPool(connectionString, 1);
try {
  for (const name of await migrate(pool)) console.log(`Applied ${name}`);
} finally {
  await pool.end();
}
