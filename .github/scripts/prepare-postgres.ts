import { Pool } from "pg";

const owner = new Pool({
  connectionString: process.env.ROOTSET_TEST_DATABASE_URL,
  max: 1,
});
const roles = [
  ["rootset_app", "ROOTSET_TEST_APP_DATABASE_URL"],
  ["rootset_ddl", "ROOTSET_TEST_DDL_DATABASE_URL"],
  ["rootset_identity", "ROOTSET_TEST_IDENTITY_DATABASE_URL"],
] as const;
try {
  for (const [role, variable] of roles) {
    const value = process.env[variable];
    if (!value) throw new Error(`Missing test prerequisite ${variable}`);
    const password = decodeURIComponent(new URL(value).password);
    const quoted = (
      await owner.query<{ value: string }>(
        "SELECT quote_literal($1) AS value",
        [password],
      )
    ).rows[0]!.value;
    await owner.query(
      `CREATE ROLE ${role} LOGIN PASSWORD ${quoted} NOSUPERUSER NOBYPASSRLS`,
    );
  }
  await owner.query("GRANT CREATE ON DATABASE rootset TO rootset_ddl");
  await owner.query(
    "CREATE ROLE rootset_capacity_reporter NOLOGIN NOSUPERUSER NOBYPASSRLS",
  );
} finally {
  await owner.end();
}
