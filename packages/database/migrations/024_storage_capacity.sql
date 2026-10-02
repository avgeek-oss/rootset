CREATE TABLE rootset_control.capacity_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 installation_quota_bytes bigint CHECK(installation_quota_bytes>=0),
 default_organisation_quota_bytes bigint CHECK(default_organisation_quota_bytes>=0),
 minimum_free_bytes bigint CHECK(minimum_free_bytes>=0),
 report_max_age_seconds integer NOT NULL DEFAULT 30 CHECK(report_max_age_seconds BETWEEN 5 AND 3600),
 headroom_claims_bytes bigint NOT NULL DEFAULT 0 CHECK(headroom_claims_bytes>=0),
 total_claimed_bytes bigint NOT NULL DEFAULT 0 CHECK(total_claimed_bytes>=0),
 report jsonb, reported_at timestamptz, reported_by text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO rootset_control.capacity_settings(singleton) VALUES(true);
CREATE TABLE rootset_control.capacity_organisation_quotas (
 org_id varchar(26) PRIMARY KEY REFERENCES rootset_control.organisations(id),
 quota_bytes bigint CHECK(quota_bytes>=0)
);
CREATE TABLE rootset_control.capacity_control_usage (
 org_id varchar(26) PRIMARY KEY REFERENCES rootset_control.organisations(id),
 tuple_bytes bigint NOT NULL DEFAULT 0 CHECK(tuple_bytes>=0)
);
CREATE TABLE rootset_control.capacity_reservations (
 transaction_id text NOT NULL, org_id varchar(26) NOT NULL,
 reserve_bytes bigint NOT NULL CHECK(reserve_bytes>=0),
 charged_bytes bigint NOT NULL DEFAULT 0,
 database_before_bytes bigint NOT NULL, organisation_before_bytes bigint NOT NULL,
 operation text NOT NULL, PRIMARY KEY(transaction_id,org_id)
);
REVOKE ALL ON rootset_control.capacity_settings,rootset_control.capacity_organisation_quotas,rootset_control.capacity_control_usage,rootset_control.capacity_reservations FROM PUBLIC;

