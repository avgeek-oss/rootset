import { Pool } from "pg";
const url = new URL(process.env.ROOTSET_TEST_DATABASE_URL!);
url.username = "postgres";
const admin = new Pool({ connectionString: url.toString(), max: 1 });
try {
  const password = (
    await admin.query<{ value: string }>("SELECT quote_literal($1) AS value", [
      decodeURIComponent(url.password),
    ])
  ).rows[0]!.value;
  await admin.query(
    `CREATE ROLE rootset LOGIN PASSWORD ${password} NOSUPERUSER NOBYPASSRLS CREATEDB`,
  );
  await admin.query("ALTER DATABASE rootset OWNER TO rootset");
  await admin.query("GRANT CREATE ON SCHEMA public TO rootset");
} finally {
  await admin.end();
}
