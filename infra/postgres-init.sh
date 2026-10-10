#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set password="$POSTGRES_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE rootset LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'password') \gexec
ALTER ROLE postgres PASSWORD NULL;
ALTER DATABASE rootset OWNER TO rootset;
GRANT CREATE ON SCHEMA public TO rootset;
SQL
