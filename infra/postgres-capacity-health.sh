#!/bin/sh
set -eu

pg_isready --username rootset_owner --dbname rootset --quiet

psql_owner() {
  psql --no-psqlrc --quiet --tuples-only --no-align --username rootset_owner \
    --dbname rootset --set ON_ERROR_STOP=1 "$@"
}

ready=$(psql_owner --command "SELECT to_regprocedure('rootset_control.capacity_storage_paths()') IS NOT NULL AND to_regprocedure('rootset_control.capacity_report_checkpoint()') IS NOT NULL AND to_regprocedure('rootset_control.report_storage_capacity(jsonb,jsonb)') IS NOT NULL")
# The migration job depends on PostgreSQL readiness on its first boot.
if [ "$ready" != "t" ]; then
  installed=$(psql_owner --command "SELECT to_regclass('rootset_control.capacity_settings') IS NOT NULL")
  if [ "$installed" = "t" ]; then exit 1; fi
  exit 0
fi

checkpoint=$(psql_owner --command "SET ROLE rootset_capacity_reporter; SELECT rootset_control.capacity_report_checkpoint()")
paths=$(psql_owner --command "SET ROLE rootset_capacity_reporter; SELECT replace(encode(convert_to(name,'UTF8'),'base64'),E'\\n','') || '|' || replace(encode(convert_to(path,'UTF8'),'base64'),E'\\n','') FROM rootset_control.capacity_storage_paths() ORDER BY name")
if [ -z "$paths" ]; then exit 1; fi

report='['
separator=''
while IFS='|' read -r name64 path64; do
  path=$(printf '%s' "$path64" | base64 -d)
  bytes=$(df -Pk -- "$path" | awk 'NR == 2 { printf "%.0f %.0f", $4 * 1024, $2 * 1024 }')
  available=${bytes%% *}
  total=${bytes#* }
  case "$available:$total" in *[!0-9:]* | : | *:) exit 1 ;; esac
  name=$(psql_owner --set "volume_name=$name64" <<'SQL'
SET ROLE rootset_capacity_reporter;
SELECT to_json(convert_from(decode(:'volume_name','base64'),'UTF8'));
SQL
  )
  report="$report$separator{\"name\":$name,\"availableBytes\":\"$available\",\"totalBytes\":\"$total\"}"
  separator=','
done <<EOF
$paths
EOF
report="$report]"
psql_owner --set "capacity_report=$report" --set "capacity_checkpoint=$checkpoint" <<'SQL'
SET ROLE rootset_capacity_reporter;
SELECT rootset_control.report_storage_capacity(:'capacity_report'::jsonb,:'capacity_checkpoint'::jsonb);
SQL
