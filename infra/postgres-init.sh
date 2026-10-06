#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set app_password="$ROOTSET_APP_DB_PASSWORD" \
  --set ddl_password="$ROOTSET_DDL_DB_PASSWORD" \
  --set identity_password="$ROOTSET_IDENTITY_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE rootset_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_password') \gexec
SELECT format('CREATE ROLE rootset_ddl LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'ddl_password') \gexec
SELECT format('CREATE ROLE rootset_identity LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'identity_password') \gexec
GRANT CREATE ON DATABASE rootset TO rootset_ddl;
SQL