CREATE FUNCTION rootset_control.capacity_lock() RETURNS void LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('rootset:storage-capacity',0))
$$;
CREATE FUNCTION rootset_control.capacity_org_usage(org_arg varchar) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN rootset_control.databases d ON d.schema_name=n.nspname WHERE d.org_id=org_arg AND c.relkind IN ('r','m')),0)::bigint + coalesce((SELECT tuple_bytes FROM rootset_control.capacity_control_usage WHERE org_id=org_arg),0)
$$;
CREATE FUNCTION rootset_control.capacity_configuration() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('installationQuotaBytes',installation_quota_bytes::text,'defaultOrganisationQuotaBytes',default_organisation_quota_bytes::text,'minimumFreeBytes',minimum_free_bytes::text,'reportMaxAgeSeconds',report_max_age_seconds,'organisationOverrides',coalesce((SELECT jsonb_agg(jsonb_build_object('orgId',org_id,'quotaBytes',quota_bytes::text) ORDER BY org_id) FROM rootset_control.capacity_organisation_quotas),'[]'::jsonb)) FROM rootset_control.capacity_settings WHERE singleton
$$;
CREATE FUNCTION rootset_control.configure_capacity(input_arg jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item jsonb;
BEGIN
 PERFORM rootset_control.capacity_lock();
 UPDATE rootset_control.capacity_settings SET installation_quota_bytes=(input_arg->>'installationQuotaBytes')::bigint,default_organisation_quota_bytes=(input_arg->>'defaultOrganisationQuotaBytes')::bigint,minimum_free_bytes=(input_arg->>'minimumFreeBytes')::bigint,report_max_age_seconds=(input_arg->>'reportMaxAgeSeconds')::integer,updated_at=now() WHERE singleton;
 DELETE FROM rootset_control.capacity_organisation_quotas;
 FOR item IN SELECT value FROM jsonb_array_elements(input_arg->'organisationOverrides') LOOP
  INSERT INTO rootset_control.capacity_organisation_quotas(org_id,quota_bytes) VALUES(item->>'orgId',(item->>'quotaBytes')::bigint);
 END LOOP;
END $$;

CREATE FUNCTION rootset_control.capacity_storage_paths() RETURNS TABLE(name text,path text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT 'data' AS name,current_setting('data_directory') AS path UNION ALL SELECT 'wal',current_setting('data_directory')||'/pg_wal' UNION ALL SELECT 'tablespace:'||spcname,pg_tablespace_location(oid) FROM pg_tablespace WHERE pg_tablespace_location(oid)<>'' ORDER BY name
$$;
CREATE FUNCTION rootset_control.capacity_report_checkpoint() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM rootset_control.capacity_lock();
 RETURN (SELECT jsonb_build_object('claimsBytes',total_claimed_bytes::text,'capturedAt',clock_timestamp()) FROM rootset_control.capacity_settings WHERE singleton);
END $$;
CREATE FUNCTION rootset_control.report_storage_capacity(volumes_arg jsonb,checkpoint_arg jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE required record; metric jsonb; available_arg bigint; total_arg bigint; claims_arg bigint; captured_arg timestamptz; settings rootset_control.capacity_settings%ROWTYPE;
BEGIN
 IF jsonb_typeof(volumes_arg)<>'array' OR jsonb_array_length(volumes_arg)>100 THEN RAISE EXCEPTION 'invalid PostgreSQL filesystem report' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(volumes_arg) GROUP BY value->>'name' HAVING count(*)<>1) THEN RAISE EXCEPTION 'duplicate filesystem volume' USING ERRCODE='22023'; END IF;
 FOR required IN SELECT * FROM rootset_control.capacity_storage_paths() LOOP
  SELECT value INTO metric FROM jsonb_array_elements(volumes_arg) WHERE value->>'name'=required.name;
  IF metric IS NULL OR jsonb_typeof(metric->'availableBytes')<>'string' OR jsonb_typeof(metric->'totalBytes')<>'string' OR metric->>'availableBytes' !~ '^(0|[1-9][0-9]*)$' OR metric->>'totalBytes' !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'missing or invalid PostgreSQL filesystem volume' USING ERRCODE='22023'; END IF;
  available_arg:=(metric->>'availableBytes')::bigint; total_arg:=(metric->>'totalBytes')::bigint;
  IF available_arg>total_arg THEN RAISE EXCEPTION 'available bytes exceed volume size' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF jsonb_array_length(volumes_arg)<>(SELECT count(*) FROM rootset_control.capacity_storage_paths()) THEN RAISE EXCEPTION 'unexpected filesystem volume' USING ERRCODE='22023'; END IF;
 PERFORM rootset_control.capacity_lock();
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 claims_arg:=(checkpoint_arg->>'claimsBytes')::bigint; captured_arg:=(checkpoint_arg->>'capturedAt')::timestamptz;
 IF claims_arg IS NULL OR claims_arg<0 OR claims_arg>settings.total_claimed_bytes OR captured_arg IS NULL OR captured_arg>clock_timestamp() OR captured_arg+make_interval(secs=>settings.report_max_age_seconds)<=clock_timestamp() THEN RAISE EXCEPTION 'invalid or stale filesystem report checkpoint' USING ERRCODE='22023'; END IF;
 UPDATE rootset_control.capacity_settings SET report=volumes_arg,reported_at=captured_arg,reported_by=session_user,headroom_claims_bytes=total_claimed_bytes-claims_arg WHERE singleton;
END $$;

CREATE FUNCTION rootset_control.capacity_status(org_arg varchar DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; db_bytes bigint; org_bytes bigint; native_bytes bigint; control_bytes bigint; org_quota bigint; disk_available bigint; disk_total bigint; effective_available bigint; fresh_arg boolean; enabled_arg boolean; state_arg text:='available'; reason_arg text;
BEGIN
 IF org_arg IS NOT NULL AND org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 db_bytes:=pg_database_size(current_database());
 IF org_arg IS NOT NULL THEN
  org_bytes:=rootset_control.capacity_org_usage(org_arg);
  control_bytes:=coalesce((SELECT tuple_bytes FROM rootset_control.capacity_control_usage WHERE org_id=org_arg),0);
  native_bytes:=org_bytes-control_bytes;
  SELECT quota_bytes INTO org_quota FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
  IF NOT FOUND THEN org_quota:=settings.default_organisation_quota_bytes; END IF;
 END IF;
 SELECT min((value->>'availableBytes')::bigint),min((value->>'totalBytes')::bigint) INTO disk_available,disk_total FROM jsonb_array_elements(settings.report);
 effective_available:=greatest(0,disk_available-settings.headroom_claims_bytes);
 fresh_arg:=settings.reported_at IS NOT NULL AND settings.reported_at+make_interval(secs=>settings.report_max_age_seconds)>clock_timestamp();
 enabled_arg:=settings.installation_quota_bytes IS NOT NULL OR org_quota IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL OR org_arg IS NULL AND (settings.default_organisation_quota_bytes IS NOT NULL OR EXISTS(SELECT 1 FROM rootset_control.capacity_organisation_quotas WHERE quota_bytes IS NOT NULL));
 IF settings.installation_quota_bytes IS NOT NULL AND db_bytes>=settings.installation_quota_bytes OR org_quota IS NOT NULL AND org_bytes>=org_quota THEN state_arg:='quota_exceeded'; reason_arg:='Storage usage has reached its configured quota; increase the quota or run approved retention/cleanup.';
 ELSIF settings.minimum_free_bytes IS NOT NULL AND NOT fresh_arg THEN state_arg:='report_stale'; reason_arg:='Run the capacity reporter on the PostgreSQL host; admission is paused until a fresh filesystem measurement arrives.';
 ELSIF settings.minimum_free_bytes IS NOT NULL AND effective_available<=settings.minimum_free_bytes THEN state_arg:='disk_pressure'; reason_arg:='PostgreSQL filesystem headroom is below its configured operational minimum; grow storage or run approved maintenance.';
 END IF;
 RETURN jsonb_build_object('installation',jsonb_build_object('usedBytes',db_bytes::text,'quotaBytes',settings.installation_quota_bytes::text,'availableQuotaBytes',CASE WHEN settings.installation_quota_bytes IS NULL THEN NULL ELSE greatest(0,settings.installation_quota_bytes-db_bytes)::text END,'metric','postgresql_database_bytes'),'organisation',CASE WHEN org_arg IS NULL THEN NULL ELSE jsonb_build_object('orgId',org_arg,'nativeRelationBytes',native_bytes::text,'retainedControlTupleBytes',control_bytes::text,'usedBytes',org_bytes::text,'quotaBytes',org_quota::text,'availableQuotaBytes',CASE WHEN org_quota IS NULL THEN NULL ELSE greatest(0,org_quota-org_bytes)::text END,'metric','native_relation_and_retained_control_tuple_bytes') END,'disk',jsonb_build_object('minimumFreeBytes',settings.minimum_free_bytes::text,'reportedAvailableBytes',disk_available::text,'reportedTotalBytes',disk_total::text,'headroomClaimsBytes',settings.headroom_claims_bytes::text,'effectiveAvailableBytes',CASE WHEN disk_available IS NULL THEN NULL ELSE effective_available::text END,'reportedAt',settings.reported_at,'reportMaxAgeSeconds',settings.report_max_age_seconds,'fresh',fresh_arg,'volumes',coalesce(settings.report,'[]'::jsonb)),'admission',jsonb_build_object('enabled',enabled_arg,'state',state_arg,'reason',reason_arg));
END $$;

CREATE FUNCTION rootset_control.begin_capacity_admission(org_arg varchar,reserve_arg bigint,operation_arg text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint; db_arg bigint; org_usage_arg bigint; disk_arg bigint; total_reserved bigint; existing rootset_control.capacity_reservations%ROWTYPE; tx_arg text:=pg_current_xact_id()::text; enabled_arg boolean;
BEGIN
 IF org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 IF reserve_arg<0 OR length(operation_arg) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'invalid capacity reservation' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 enabled_arg:=settings.installation_quota_bytes IS NOT NULL OR quota_arg IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL;
 IF NOT enabled_arg THEN RETURN jsonb_build_object('orgId',org_arg,'transactionId',tx_arg,'enabled',false,'reserveBytes',reserve_arg::text); END IF;
 PERFORM rootset_control.capacity_lock();
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton FOR UPDATE;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 SELECT * INTO existing FROM rootset_control.capacity_reservations WHERE transaction_id=tx_arg AND org_id=org_arg;
 total_reserved:=coalesce(existing.reserve_bytes,0)+reserve_arg;
 db_arg:=pg_database_size(current_database()); org_usage_arg:=rootset_control.capacity_org_usage(org_arg);
 IF settings.installation_quota_bytes IS NOT NULL AND coalesce(existing.database_before_bytes,db_arg)+total_reserved>settings.installation_quota_bytes OR quota_arg IS NOT NULL AND coalesce(existing.organisation_before_bytes,org_usage_arg)+total_reserved>quota_arg THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_QUOTA_EXCEEDED' USING DETAIL=jsonb_build_object('installationUsedBytes',db_arg::text,'organisationUsedBytes',org_usage_arg::text,'requestedBytes',total_reserved::text,'operation',operation_arg)::text; END IF;
 IF settings.minimum_free_bytes IS NOT NULL THEN
  IF settings.reported_at IS NULL OR settings.reported_at+make_interval(secs=>settings.report_max_age_seconds)<=clock_timestamp() THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_REPORT_STALE' USING DETAIL=jsonb_build_object('maximumAgeSeconds',settings.report_max_age_seconds)::text; END IF;
  SELECT min((value->>'availableBytes')::bigint) INTO disk_arg FROM jsonb_array_elements(settings.report);
  IF disk_arg-settings.headroom_claims_bytes-(total_reserved-coalesce(existing.charged_bytes,0))<settings.minimum_free_bytes THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_DISK_PRESSURE' USING DETAIL=jsonb_build_object('availableBytes',disk_arg::text,'claimedBytes',settings.headroom_claims_bytes::text,'requestedBytes',total_reserved::text,'minimumFreeBytes',settings.minimum_free_bytes::text)::text; END IF;
 END IF;
 INSERT INTO rootset_control.capacity_reservations(transaction_id,org_id,reserve_bytes,database_before_bytes,organisation_before_bytes,operation) VALUES(tx_arg,org_arg,reserve_arg,db_arg,org_usage_arg,operation_arg) ON CONFLICT(transaction_id,org_id) DO UPDATE SET reserve_bytes=total_reserved;
 RETURN jsonb_build_object('orgId',org_arg,'transactionId',tx_arg,'enabled',true,'reserveBytes',total_reserved::text,'databaseBeforeBytes',coalesce(existing.database_before_bytes,db_arg)::text,'organisationBeforeBytes',coalesce(existing.organisation_before_bytes,org_usage_arg)::text);
END $$;
CREATE FUNCTION rootset_control.validate_capacity_allocation(org_arg varchar,database_before_arg bigint,organisation_before_arg bigint,reserve_arg bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint; db_arg bigint; org_usage_arg bigint; growth_arg bigint;
BEGIN
 IF org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 IF database_before_arg<0 OR organisation_before_arg<0 OR reserve_arg<0 THEN RAISE EXCEPTION 'invalid capacity snapshot' USING ERRCODE='22023'; END IF;
 PERFORM rootset_control.capacity_lock();
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 db_arg:=pg_database_size(current_database()); org_usage_arg:=rootset_control.capacity_org_usage(org_arg);
 growth_arg:=greatest(0,db_arg-database_before_arg,org_usage_arg-organisation_before_arg);
 IF growth_arg>reserve_arg THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_RESERVATION_EXCEEDED' USING DETAIL=jsonb_build_object('reservedBytes',reserve_arg::text,'actualGrowthBytes',growth_arg::text)::text; END IF;
 IF settings.installation_quota_bytes IS NOT NULL AND db_arg>settings.installation_quota_bytes OR quota_arg IS NOT NULL AND org_usage_arg>quota_arg THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_QUOTA_EXCEEDED' USING DETAIL=jsonb_build_object('installationUsedBytes',db_arg::text,'organisationUsedBytes',org_usage_arg::text)::text; END IF;
END $$;
CREATE FUNCTION rootset_control.finish_capacity_admission(org_arg varchar,transaction_arg text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE reservation rootset_control.capacity_reservations%ROWTYPE; settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint; db_arg bigint; org_usage_arg bigint; growth_arg bigint;
BEGIN
 IF org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') OR transaction_arg<>pg_current_xact_id()::text THEN RAISE EXCEPTION 'organisation transaction context required' USING ERRCODE='42501'; END IF;
 PERFORM rootset_control.capacity_lock();
 SELECT * INTO reservation FROM rootset_control.capacity_reservations WHERE transaction_id=transaction_arg AND org_id=org_arg;
 IF NOT FOUND THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_RESERVATION_REQUIRED'; END IF;
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 db_arg:=pg_database_size(current_database()); org_usage_arg:=rootset_control.capacity_org_usage(org_arg);
 growth_arg:=greatest(0,db_arg-reservation.database_before_bytes,org_usage_arg-reservation.organisation_before_bytes);
 IF growth_arg>reservation.reserve_bytes THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_RESERVATION_EXCEEDED' USING DETAIL=jsonb_build_object('reservedBytes',reservation.reserve_bytes::text,'actualGrowthBytes',growth_arg::text)::text; END IF;
 IF settings.installation_quota_bytes IS NOT NULL AND db_arg>settings.installation_quota_bytes OR quota_arg IS NOT NULL AND org_usage_arg>quota_arg THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_QUOTA_EXCEEDED' USING DETAIL=jsonb_build_object('installationUsedBytes',db_arg::text,'organisationUsedBytes',org_usage_arg::text)::text; END IF;
 UPDATE rootset_control.capacity_settings SET headroom_claims_bytes=headroom_claims_bytes+(reservation.reserve_bytes-reservation.charged_bytes),total_claimed_bytes=total_claimed_bytes+(reservation.reserve_bytes-reservation.charged_bytes) WHERE singleton;
 UPDATE rootset_control.capacity_reservations SET charged_bytes=reserve_bytes WHERE transaction_id=transaction_arg AND org_id=org_arg;
END $$;
CREATE FUNCTION rootset_control.commit_capacity_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original_org text:=current_setting('rootset.org_id',true);
BEGIN
 IF EXISTS(SELECT 1 FROM rootset_control.capacity_reservations WHERE transaction_id=NEW.transaction_id AND org_id=NEW.org_id) THEN
  PERFORM set_config('rootset.org_id',NEW.org_id,true);
  PERFORM rootset_control.finish_capacity_admission(NEW.org_id,NEW.transaction_id);
  DELETE FROM rootset_control.capacity_reservations WHERE transaction_id=NEW.transaction_id AND org_id=NEW.org_id;
  PERFORM set_config('rootset.org_id',coalesce(original_org,''),true);
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rootset_capacity_commit AFTER INSERT ON rootset_control.capacity_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rootset_control.commit_capacity_admission();
CREATE FUNCTION rootset_control.enforce_capacity_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint; org_arg varchar:=TG_ARGV[0];
BEGIN
 IF org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 IF settings.installation_quota_bytes IS NOT NULL OR quota_arg IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM rootset_control.capacity_reservations WHERE transaction_id=pg_current_xact_id()::text AND org_id=org_arg) THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_RESERVATION_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION rootset_control.track_capacity_control_usage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_org varchar; new_org varchar; old_bytes bigint:=0; new_bytes bigint:=0; settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN old_bytes:=pg_column_size(to_jsonb(OLD)); old_org:=to_jsonb(OLD)->>'org_id'; IF old_org IS NULL THEN SELECT org_id INTO old_org FROM rootset_control.unique_rules WHERE id=(to_jsonb(OLD)->>'rule_id'); END IF; END IF;
 IF TG_OP<>'DELETE' THEN new_bytes:=pg_column_size(to_jsonb(NEW)); new_org:=to_jsonb(NEW)->>'org_id'; IF new_org IS NULL THEN SELECT org_id INTO new_org FROM rootset_control.unique_rules WHERE id=(to_jsonb(NEW)->>'rule_id'); END IF; END IF;
 IF new_org IS NOT NULL AND new_bytes>old_bytes THEN
  SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
  SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=new_org;
  IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
  IF settings.installation_quota_bytes IS NOT NULL OR quota_arg IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM rootset_control.capacity_reservations WHERE transaction_id=pg_current_xact_id()::text AND org_id=new_org) THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_RESERVATION_REQUIRED'; END IF;
  END IF;
 END IF;
 IF old_org IS NOT NULL THEN INSERT INTO rootset_control.capacity_control_usage(org_id,tuple_bytes) VALUES(old_org,0) ON CONFLICT DO NOTHING; UPDATE rootset_control.capacity_control_usage SET tuple_bytes=greatest(0,tuple_bytes-old_bytes) WHERE org_id=old_org; END IF;
 IF new_org IS NOT NULL THEN INSERT INTO rootset_control.capacity_control_usage(org_id,tuple_bytes) VALUES(new_org,new_bytes) ON CONFLICT(org_id) DO UPDATE SET tuple_bytes=rootset_control.capacity_control_usage.tuple_bytes+EXCLUDED.tuple_bytes; END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE name_arg text; relation record; BEGIN
 FOREACH name_arg IN ARRAY ARRAY['databases','tables','fields','unique_rules','indexes','schema_operations','mutations','cell_changes','row_events','resource_history','history_gaps'] LOOP
  EXECUTE format('INSERT INTO rootset_control.capacity_control_usage(org_id,tuple_bytes) SELECT org_id,sum(pg_column_size(to_jsonb(t))) FROM rootset_control.%I t GROUP BY org_id ON CONFLICT(org_id) DO UPDATE SET tuple_bytes=rootset_control.capacity_control_usage.tuple_bytes+EXCLUDED.tuple_bytes',name_arg);
  EXECUTE format('CREATE TRIGGER rootset_capacity_usage AFTER INSERT OR UPDATE OR DELETE ON rootset_control.%I FOR EACH ROW EXECUTE FUNCTION rootset_control.track_capacity_control_usage()',name_arg);
 END LOOP;
 FOREACH name_arg IN ARRAY ARRAY['unique_entries','unique_buckets'] LOOP
  EXECUTE format('INSERT INTO rootset_control.capacity_control_usage(org_id,tuple_bytes) SELECT r.org_id,sum(pg_column_size(to_jsonb(t))) FROM rootset_control.%I t JOIN rootset_control.unique_rules r ON r.id=t.rule_id GROUP BY r.org_id ON CONFLICT(org_id) DO UPDATE SET tuple_bytes=rootset_control.capacity_control_usage.tuple_bytes+EXCLUDED.tuple_bytes',name_arg);
  EXECUTE format('CREATE TRIGGER rootset_capacity_usage AFTER INSERT OR UPDATE OR DELETE ON rootset_control.%I FOR EACH ROW EXECUTE FUNCTION rootset_control.track_capacity_control_usage()',name_arg);
 END LOOP;
 FOR relation IN SELECT n.nspname,c.relname,d.org_id FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN rootset_control.databases d ON d.schema_name=n.nspname WHERE c.relkind='r' AND c.relname ~ '^rst_[a-z0-9]{26}(_g[0-9]+)?$' LOOP
  EXECUTE format('CREATE TRIGGER rootset_capacity_guard BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION rootset_control.enforce_capacity_admission(%L)',relation.nspname,relation.relname,relation.org_id);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION rootset_control.capacity_lock(),rootset_control.capacity_org_usage(varchar),rootset_control.capacity_configuration(),rootset_control.configure_capacity(jsonb),rootset_control.capacity_storage_paths(),rootset_control.capacity_report_checkpoint(),rootset_control.report_storage_capacity(jsonb,jsonb),rootset_control.capacity_status(varchar),rootset_control.begin_capacity_admission(varchar,bigint,text),rootset_control.finish_capacity_admission(varchar,text),rootset_control.validate_capacity_allocation(varchar,bigint,bigint,bigint),rootset_control.commit_capacity_admission(),rootset_control.enforce_capacity_admission(),rootset_control.track_capacity_control_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.capacity_configuration(),rootset_control.configure_capacity(jsonb),rootset_control.capacity_status(varchar) TO rootset_identity;
GRANT EXECUTE ON FUNCTION rootset_control.begin_capacity_admission(varchar,bigint,text),rootset_control.finish_capacity_admission(varchar,text) TO rootset_app,rootset_ddl;
GRANT EXECUTE ON FUNCTION rootset_control.validate_capacity_allocation(varchar,bigint,bigint,bigint),rootset_control.enforce_capacity_admission() TO rootset_ddl;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rootset_capacity_reporter') THEN
  GRANT USAGE ON SCHEMA rootset_control TO rootset_capacity_reporter;
  GRANT EXECUTE ON FUNCTION rootset_control.capacity_storage_paths(),rootset_control.capacity_report_checkpoint(),rootset_control.report_storage_capacity(jsonb,jsonb) TO rootset_capacity_reporter;
 END IF;
END $$;
