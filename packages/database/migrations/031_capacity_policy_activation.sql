-- Capacity acquisition must never wait with a statement snapshot: concurrent
-- index builds wait for old snapshots before publishing their index.
CREATE OR REPLACE FUNCTION rootset_control.capacity_lock() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('rootset:storage-capacity',0)) THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_ADMISSION_BUSY'; END IF;
END $$;
CREATE FUNCTION rootset_control.capacity_admission_enabled(org_arg varchar) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint;
BEGIN
 IF org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 RETURN settings.installation_quota_bytes IS NOT NULL OR quota_arg IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL;
END $$;
CREATE FUNCTION rootset_control.capacity_policy_fence(org_arg varchar) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint;
BEGIN
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 IF settings.installation_quota_bytes IS NULL AND quota_arg IS NULL AND settings.minimum_free_bytes IS NULL THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('rootset:storage-capacity',0)) THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_ADMISSION_BUSY'; END IF;
  SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
  SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
  IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
  IF settings.installation_quota_bytes IS NOT NULL OR quota_arg IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_POLICY_CHANGED'; END IF;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION rootset_control.begin_capacity_admission(org_arg varchar,reserve_arg bigint,operation_arg text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint; db_arg bigint; org_usage_arg bigint; disk_arg bigint; total_reserved bigint; existing rootset_control.capacity_reservations%ROWTYPE; tx_arg text:=pg_current_xact_id()::text; enabled_arg boolean;
BEGIN
 IF org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 IF reserve_arg<0 OR length(operation_arg) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'invalid capacity reservation' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 enabled_arg:=settings.installation_quota_bytes IS NOT NULL OR quota_arg IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL;
 IF NOT enabled_arg THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('rootset:storage-capacity',0)) THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_ADMISSION_BUSY'; END IF;
  IF rootset_control.capacity_admission_enabled(org_arg) THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_POLICY_CHANGED'; END IF;
  RETURN jsonb_build_object('orgId',org_arg,'transactionId',tx_arg,'enabled',false,'reserveBytes',reserve_arg::text); END IF;
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
CREATE OR REPLACE FUNCTION rootset_control.enforce_capacity_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint; org_arg varchar:=TG_ARGV[0];
BEGIN
 IF org_arg IS DISTINCT FROM nullif(current_setting('rootset.org_id',true),'') THEN RAISE EXCEPTION 'organisation context required' USING ERRCODE='42501'; END IF;
 PERFORM rootset_control.capacity_policy_fence(org_arg);
 SELECT * INTO STRICT settings FROM rootset_control.capacity_settings WHERE singleton;
 SELECT quota_bytes INTO quota_arg FROM rootset_control.capacity_organisation_quotas WHERE org_id=org_arg;
 IF NOT FOUND THEN quota_arg:=settings.default_organisation_quota_bytes; END IF;
 IF settings.installation_quota_bytes IS NOT NULL OR quota_arg IS NOT NULL OR settings.minimum_free_bytes IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM rootset_control.capacity_reservations WHERE transaction_id=pg_current_xact_id()::text AND org_id=org_arg) THEN RAISE EXCEPTION 'ROOTSET_CAPACITY:STORAGE_RESERVATION_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION rootset_control.track_capacity_control_usage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE old_org varchar; new_org varchar; old_bytes bigint:=0; new_bytes bigint:=0; settings rootset_control.capacity_settings%ROWTYPE; quota_arg bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN old_bytes:=pg_column_size(to_jsonb(OLD)); old_org:=to_jsonb(OLD)->>'org_id'; IF old_org IS NULL THEN SELECT org_id INTO old_org FROM rootset_control.unique_rules WHERE id=(to_jsonb(OLD)->>'rule_id'); END IF; END IF;
 IF TG_OP<>'DELETE' THEN new_bytes:=pg_column_size(to_jsonb(NEW)); new_org:=to_jsonb(NEW)->>'org_id'; IF new_org IS NULL THEN SELECT org_id INTO new_org FROM rootset_control.unique_rules WHERE id=(to_jsonb(NEW)->>'rule_id'); END IF; END IF;
 IF new_org IS NOT NULL AND new_bytes>old_bytes THEN
  PERFORM rootset_control.capacity_policy_fence(new_org);
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
REVOKE ALL ON FUNCTION rootset_control.capacity_admission_enabled(varchar),rootset_control.capacity_policy_fence(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rootset_control.capacity_admission_enabled(varchar) TO rootset_app,rootset_ddl;
DO $$ DECLARE owner_arg name; BEGIN
 SELECT r.rolname INTO STRICT owner_arg FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='rootset_control' AND p.proname='capacity_configuration';
 EXECUTE format('ALTER FUNCTION rootset_control.capacity_admission_enabled(varchar) OWNER TO %I',owner_arg);
 EXECUTE format('ALTER FUNCTION rootset_control.capacity_policy_fence(varchar) OWNER TO %I',owner_arg);
END $$;
ALTER FUNCTION rootset_control.begin_capacity_admission(varchar,bigint,text) SET timezone='UTC';
ALTER FUNCTION rootset_control.enforce_capacity_admission() SET timezone='UTC';
