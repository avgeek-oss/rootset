GRANT SELECT,INSERT,UPDATE,DELETE ON
 rootset_control.jobs,
 rootset_control.artifacts,
 rootset_control.import_rejections,
 rootset_control.import_batches,
 rootset_control.backup_policies,
 rootset_control.backups,
 rootset_control.restore_publications
TO rootset_app,rootset_ddl;
GRANT SELECT,INSERT,UPDATE,DELETE ON rootset_control.backup_occurrences TO rootset_ddl;

CREATE TABLE rootset_control.worker_heartbeats (
 id varchar(26) PRIMARY KEY,
 heartbeat_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL CHECK(state IN ('starting','ready','degraded','stopped')),
 last_error_code text,
 started_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON rootset_control.worker_heartbeats TO rootset_app;
GRANT SELECT,INSERT,UPDATE ON rootset_control.worker_heartbeats TO rootset_ddl;
