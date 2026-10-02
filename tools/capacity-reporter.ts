import { Pool } from "pg";
import { reportPostgresFilesystem } from "../packages/capacity/src/reporter";

const connectionString = process.env.ROOTSET_CAPACITY_DATABASE_URL;
if (!connectionString || !/^postgres(ql)?:\/\//.test(connectionString))
  throw new Error("ROOTSET_CAPACITY_DATABASE_URL is required");
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
});
try {
  const result = await reportPostgresFilesystem(pool);
  console.log(JSON.stringify(result));
} catch {
  console.error(
    "PostgreSQL capacity reporting failed. Check reporter authority and run on the matching database host.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
