-- Run with psql as a database owner against an ephemeral clone. The fixtures and
-- assertions share one transaction and are always rolled back.
BEGIN;
INSERT INTO nearyou.households(id,owner_user_id,name,created_at,updated_at) VALUES
  ('hh_a','owner_a','RLS fixture A',now(),now()),('hh_b','owner_b','RLS fixture B',now(),now());
INSERT INTO nearyou.household_members(id,household_id,user_id,role,status,created_at,updated_at) VALUES
  ('member_owner_a','hh_a','owner_a','owner','active',now(),now()),
  ('member_listener_a','hh_a','listener_a','listener','active',now(),now()),
  ('member_owner_b','hh_b','owner_b','owner','active',now(),now());
INSERT INTO nearyou.tenant_records(household_id,source_table,source_id,payload,source_checksum,backfill_sequence) VALUES
  ('hh_a','rls_fixture','record_a','{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1),
  ('hh_b','rls_fixture','record_b','{}','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',2);
INSERT INTO nearyou.mobile_entitlement_events(event_id,household_id,app_id,environment,product_id,event_type,occurred_at,payload_checksum,processed_at) VALUES
  ('event_a','hh_a','app','PRODUCTION','product','INITIAL_PURCHASE',now(),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now()),
  ('event_b','hh_b','app','PRODUCTION','product','INITIAL_PURCHASE',now(),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',now());
INSERT INTO nearyou.durable_jobs(id,household_id,type,status,idempotency_key,payload,created_at,updated_at) VALUES
  ('job_a','hh_a','media_export','queued','fixture_a','{}',now(),now()),
  ('job_b','hh_b','media_export','queued','fixture_b','{}',now(),now());
SET LOCAL ROLE nearyou_app;
DO $$ BEGIN PERFORM set_config('app.household_id', 'hh_a', true); PERFORM set_config('app.user_id', 'owner_a', true); END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM nearyou.households WHERE id = 'hh_a') THEN RAISE EXCEPTION 'owner household positive control failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM nearyou.household_members WHERE household_id = 'hh_a' AND user_id='owner_a') THEN RAISE EXCEPTION 'owner member positive control failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM nearyou.tenant_records WHERE household_id = 'hh_a' AND source_id='record_a') THEN RAISE EXCEPTION 'owner payload positive control failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM nearyou.mobile_entitlement_events WHERE household_id = 'hh_a' AND event_id='event_a') THEN RAISE EXCEPTION 'owner billing positive control failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM nearyou.durable_jobs WHERE household_id = 'hh_a' AND id='job_a') THEN RAISE EXCEPTION 'owner job positive control failed'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.households WHERE id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant household leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.household_members WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant member leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.tenant_records WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant payload leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.mobile_entitlement_events WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant billing leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.durable_jobs WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant job leak'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE nearyou_app;
DO $$ BEGIN PERFORM set_config('app.household_id', 'hh_a', true); PERFORM set_config('app.user_id', 'listener_a', true); END $$;
DO $$ BEGIN
  BEGIN
    INSERT INTO nearyou.durable_jobs(id,household_id,type,status,idempotency_key,payload,created_at,updated_at)
    VALUES ('forbidden','hh_a','media_export','queued','forbidden','{}',now(),now());
    RAISE EXCEPTION 'listener job mutation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  BEGIN
    DELETE FROM nearyou.mobile_entitlement_events WHERE household_id = 'hh_a';
    RAISE EXCEPTION 'application billing mutation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT json_build_object('fixtureTenants',2,'positiveControls',5,'crossTenantChecks',5,'mutationDenials',2,'crossTenantViolations',0)::text;
ROLLBACK;
