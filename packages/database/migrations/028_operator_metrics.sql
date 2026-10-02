-- Aggregate-only operator observations. The runtime login cannot become this
-- owner, read credential columns through it, or alter the fixed function.
GRANT pg_read_all_stats TO rootset_metrics_definer;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_waldir() TO rootset_metrics_definer;
GRANT SELECT(id,state) ON rootset_control.databases TO rootset_metrics_definer;
GRANT SELECT(id,database_id,state,row_count) ON rootset_control.tables TO rootset_metrics_definer;
GRANT SELECT(state,created_at,lease_until,attempt) ON rootset_control.jobs TO rootset_metrics_definer;
GRANT SELECT(database_id,state,verified_at,notification_state) ON rootset_control.backups TO rootset_metrics_definer;
GRANT SELECT(state,attempts,created_at) ON rootset_control.email_outbox TO rootset_metrics_definer;
GRANT SELECT(state) ON rootset_control.schema_operations TO rootset_metrics_definer;
GRANT SELECT(state) ON rootset_control.indexes TO rootset_metrics_definer;
GRANT SELECT(events,tuple_bytes) ON rootset_control.history_metrics TO rootset_metrics_definer;
GRANT SELECT(state,ciphertext_length,purpose,expires_at) ON rootset_control.artifacts TO rootset_metrics_definer;
GRANT SELECT(state,heartbeat_at) ON rootset_control.worker_heartbeats TO rootset_metrics_definer;

