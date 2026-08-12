-- Run with psql as a database owner against an ephemeral clone. Any unexpected
-- row or successful listener mutation aborts the release and leaves evidence pending.
BEGIN;
SET LOCAL ROLE nearyou_app;
SELECT set_config('app.household_id', 'hh_a', true), set_config('app.user_id', 'owner_a', true);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM nearyou.households WHERE id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant household leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.household_members WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant member leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.tenant_records WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant payload leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.mobile_entitlement_events WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant billing leak'; END IF;
  IF EXISTS (SELECT 1 FROM nearyou.durable_jobs WHERE household_id = 'hh_b') THEN RAISE EXCEPTION 'cross-tenant job leak'; END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE nearyou_app;
SELECT set_config('app.household_id', 'hh_a', true), set_config('app.user_id', 'listener_a', true);
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
ROLLBACK;