CREATE FUNCTION rootset_control.operator_metrics() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=off SET timezone='UTC' AS $$
 WITH database_stats AS (
  SELECT * FROM pg_stat_database WHERE datname=current_database()
 ), connection_stats AS (
  SELECT count(*)::integer total,
   count(*) FILTER(WHERE state='active')::integer active,
   count(*) FILTER(WHERE state='idle')::integer idle,
   count(*) FILTER(WHERE state LIKE 'idle in transaction%')::integer idle_in_transaction,
   greatest(0,extract(epoch FROM (statement_timestamp()-min(xact_start)))) oldest_transaction_seconds
  FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend'
 ), job_stats AS (
  SELECT count(*) FILTER(WHERE state='queued')::integer queued,
   count(*) FILTER(WHERE state='running')::integer running,
   count(*) FILTER(WHERE state='failed')::integer failed,
   count(*) FILTER(WHERE state='running' AND lease_until<statement_timestamp())::integer expired_leases,
   greatest(0,extract(epoch FROM (statement_timestamp()-min(created_at) FILTER(WHERE state='queued')))) oldest_queued_seconds,
   count(*) FILTER(WHERE attempt>1)::integer retried
  FROM rootset_control.jobs
 ), backup_stats AS (
  SELECT count(*) FILTER(WHERE state='succeeded' AND verified_at IS NOT NULL)::integer verified,
   count(*) FILTER(WHERE state='failed')::integer failed,
   count(*) FILTER(WHERE notification_state='pending')::integer pending_notifications,
   count(*) FILTER(WHERE notification_state='failed')::integer failed_notifications,
   max(verified_at) FILTER(WHERE state='succeeded') last_verified_at
  FROM rootset_control.backups
 ), verified_by_database AS (
  SELECT database_id,max(verified_at) verified_at FROM rootset_control.backups WHERE state='succeeded' AND verified_at IS NOT NULL GROUP BY database_id
 ), recovery_stats AS (
  SELECT count(*) FILTER(WHERE b.verified_at IS NULL)::integer databases_without_verified_backup,
   greatest(0,extract(epoch FROM (statement_timestamp()-min(b.verified_at)))) oldest_database_verified_age_seconds
  FROM rootset_control.databases d LEFT JOIN verified_by_database b ON b.database_id=d.id WHERE d.state='active'
 ), email_stats AS (
  SELECT count(*) FILTER(WHERE state='pending')::integer pending,
   count(*) FILTER(WHERE state='sending')::integer sending,
   count(*) FILTER(WHERE state='failed')::integer failed,
   count(*) FILTER(WHERE state='pending' AND attempts>0)::integer retrying,
   greatest(0,extract(epoch FROM (statement_timestamp()-min(created_at) FILTER(WHERE state IN ('pending','sending'))))) oldest_pending_seconds
  FROM rootset_control.email_outbox
 ), schema_stats AS (
  SELECT count(*) FILTER(WHERE state NOT IN ('committed','failed','historical'))::integer pending,
   count(*) FILTER(WHERE state='failed')::integer failed FROM rootset_control.schema_operations
 ), index_stats AS (
  SELECT count(*) FILTER(WHERE state='building')::integer building,
   count(*) FILTER(WHERE state='failed')::integer failed FROM rootset_control.indexes
 ), native_stats AS (
  SELECT coalesce(sum(pg_table_size(c.oid)),0)::bigint data_bytes,
   coalesce(sum(pg_indexes_size(c.oid)),0)::bigint index_bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname ~ '^rsd_[a-z0-9]{26}$' AND c.relkind='r' AND c.relname ~ '^rst_[a-z0-9]{26}(_g[0-9]+)?$'
 ), invalid_index_stats AS (
  SELECT count(*)::integer invalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname ~ '^rsd_[a-z0-9]{26}$' AND NOT i.indisvalid
 ), table_stats AS (
  SELECT count(*) FILTER(WHERE state IN ('active','maintenance'))::integer active,
   count(*) FILTER(WHERE state='deleted')::integer retained,
   coalesce(sum(row_count) FILTER(WHERE state IN ('active','maintenance')),0)::bigint live_rows
  FROM rootset_control.tables
 ), history_stats AS (
  SELECT coalesce(sum(events),0)::bigint events,coalesce(sum(tuple_bytes),0)::bigint bytes FROM rootset_control.history_metrics
 ), artifact_stats AS (
  SELECT coalesce(sum(ciphertext_length),0)::bigint bytes FROM rootset_control.artifacts
  WHERE state NOT IN ('deleted','expired') AND (expires_at>statement_timestamp() OR purpose LIKE 'backup%')
 ), worker_stats AS (
  SELECT count(*) FILTER(WHERE state='ready' AND heartbeat_at>statement_timestamp()-interval '30 seconds')::integer fresh_ready,
   count(*) FILTER(WHERE heartbeat_at<=statement_timestamp()-interval '30 seconds')::integer stale,
   count(*) FILTER(WHERE state='degraded' AND heartbeat_at>statement_timestamp()-interval '30 seconds')::integer degraded
  FROM rootset_control.worker_heartbeats
 )
 SELECT jsonb_build_object(
  'databaseBytes',pg_database_size(current_database())::text,
  'temporaryBytes',coalesce(d.temp_bytes,0)::text,
  'temporaryFiles',coalesce(d.temp_files,0)::text,
  'walDirectoryBytes',(SELECT coalesce(sum(size),0)::text FROM pg_ls_waldir()),
  'walGeneratedBytes',trunc(w.wal_bytes)::text,
  'walRecords',w.wal_records::text,
  'transactionsCommitted',coalesce(d.xact_commit,0)::text,
  'transactionsRolledBack',coalesce(d.xact_rollback,0)::text,
  'deadlocks',coalesce(d.deadlocks,0)::text,
  'connections',jsonb_build_object('total',c.total,'active',c.active,'idle',c.idle,'idleInTransaction',c.idle_in_transaction,'maximum',current_setting('max_connections')::integer,'oldestTransactionSeconds',c.oldest_transaction_seconds),
  'jobs',jsonb_build_object('queued',j.queued,'running',j.running,'failed',j.failed,'expiredLeases',j.expired_leases,'oldestQueuedSeconds',j.oldest_queued_seconds,'retried',j.retried),
  'backups',jsonb_build_object('verified',b.verified,'failed',b.failed,'pendingNotifications',b.pending_notifications,'failedNotifications',b.failed_notifications,'lastVerifiedAt',b.last_verified_at,'oldestDatabaseVerifiedAgeSeconds',r.oldest_database_verified_age_seconds,'databasesWithoutVerifiedBackup',r.databases_without_verified_backup),
  'email',jsonb_build_object('pending',e.pending,'sending',e.sending,'failed',e.failed,'retrying',e.retrying,'oldestPendingSeconds',e.oldest_pending_seconds),
  'schema',jsonb_build_object('pending',s.pending,'failed',s.failed,'buildingIndexes',i.building,'failedIndexes',i.failed,'invalidIndexes',ix.invalid),
  'workers',jsonb_build_object('freshReady',h.fresh_ready,'stale',h.stale,'degraded',h.degraded),
  'storage',jsonb_build_object('activeDatabases',(SELECT count(*) FROM rootset_control.databases WHERE state='active'),'activeTables',t.active,'retainedTables',t.retained,'liveRows',t.live_rows::text,'dataBytes',n.data_bytes::text,'indexBytes',n.index_bytes::text,'historyEvents',a.events::text,'historyBytes',a.bytes::text,'artifactBytes',o.bytes::text),
  'statisticsResetAt',d.stats_reset,
  'walStatisticsResetAt',w.stats_reset
 ) FROM connection_stats c CROSS JOIN job_stats j CROSS JOIN backup_stats b CROSS JOIN recovery_stats r CROSS JOIN email_stats e CROSS JOIN schema_stats s CROSS JOIN index_stats i CROSS JOIN invalid_index_stats ix CROSS JOIN native_stats n CROSS JOIN table_stats t CROSS JOIN history_stats a CROSS JOIN artifact_stats o CROSS JOIN worker_stats h CROSS JOIN pg_stat_wal w LEFT JOIN database_stats d ON true
$$;
ALTER FUNCTION rootset_control.operator_metrics() OWNER TO rootset_metrics_definer;
REVOKE ALL ON FUNCTION rootset_control.operator_metrics() FROM PUBLIC,rootset_app,rootset_ddl,rootset_managed_owner;
GRANT EXECUTE ON FUNCTION rootset_control.operator_metrics() TO rootset_identity;
